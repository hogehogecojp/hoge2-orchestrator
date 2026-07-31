// 初回セットアップ充足判定（doctor）。
//
// 単一の setupCompleted フラグは持たず、要件チェックリストを「実状態」から毎回計算して返す
// （手編集・再インストールでフラグと実態がズレないようにするため。isVkAgentsSetup と同じ思想）。
//
// 検知ロジックはここ（コード側）に単一ソースで持ち、SKILL.md（会話セットアップ）と
// bin の up 案内は、この doctor の結果を読むだけにする。
//
// doctor はローカル高速判定に限定し、ネットワーク検知（ラベル存在確認など）はしない。
// gh 認証だけは `gh auth token`（execFileSync 注入可）で確認する。
//
// required は固定値ではなく、選択中のモードから計算する。モードは 2 軸ある:
//
// 1) キューの保存先（queue.backend）
//   - GitHub モード: gh 認証 / github.owner / github.repo / orchestrator.assigneeFilter /
//                    org.allowed_owners(owner を含む) を required にする。
//   - ローカルモード: それらは任意。必須は Node / プラットフォーム / 実行面モードの前提 /
//                    Claude Code コマンド / vk-agents 展開 / queue.backend / org.allowed_owners。
//
// 2) 実行面モード（terminals.mode）
//   - vk-terminals モード: VK Terminals 導入を required にする（GUI 前提。platform の
//                          label / hint も GUI 前提の文言）。tmux 要件は出さない。
//   - tmux モード: GUI を一切起動しないので VK Terminals 導入は任意（required: false）。
//                  代わりに tmux コマンドの導入を required にし、platform は GUI 非依存の
//                  文言（コンテナ環境でも可）に差し替える。
//
// さらに vk-terminals モードでは、VK Terminals API の接続先（apiHost）が手元のマシンか
// どうかで Claude Code 要件の required が変わる。接続先が別マシンならペインはそのマシンで
// 開くので、手元に claude が無くてもタスクは進む（required: false ＝ ⚠️）。手元を指している
// とき（ループバックのほか、自マシンのアドレスを書いている場合を含む）は従来どおり必須。
// 判定は engine と同じ isLocalMachineHost() に寄せ、判断できない値は必須側へ倒す。
// tmux モードは常に手元で claude を起動するため、接続先の設定に関わらず required: true。

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { execFileSync as realExecFileSync } from 'child_process';
import {
  resolveConfigPath,
  loadUnifiedConfig,
  getQueueBackend,
  resolveVkTerminalsDir as realResolveVkTerminalsDir,
  resolveVkTerminalsApiHost as realResolveVkTerminalsApiHost,
  resolveTerminalsMode,
  resolveTmuxClaudeCommand,
  isVkAgentsSetup,
  vkAgentsSkillsManifestPath,
  resolveVkAgentsCanonicalConfigPath,
  getGitHubTokenFromGh,
  readVendoredVkAgentsVersion,
  readVkAgentsManifestSource,
} from './config.js';
// 制御文字の除去は build-command.js の stripControlChars に集約している（DRY）。
// terminals/index.js と同じ出所を使い、文字クラスを 3 箇所目に複製しない。
//
// 案内文へコマンド行として値を埋めてよいかの判定（isShellSafeCommandForDisplay）と、
// 表示値から ANSI・制御文字・U+2028/U+2029 を落とす stripAnsiAndControlChars も同じ出所から
// 使う。doctor の hint（tmux.claudeCommand）と `up` の tmux attach 案内（tmux.session）が
// 同じ穴・同じ表示経路を持っていたため、判定も除去の線引きも doctor 側に閉じ込めず
// 共有する（issue #253）。
import {
  stripControlChars,
  stripAnsiAndControlChars,
  isShellSafeCommandForDisplay,
} from './engine/build-command.js';
// 「接続先が手元のマシンか」の判定は engine（resolveTaskPaneCwd）と同じ実装を使う。
// 同じ apiHost を engine は「自分のマシン」、doctor は「別マシン」と読む状態を作らない。
// os にしか依存しない小さなモジュールなので doctor から直接使える。
import { isLocalMachineHost, normalizeHostForLocalComparison } from './engine/local-machine-host.js';
import { evaluateAgentsVersionState } from './engine/agents-redeploy.js';
import { formatAgentsVersionRequirement } from './engine/update-messages.js';

const DEFAULT_OWNER = 'vektor-inc';
const DEFAULT_REPO = 'task-queue';
// ペイン起動に使う既定の Claude Code コマンド（config.js の resolveTmuxClaudeCommand の既定と同じ）。
const DEFAULT_CLAUDE_COMMAND = 'claude';
// Claude Code のインストール手順。要件の hint とレポート末尾の両方で使うため 1 か所に持つ
// （文言が枝分かれすると、サポート時に別々の手順として扱われてしまう）。
export const CLAUDE_INSTALL_COMMAND = '`npm install -g @anthropic-ai/claude-code`';

function getPath(obj, path) {
  return path.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

function hasNonEmpty(obj, path) {
  const value = getPath(obj, path);
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/**
 * vk-agents 正本 config（保存先 C）から org.allowed_owners を読み出す。
 * 読めない・未設定なら空配列を返す（ok 判定は false 側に倒れる）。
 * @param {string} canonicalConfigPath
 * @returns {string[]}
 */
function readAllowedOwners(canonicalConfigPath) {
  if (!canonicalConfigPath || !existsSync(canonicalConfigPath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(canonicalConfigPath, 'utf8'));
  } catch {
    return [];
  }
  const list = parsed?.org?.allowed_owners;
  if (!Array.isArray(list)) return [];
  return list.map((item) => String(item ?? '').trim()).filter((item) => item !== '');
}

/**
 * 外部コマンドの出力を、レポート／--json に載せても安全な 1 行の値へ整える。
 *
 * 先頭行のみ・ANSI エスケープと制御文字を除去・長さを制限する。改行入りの値をそのまま
 * 載せるとレポートの行構造が崩れ、偽の ✅/❌ 行を混ぜ込めてしまうため
 * （利用者は「必須項目が充足している」と誤読しうる）。
 *
 * **設定ファイル由来の値には使わない**（sanitizeConfigDisplayValue を使う）。想定値が
 * "tmux 3.4" 程度のコマンド出力と違い、設定値は許可オーナー一覧のように長くなるのが
 * 正常なので、64 文字で切ると「自分が設定した値が見えない」という別の混乱を生む。
 * @param {*} value 外部コマンドの出力
 * @returns {string} 表示に使える 1 行の値（空なら空文字）
 */
function sanitizeReportValue(value) {
  return stripAnsiAndControlChars(String(value ?? '').split('\n')[0])
    .trim()
    .slice(0, 64);
}

/**
 * 設定ファイル由来の値を、レポート／--json に載せても安全な形へ整える（表示専用）。
 *
 * 改行や制御文字入りの設定値をそのまま載せると、レポートの行構造が崩れて
 * 「✅ ○○（必須） … 充足」のような**存在しない行**を混ぜ込めてしまい、読んだ人が
 * 「必須項目は足りている」と誤読しうる。それを防ぐのがこの関数の役割（issue #248）。
 *
 * sanitizeReportValue と違い、**先頭行で切らず・長さも制限しない**。許可オーナー一覧
 * （org.allowed_owners）のように項目数が多くなる値を途中で切ると、「自分のオーナー名が
 * 入っているのに見えない」という別の混乱になるため。改行は除去して 1 行にまとめる。
 *
 * **合否（ok）の判定には絶対に使わない。** 例えば "vek\ntor-inc" は除去後に "vektor-inc"
 * になるため、この値で allowed_owners との一致を見ると許可ゲートが通ってしまう
 * （fail-open）。比較は生の値のまま行い、この関数は表示だけに使う。
 *
 * 呼び出しは toDisplayValue に集約する（加工したことを利用者へ伝える注記の付与まで含めて
 * 1 か所で扱うため。issue #252）。
 * @param {*} value 設定ファイルから読んだ値
 * @returns {string} 表示に使える値（空なら空文字）
 */
function sanitizeConfigDisplayValue(value) {
  return stripAnsiAndControlChars(value).trim();
}

/**
 * 表示のために値を加工したときに添える注記（issue #252）。基本は current の末尾に置き、
 * その行で加工されたのが label 側の値なら label の末尾に置く（指し示す先を間違えないため）。
 *
 * #248 で表示値のサニタイズは入ったが、加工したことが一切伝わらないため
 * 「✅ … vektor-inc」の下に「❌ org.allowed_owners に "vektor-inc" を含む … vektor-inc」が
 * 並ぶ、表示上は一致しているのに未充足という自己矛盾したレポートになっていた。
 * 読んだ人は doctor のバグだと受け取り、真因（設定ファイルに制御文字が混入している＝
 * 改竄の痕跡でありうる）へ辿り着けない。加工の事実こそが手がかりなので、消さずに見せる。
 */
const DISPLAY_SANITIZED_NOTE = '（表示のため制御文字を除去）';

/**
 * 設定由来の値を表示用に整え、「表示のために加工したか」も併せて返す。
 *
 * sanitizeConfigDisplayValue の呼び出し箇所ごとに「加工前後を比べて注記を足す」を書くと
 * 同じ 2 行が 6 か所へ散るので、判断と文言をここ 1 か所に集約する。
 *
 * **返すのは表示用の値だけで、合否（ok）の判定には使わない。** 判定に加工後の値を使うと
 * "vek\ntor-inc" が "vektor-inc" に化けて許可オーナーのゲートを通る（fail-open）。
 *
 * altered の比較相手は「trim 済みの生の値」にする。生の値と直接比べると、前後の空白を
 * 落としただけで「加工した」と言ってしまうため（合否側も trim 済みの値を見ているので、
 * 空白の有無で表示と判定が食い違うことはない＝注記を出す理由が無い）。
 * @param {*} value 設定ファイルなど手元のファイルから読んだ値
 * @returns {{ text:string, altered:boolean, display:string }} text=注記なしの整形済み値 /
 *   altered=加工が起きたか / display=注記込みの表示値
 */
function toDisplayValue(value) {
  const text = sanitizeConfigDisplayValue(value);
  const altered = text !== String(value ?? '').trim();
  let display = text;
  if (altered) {
    // 制御文字しか無い値だと注記だけが残り、注記そのものが値のように読めてしまう。
    // その場合は「制御文字のみ」という事実だけで止めず、「だから表示できない」まで言い切る
    // （他の空値表示 `（未設定・一切取り込まない）` と同じ「状態・結果」の 2 段構えに揃える）。
    display = text === '' ? '（値が制御文字のみで表示できません）' : `${text}${DISPLAY_SANITIZED_NOTE}`;
  }
  return { text, altered, display };
}

/**
 * 加工が起きた要件にだけ立てるフラグ（`--json` の消費側が文字列を読まずに判定するため）。
 *
 * 注記を current の文字列へ混ぜるだけだと機械可読性が落ちる（消費側が日本語の文言に
 * 依存する）ので、真偽値も併せて持たせる。逆に **加工が起きていないときは
 * キー自体を生やさない**。`displaySanitized: false` を全行へ足すと、この問題と無縁の
 * 環境の `--json` 出力まで変わり、既存の消費側の差分を無意味に揺らすため。
 * claude 要件の usesDefaultCommand と同じく、必要な行だけが持つ追加フィールドとして扱う。
 * @param {...boolean} flags 各表示値の altered
 * @returns {{ displaySanitized?: true }} 展開してそのまま要件オブジェクトへ混ぜる
 */
function displaySanitizedFlag(...flags) {
  return flags.some(Boolean) ? { displaySanitized: true } : {};
}

/**
 * 表示のために値を加工したときの警告（2 行）。**doctor のレポートと `up` の未充足警告で
 * 共有する**ため、文言はここ 1 か所に持つ。
 *
 * 分けて持つと、同じ状態なのに経路によって伝わる情報が食い違う。とくに
 * 「覚えのない文字なら、設定ファイルの出所そのものを疑ってください」は #252 の主眼
 * （加工の事実は改竄の痕跡でありうる）を伝える一文で、片方の経路から落ちると
 * 「注記は出るが、それが何を意味するかはどこにも書かれていない」状態に戻る。
 *
 * 参照先にファイル名を列挙しない。加工は config.json だけでなく vk-agents 正本 config・
 * require.resolve で解決した VK Terminals のパス・~/.claude の版の記録ファイルでも起きるので、
 * 列挙は広げても広げ切れず、漏れた経路の利用者には嘘の案内になる。「ファイル」とも言い切らない
 * （VK Terminals のパスは利用者が開いて直せるファイルではない）。代わりに **注記そのものを
 * 目印にする**（「注記が付いた項目」なら 6 経路すべてを 1 文でカバーできる）。
 */
const DISPLAY_SANITIZED_WARNING_LINES = [
  '一部の値に、画面には表示されない文字（制御文字）が含まれていたため、表示のみ取り除いています（判定は元の値のまま行っています）。',
  // 「上の一覧」とは言わない。`up` の未充足警告は要件一覧を出さず未充足項目の箇条書きだけなので、
  // 加工が充足済みの行だけで起きた場合、`up` の出力のどこにも注記が現れない。「doctor の一覧」なら、
  // レポート側は一覧がすぐ上にあり、`up` 側は doctor へ正しく誘導できる（両経路で読める言い方）。
  'doctor の一覧で注記が付いた項目の値を、その出どころ（config.json など）から見直してください。覚えのない文字なら、設定ファイルの出所そのものを疑ってください。',
];

/**
 * 加工が起きていれば上記の警告を組み立てる。起きていなければ空文字を返す
 * （呼び出し側は真偽値として扱える）。
 *
 * 要件名も値も埋め込まない固定文言にしている。設定値から偽造できない文字列が 1 か所ある、
 * というのが警告としての信頼性そのもので、可変値を入れるとその性質を手放すことになる。
 * 字下げは**空白の個数（数値）で受ける**。任意の文字列を許すと、後から誰かが変数を繋いだ
 * 瞬間に、改行入りの値で固定文言の中へ行を生やせてしまう（`\n  ✅ 偽の必須項目（必須） … 充足`）。
 * 本体を固定文言にして「設定値からは偽造できない文字列が 1 か所ある」性質を作っているので、
 * その性質は引数の型でも守る。柔軟さより、生やせないことを優先する。
 * @param {ReturnType<typeof runDoctor>} requirements
 * @param {{ indent?: number }} [options] 行頭に付ける空白の個数（`up` の警告は 2）
 * @returns {string} 2 行の警告（加工が無ければ空文字）
 */
export function formatDisplaySanitizedWarning(requirements, { indent = 0 } = {}) {
  if (!requirements?.some((r) => r.displaySanitized)) return '';
  const pad = ' '.repeat(indent);
  const [cause, action] = DISPLAY_SANITIZED_WARNING_LINES;
  return `${pad}⚠️ ${cause}\n${pad}   ${action}`;
}

/**
 * tmux コマンドのバージョン文字列（例: "tmux 3.4"）を返す。
 * 未導入なら execFileSync が throw するので、呼び出し側で未導入扱いにする。
 *
 * gh 認証用の options.execFileSync とは分けた専用フックにしている（execFileSync を
 * 共用すると、引数を見ないフェイクで「tmux 常に導入済み」に倒れてテストが書けない）。
 * @returns {string}
 */
function realResolveTmuxVersion() {
  return String(
    realExecFileSync('tmux', ['-V'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000, // doctor はローカル高速判定。ハングで固まらせない（timeout は throw → 未導入扱い）
      maxBuffer: 64 * 1024, // 想定は "tmux 3.4" 程度。異常な巨大出力は throw させる
    }) ?? '',
  ).trim();
}

/**
 * Claude Code コマンドのバージョン文字列（例: "2.0.14 (Claude Code)"）を返す。
 * 未導入なら execFileSync が throw するので、呼び出し側で未導入扱いにする。
 *
 * realResolveTmuxVersion と同じく専用フックにしている（gh 認証用の execFileSync と
 * 共用すると、引数を見ないフェイクで「claude 常に導入済み」に倒れてテストが書けない）。
 *
 * command は「実行ファイル名だけ」を受け取る前提で、**シェルを介さず execFileSync へ
 * 直接渡す**。tmux モードの起動コマンドは設定で任意文字列に差し替えられるため、
 * 引数付きの値をそのままシェルに通すと設定ファイル経由のコマンド実行になってしまう。
 * @param {string} command 実行ファイル名（引数を含まない先頭トークン）
 * @returns {string}
 */
function realResolveClaudeVersion(command) {
  return String(
    realExecFileSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // tmux(-V) より長め。claude は Node ランタイムの起動を挟むため、コールドスタートでは
      // 2 秒に収まらず「入っているのに未導入」と誤検知しうる。それでも doctor はローカル
      // 高速判定なので上限は設ける（timeout は throw → 未導入扱い）。
      timeout: 5000,
      maxBuffer: 64 * 1024, // 想定は 1 行のバージョン表記。異常な巨大出力は throw させる
    }) ?? '',
  ).trim();
}

/**
 * ホスト名／IP として妥当な文字だけで構成されているか。
 *
 * 正規化後に許すのは英数字と `.` `-` `_` `:`（IPv6）だけ。制御文字や空白が混じった値は
 * 「ホストとして解釈できない＝手元かどうか判断できない」ものとして扱う。
 */
const VALID_HOST_PATTERN = /^[a-z0-9._:-]+$/;

/** 全アドレス束縛の表記（どの NIC で受けても待ち受けているのは手元のプロセス）。 */
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::']);

/** 127.0.0.0/8（127.0.1.1 など）と IPv4 射影表記の ::ffff:127.x.x.x。 */
const LOOPBACK_V4_PATTERN = /^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * VK Terminals API の接続先が手元のマシンかを判定する（純関数）。
 *
 * ループバックと自マシンのアドレス照合は engine と共通の isLocalMachineHost() に委ねる。
 * apiHost に自分の Tailscale IP / LAN IP を書く運用（tailscale serve でモバイルから確認する
 * 構成）があるため、ループバック表記だけを見て別マシンと判定してはいけない。そこを誤ると
 * ペインは手元で開くのに claude 要件が任意へ落ち、「claude が無くてタスクが進まないのに
 * 何も案内されない」状態（issue #247）が再発する。
 *
 * **判断できない値はすべて「手元」へ倒す**（＝従来どおり必須のまま）。任意へ倒すと案内が
 * 消えて詰みが再発するのに対し、必須へ倒しても出るのは従来どおりの案内だけで済むため。
 * - 空文字（未設定・解決失敗）※ isLocalMachineHost('') は false を返す仕様なのでここで拾う
 * - 全アドレス束縛（0.0.0.0 / ::）
 * - 127.0.0.0/8 と ::ffff:127.x.x.x（isLocalMachineHost は 127.0.0.1 のみをループバック扱い）
 * - ホストとして妥当でない文字を含む値（制御文字混入など）
 * @param {*} host resolveVkTerminalsApiHost() の戻り値
 * @param {string[]} [localAddresses] 自マシンのアドレス一覧（省略時は os から収集）
 * @returns {boolean} 手元のマシンを指していれば true
 */
export function isLocalVkTerminalsApiHost(host, localAddresses) {
  const normalized = normalizeHostForLocalComparison(host);
  if (normalized === '') return true;
  if (!VALID_HOST_PATTERN.test(normalized)) return true;
  if (WILDCARD_BIND_HOSTS.has(normalized)) return true;
  if (LOOPBACK_V4_PATTERN.test(normalized)) return true;
  // localAddresses が undefined のときは isLocalMachineHost 側の既定（os から収集）に任せる。
  return isLocalMachineHost(normalized, localAddresses);
}

/**
 * doctor が導入確認に使う Claude Code の実行ファイル名を決める。
 *
 * 実際にペインで起動されるコマンドと同じものを検査しないと、独自コマンド運用の環境で
 * 「素の claude が無い」と誤検知する。tmux モードの起動コマンドは
 * resolveTmuxClaudeCommand()（env VK_TMUX_CLAUDE_CMD > tmux.claudeCommand > 'claude'）で
 * 差し替えられるので、そこから実行ファイル名を取り出す。値は
 * `claude --dangerously-skip-permissions` のような任意文字列なので、空白区切りの
 * 先頭トークンだけを使う（引数は導入確認に不要で、シェルへ渡すと危険なため）。
 *
 * vk-terminals モードは VK Terminals 側が素の claude を起動するため 'claude' 固定。
 *
 * **戻り値は「実行に渡す値」なので長さで切り詰めない。** 表示用の sanitizeReportValue を
 * ここへ流用すると 64 文字で切れる。fnm / volta / asdf 配下の claude の絶対パスは 64 文字を
 * 簡単に超えるうえ、「tmux サーバーの PATH に claude が無いので絶対パスを書く」は
 * tmux.claudeCommand に絶対パスを設定する典型的な動機なので、正しく設定できている人ほど
 * 途中で切れたパスを検査されて誤検知される。表示用の整形は呼び出し側に任せ、ここでは
 * レポートの行構造を壊す制御文字だけを落とす。
 * @param {boolean} tmuxMode 実行面モードが tmux か
 * @param {object} cfg loadUnifiedConfig() の戻り値
 * @returns {string} 検査対象の実行ファイル名／絶対パス（解決できなければ 'claude'）
 */
function resolveClaudeCommandName(tmuxMode, cfg) {
  if (!tmuxMode) return 'claude';
  const head = String(resolveTmuxClaudeCommand(cfg)).trim().split(/\s+/)[0];
  return stripControlChars(head).trim() || 'claude';
}

/**
 * 要件チェックリストを実状態から計算して返す。
 *
 * 依存注入でテスト可能にするため、副作用のある入力（fs / gh / platform / node / config パス）は
 * すべて options で差し替えられる。
 * @param {{
 *   homeDir?: string,
 *   configPath?: string,
 *   config?: object,
 *   queueBackend?: 'github'|'local',
 *   terminalsMode?: 'vk-terminals'|'tmux',
 *   manifestPath?: string,
 *   canonicalConfigPath?: string,
 *   execFileSync?: Function,
 *   resolveVkTerminalsDir?: () => string,
 *   resolveVkTerminalsApiHost?: (options?: object) => string,
 *   vkTerminalsApiHost?: string,
 *   localMachineAddresses?: string[],
 *   resolveTmuxVersion?: () => string,
 *   resolveClaudeVersion?: (command: string) => string,
 *   platform?: string,
 *   nodeVersion?: string,
 * }} [options]
 * @returns {Array<{ id:string, group:string, label:string, required:boolean, ok:boolean, current:string, hint:string, target:'A'|'B'|'C'|'external'|'manifest', usesDefaultCommand?:boolean }>}
 *   usesDefaultCommand は claude 要件のみが持ち、検査対象が既定の `claude` だったかを表す
 *   （締めの案内でインストールを勧めてよいかの判断に使う）。
 */
export function runDoctor(options = {}) {
  const homeDir = options.homeDir ?? homedir();
  const configPath = options.configPath ?? resolveConfigPath();
  const cfg = options.config ?? loadUnifiedConfig(configPath);
  const backend = options.queueBackend ?? getQueueBackend(cfg);
  const githubMode = backend === 'github';
  const terminalsMode = options.terminalsMode ?? resolveTerminalsMode(cfg);
  const tmuxMode = terminalsMode === 'tmux';
  const platform = options.platform ?? process.platform;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const manifestPath = options.manifestPath ?? vkAgentsSkillsManifestPath(homeDir);
  const canonicalConfigPath =
    options.canonicalConfigPath ?? resolveVkAgentsCanonicalConfigPath(cfg, { homeDir });
  const execFileSyncImpl = options.execFileSync ?? realExecFileSync;
  const resolveVkTerminals = options.resolveVkTerminalsDir ?? realResolveVkTerminalsDir;
  const resolveTmuxVersion = options.resolveTmuxVersion ?? realResolveTmuxVersion;
  const resolveClaudeVersion = options.resolveClaudeVersion ?? realResolveClaudeVersion;
  const resolveApiHost = options.resolveVkTerminalsApiHost ?? realResolveVkTerminalsApiHost;

  const requirements = [];

  // 0-1 Node.js 20+
  const nodeMajor = Number(String(nodeVersion).split('.')[0]);
  requirements.push({
    id: 'node',
    group: '前提',
    label: 'Node.js 20 以上',
    required: true,
    target: 'external',
    ok: Number.isFinite(nodeMajor) && nodeMajor >= 20,
    current: `v${nodeVersion}`,
    hint: 'Node.js 20 以上をインストールしてください（例: nvm install 20 / brew install node）。',
  });

  // 0-2 プラットフォーム（実行面モードで文言が変わる。tmux モードは GUI 非依存）
  const platformOk = platform === 'darwin' || platform === 'linux';
  requirements.push({
    id: 'platform',
    group: '前提',
    label: tmuxMode ? '対応プラットフォーム（macOS / Linux）' : '対応プラットフォーム（macOS / WSL2）',
    required: true,
    target: 'external',
    ok: platformOk,
    current: platform,
    hint: tmuxMode
      ? 'tmux モードは GUI を起動しないため、macOS / Linux（コンテナ・SSH 先・WSL2 を含む）であれば動作します。'
      : platform === 'darwin'
        ? 'macOS では VK Terminals(GUI) をそのまま起動できます。'
        : 'macOS または WSL2(WSLg) 上の Ubuntu で GUI を起動できます。それ以外の環境では別マシンの VK Terminals API を使う構成（~/.vk-terminals/config.json の apiHost + `vk-orchestrator start`）を検討してください。',
  });

  // terminals.mode（実行面のモード選択。以降の required がこの値で変わる）
  // ※ 他の項目に付いている 0-x / 2-x は SKILL.md のヒアリング順の ID で、配列の順番ではない。
  //    実行面モード関連はヒアリング項目に無いため番号を振らない。
  requirements.push({
    id: 'terminals.mode',
    group: '前提',
    label: '実行面モード（モード選択）',
    required: true,
    target: 'A',
    ok: true, // 既定 vk-terminals が常に解決されるため、選択自体は常に充足。以降の required はこの値で変わる。
    current: tmuxMode ? 'tmux' : 'vk-terminals（既定）',
    hint: 'config.json の terminals.mode で vk-terminals（既定・GUI）/ tmux を選べます。以降の必須項目はこのモードで変わります。',
  });

  // 0-4 VK Terminals 導入（vk-terminals モードで必須。tmux モードは GUI を使わないので任意）
  let vkTerminalsOk = false;
  let vkTerminalsDir = '';
  try {
    vkTerminalsDir = resolveVkTerminals();
    vkTerminalsOk = Boolean(vkTerminalsDir);
  } catch {
    vkTerminalsOk = false;
  }
  // config 由来ではなく require.resolve のパスだが、外から来る表示値であることは同じなので、
  // 行崩しの経路を残さないよう同じ整形（長さ制限なし）を通す。パスは長くなるのが正常なため
  // sanitizeReportValue（64 文字）は使わない。
  const vkTerminalsView = toDisplayValue(vkTerminalsDir);
  // 未導入のときは整形前の値を表示しないので、加工の有無も問わない。
  const vkTerminalsAltered = vkTerminalsOk && vkTerminalsView.altered;
  requirements.push({
    id: 'vk-terminals',
    group: '前提',
    label: 'VK Terminals 導入',
    required: !tmuxMode,
    target: 'external',
    ok: vkTerminalsOk,
    current: vkTerminalsOk ? vkTerminalsView.display : '未導入',
    hint: tmuxMode
      ? 'tmux モードでは VK Terminals(GUI) は不要です（vk-terminals モードに切り替えるときだけ `npm run setup:terminals` で導入してください）。'
      : '`npm run setup:terminals` で導入してください（GUI は macOS 専用。非対応 OS では別マシンの VK Terminals API を使う構成を利用）。',
    ...displaySanitizedFlag(vkTerminalsAltered),
  });

  // tmux コマンド導入（tmux モードのみ。vk-terminals モードでは行自体を出さない）
  if (tmuxMode) {
    let tmuxVersion = '';
    try {
      // 外部コマンドの stdout はそのままレポート／--json に載せない（sanitizeReportValue）。
      // 想定値は "tmux 3.4" 程度。
      tmuxVersion = sanitizeReportValue(resolveTmuxVersion());
    } catch {
      tmuxVersion = '';
    }
    const tmuxOk = tmuxVersion !== '';
    requirements.push({
      id: 'tmux',
      group: '前提',
      label: 'tmux コマンド導入',
      required: true,
      target: 'external',
      ok: tmuxOk,
      current: tmuxOk ? tmuxVersion : '未導入',
      hint: 'tmux をインストールしてください（例: `brew install tmux` / Ubuntu は `sudo apt install tmux`）。',
    });
  }

  // Claude Code コマンド導入（手元でペインを開く構成では必須）
  //
  // オーケストレーターの中核は「ペインで Claude Code を起動して作業させる」ことなので、
  // claude コマンドが無いとペインは開いても即終了し、タスクが一切進まない。それにも関わらず
  // 従来はこの要件自体が無く、doctor も `up` も何も案内しないまま詰んでいた（issue #247）。
  //
  // ただし vk-terminals モードで VK Terminals API の接続先が別マシンの場合、ペインは
  // 接続先マシンで開くため、claude が必要なのは接続先であって手元ではない。従来はここを
  // 常に required にしていたので、その構成では解消しようのない ❌ が出続け、`up` でも毎回
  // 「未充足の項目があります」と警告された（issue #249）。接続先が手元以外なら任意にする。
  // 「手元」には自マシンのアドレス（apiHost に自分の Tailscale IP / LAN IP を書く運用）も
  // 含む。ここを取りこぼすと、ペインは手元で開くのに案内が消える（#247 の詰みが再発する）。
  //
  // tmux モードは接続先ホストに関係なく手元で claude を起動するので、常に必須のままにする。
  //
  // 自動インストールはしない。doctor は副作用の無いローカル高速判定に限定し、外部依存
  // （Node.js / tmux / gh など）はすべて「検知して hint で案内」に統一しているため。
  //
  // ホスト解決は env / 外部ファイル（~/.vk-terminals/config.json）由来なので、例外が出ても
  // doctor 全体を落とさない。失敗時は「手元」に倒し、従来どおり必須として扱う（安全側）。
  let vkTerminalsApiHost = '';
  if (options.vkTerminalsApiHost !== undefined) {
    vkTerminalsApiHost = String(options.vkTerminalsApiHost ?? '');
  } else {
    try {
      vkTerminalsApiHost = String(resolveApiHost({ homeDir }) ?? '');
    } catch {
      vkTerminalsApiHost = '';
    }
  }
  // 接続先の表示は sanitizeReportValue（先頭行・長さ制限）を使う。sanitizeReportValue の
  // JSDoc は「設定ファイル由来の値には使わない」としているが、それは許可オーナー一覧のように
  // 長くなるのが正常な値を切ると別の混乱を生むため。apiHost は "100.64.0.2" のような 1 行の
  // ホスト名／IP で 64 文字を超えるのは異常値なので、ここは切ってでも 1 行に収める方を選ぶ
  // （長大な値でレポート 1 行が伸びるのを防ぐ）。合否判定には生の値を使う。
  const apiHostLabel = sanitizeReportValue(vkTerminalsApiHost);
  let claudeRunsOnRemoteHost = false;
  if (!tmuxMode) {
    try {
      claudeRunsOnRemoteHost = !isLocalVkTerminalsApiHost(vkTerminalsApiHost, options.localMachineAddresses);
    } catch {
      // 自マシンのアドレス収集（os.networkInterfaces）で落ちても doctor 全体は止めない。
      // 判断できないので手元扱い＝従来どおり必須へ倒す（安全側）。
      claudeRunsOnRemoteHost = false;
    }
  }
  // 制御文字だけの値など、整形後に空になっても文言が「接続先 () のマシン」と壊れないようにする。
  const remoteHostText = apiHostLabel ? `接続先（${apiHostLabel}）` : '接続先';
  // ⚠️（任意）の行は未充足リストに出ないので hint はレポート本体に一度も現れない。
  // 「どこに Claude Code が必要か」は current 側で言い切る。「手元では不要」とは書かない
  // （ペイン起動には不要でも、/vk-orchestrator-setup を手元で回すには要るため）。
  const remoteClaudeCurrent = apiHostLabel
    ? `手元は未導入（ペインは接続先 ${apiHostLabel} で開くため接続先側に必要）`
    : '手元は未導入（ペインは接続先マシンで開くため、必要なのは接続先側）';
  const claudeCommand = resolveClaudeCommandName(tmuxMode, cfg);
  // 検査対象は実行に渡すため切り詰めていないので、レポートへ載せるときだけ 1 行・長さ制限へ整える。
  const claudeCommandLabel = sanitizeReportValue(claudeCommand);
  // 素の claude を見ているか、利用者が設定した独自コマンドを見ているかで案内すべき行動が変わる。
  const usesDefaultClaudeCommand = claudeCommand === DEFAULT_CLAUDE_COMMAND;
  // hint に「そのまま貼れるコマンド行」として設定値を埋めてよいか（issue #253）。
  // 埋める先は表示用の claudeCommandLabel だが、判定は生の値にも掛ける。長い値は表示側で
  // 64 文字に切られるため、末尾に置かれた危険な文字が切り落とされた結果「安全に見える」
  // ことがあり、ラベルだけを見ると素通りしてしまうため（生が不安全ならラベルも不安全扱い）。
  const canShowClaudeCommandLine = isShellSafeCommandForDisplay(claudeCommand)
    && isShellSafeCommandForDisplay(claudeCommandLabel);
  // レポート本体（current）と hint で値を出すときの表示形。危険側だけ JSON.stringify で
  // 括る（issue #253）。current は `未導入（コマンド: <値>）` のように全角括弧の中へ値が
  // 入るので、値に `）` を入れられると括弧を閉じて外へ出られ、レポートの行そのものが
  // 「復旧するには次を実行: …」のような偽の指示文になる。しかも current の行は hint より
  // 上に出るため、読み手が最初に目にする。
  //
  // ok（✅）側も同じ扱いに揃える。「見つかった＝実在する実行ファイル」ではあるが、実在する
  // ことと名前が安全なことは別で、ファイル名に `）` は普通に入れられる。むしろ ✅ の行は
  // 読み手の警戒が下がる分、偽の指示文を混ぜられたときに効いてしまう。
  //
  // 安全側は許可リストを通った値しか来ず `"` も `）` も入り得ないので従来の出力のまま
  // （通常運用の表示とテストを 1 文字も動かさない）。
  //
  // ここで守っている不変条件は「囲い（引用符）を閉じるのは doctor 側だけで、値の側からは
  // 閉じられない」。全角の `）` は JSON.stringify でエスケープされず値の中に見えるが、囲いを
  // 閉じられない以上、製品が語っているように見せることはできない。**この不変条件が効くのは
  // 囲いが読み手に見える文脈に限る。** 将来この値をコードフェンスや `<code>` の中、あるいは
  // 引用符が意味を持たない／消費される文脈（シェルの引数例、CSV など）へ入れるときは、
  // 同じ判定をやり直すこと。
  const claudeCommandDisplay = canShowClaudeCommandLine
    ? claudeCommandLabel
    : JSON.stringify(claudeCommandLabel);
  let claudeVersion = '';
  try {
    // 外部コマンドの stdout はそのままレポート／--json に載せない（sanitizeReportValue）。
    // 想定値は "2.0.14 (Claude Code)" 程度。
    claudeVersion = sanitizeReportValue(resolveClaudeVersion(claudeCommand));
  } catch {
    claudeVersion = '';
  }
  const claudeOk = claudeVersion !== '';
  requirements.push({
    id: 'claude',
    group: '前提',
    label: 'Claude Code コマンド導入',
    required: !claudeRunsOnRemoteHost,
    target: 'external',
    ok: claudeOk,
    // 独自コマンド運用のときだけコマンド名を添える。何を見て ❌／✅ になったのかが分からないと
    // 「claude は入っているのに ❌ になる」「自分の設定が見られているのか分からない」と混乱するため。
    // 既定の claude しか使っていない大多数には、余計な情報を出さない。
    //
    // 別マシン構成で未導入のときは、レポート本体（label と current しか出ない）だけを見ても
    // 「なぜ ⚠️ 止まりなのか」が分かるよう、current に理由を添える。⚠️ の行は未充足リストに
    // 出ないため、hint はレポート本体には現れない。
    // 見つかった場合は素直に ✅（手元にも入っている、以上の意味は持たせない）。
    // 値の表示形（claudeCommandDisplay）は安全側／危険側で切り替わる。理由は定義箇所を参照。
    current: claudeOk
      ? (usesDefaultClaudeCommand ? claudeVersion : `${claudeVersion}（コマンド: ${claudeCommandDisplay}）`)
      : claudeRunsOnRemoteHost
        ? remoteClaudeCurrent
        : `未導入（コマンド: ${claudeCommandDisplay}）`,
    // 独自コマンドが見つからないときに「npm install -g @anthropic-ai/claude-code してください」を
    // 先頭に置くと、それを実行しても生えるのは claude で、設定した独自コマンドは直らない。
    // 一番効く行動（PATH 確認 → 設定値の見直し）を先に出す。
    // 2 分岐とも「何が見つからないか → 打つ手」の型で揃える（レポート末尾の締めは
    // 単独で読まれるので自己完結させ、重複はコマンド文字列だけに留める）。
    //
    // 別マシン構成では「手元に入れろ」と言わない。ペインが開くのは接続先マシンなので、
    // 手元にインストールしても元の詰まり（接続先に claude が無い）は直らない。
    //
    // 独自コマンドの分岐はさらに 2 つに割れる（issue #253）。許可リストを通らない値では
    // `<設定値> --version` というコピペ用のコマンド行を出さない。hint は「そのまま
    // ターミナルに貼ってください」という文脈で読まれるため、細工された設定ファイルを含む
    // リポジトリの利用者が案内どおりに貼ると意図しないコマンドが動く。
    // 値そのものの表示は両分岐で残す。config.json のどの値が問題なのかが分からないと
    // 直しようがないため。潰すのは「実行させる形での提示」だけ。
    //
    // 値の表示形（claudeCommandDisplay）は current と共有する。危険側だけ JSON.stringify で
    // 括る理由は定義箇所に書いた。
    hint: claudeRunsOnRemoteHost
      ? `ペインは VK Terminals API の${remoteHostText}のマシンで開くため、Claude Code は接続先マシンに入っていれば足ります（手元は任意）。タスクが進まない場合は、接続先マシンで \`claude --version\` が動くかを確認してください。手元にも Claude Code が要るのは、\`/vk-orchestrator-setup\` を手元で実行する場合です。その場合は ${CLAUDE_INSTALL_COMMAND} でインストールしてください。`
      : usesDefaultClaudeCommand
        ? `\`claude\` コマンドが見つかりません。${CLAUDE_INSTALL_COMMAND} でインストールし、\`claude --version\` が動くことを確認してください（インストール済みなのに未導入と出る場合は、シェルを開き直して PATH を通し直してください）。`
        : canShowClaudeCommandLine
          ? `ペイン起動に使うコマンド "${claudeCommandDisplay}" が見つかりません。\`${claudeCommandDisplay} --version\` が動くか確認してください。動かない場合は config.json の tmux.claudeCommand（環境変数 VK_TMUX_CLAUDE_CMD）の値を見直すか、素の Claude Code を使うなら設定を外して ${CLAUDE_INSTALL_COMMAND} でインストールしてください。`
          : `ペイン起動に使うコマンド ${claudeCommandDisplay} が見つかりません。設定されている値が、実行ファイル名やパスとして扱える文字だけで書かれていないため、確認用のコマンドは案内しません（バッククォート \` や \`$\`、\`;\` が含まれていると、貼ったときに別のコマンドまで動いてしまうためです）。config.json の tmux.claudeCommand（環境変数 VK_TMUX_CLAUDE_CMD）の値を見直すか、素の Claude Code を使うなら設定を外して ${CLAUDE_INSTALL_COMMAND} でインストールしてください。設定した覚えのない値なら、そのままにせず削除してください。`,
    // レポート末尾の締め（formatSetupEntryGuidance）が「Claude Code 自体が無い」と
    // 「独自コマンドが見つからない」を区別するためのフラグ。この要件だけが持つ。
    usesDefaultCommand: usesDefaultClaudeCommand,
  });

  // 0-5 vk-agents スキル展開
  const agentsSetupOk = isVkAgentsSetup({ manifestPath, homeDir });
  requirements.push({
    id: 'vk-agents-setup',
    group: '前提',
    label: 'vk-agents スキル展開',
    required: true,
    target: 'manifest',
    ok: agentsSetupOk,
    current: agentsSetupOk ? '展開済み' : '未展開',
    hint: '`npm run setup:agents` で skills/rules を ~/.claude へ展開してください（未展開だと /vk-kore が存在しません）。',
  });

  // 展開済みエージェント定義の版（任意）。
  //
  // manifest の有無しか見ていなかったため「古い版が展開済み」を検知できなかった。
  // ここは required: false にする。required にすると、この機能より前から使っている環境
  // （記録に版が入っていない）の `up` が一斉に警告塗れになるため。
  //
  // 判定と文言は起動時の再展開と同じものを使う（ログと診断で結論が食い違わないようにする）。
  // ok は「展開済みが同梱より古くないか」で見る。同梱が利用者の clone より古いのは
  // 通常の定常状態なので、そこを警告にはしない。
  const vendoredAgentsVersion = options.vendoredVkAgentsVersion !== undefined
    ? options.vendoredVkAgentsVersion
    : readVendoredVkAgentsVersion();
  const deployedAgentsRecord = options.vkAgentsManifestSource !== undefined
    ? options.vkAgentsManifestSource
    : readVkAgentsManifestSource({ homeDir });
  const agentsVersionState = evaluateAgentsVersionState({
    vendorVersion: vendoredAgentsVersion,
    recordedVersion: deployedAgentsRecord?.sourceVersion ?? null,
    manifestExists: agentsSetupOk,
  });
  const agentsVersionView = formatAgentsVersionRequirement(agentsVersionState);
  // 版の文字列は同梱ファイルと ~/.claude の記録ファイル（どちらも手編集できる JSON）由来で、
  // config.json と同じく利用者の手元のファイルから来る表示値なので同じ整形を通す。
  const agentsVersionCurrent = toDisplayValue(agentsVersionView.current);
  const agentsVersionHint = toDisplayValue(agentsVersionView.hint);
  requirements.push({
    id: 'vk-agents-version',
    group: '前提',
    label: '展開済みエージェント定義の版',
    required: false,
    target: 'manifest',
    ok: agentsVersionView.ok,
    current: agentsVersionCurrent.display,
    // 注記は current 側へ一度だけ添える。hint は文章なので、途中に注記を挟むと文が壊れて
    // 読めなくなる（どの行で加工が起きたかは current と displaySanitized で分かる）。
    hint: agentsVersionHint.text,
    ...displaySanitizedFlag(agentsVersionCurrent.altered, agentsVersionHint.altered),
  });

  // 1-1 queue.backend（モード選択）
  requirements.push({
    id: 'queue.backend',
    group: 'オーケストレーター',
    label: 'キューの保存先（モード選択）',
    required: true,
    target: 'A',
    ok: true, // 既定 local が常に解決されるため、選択自体は常に充足。以降の required はこの値で変わる。
    current: githubMode ? 'GitHub' : 'ローカル（既定）',
    hint: 'config.json の queue.backend でローカル（既定）/ GitHub を選べます。以降の必須項目はこのモードで変わります。',
  });

  // 0-3 gh 認証（GitHub モードで必須）
  let ghAuthOk = false;
  try {
    ghAuthOk = Boolean(getGitHubTokenFromGh(execFileSyncImpl));
  } catch {
    ghAuthOk = false;
  }
  requirements.push({
    id: 'gh-auth',
    group: 'GitHub',
    label: 'GitHub CLI 認証（gh auth token）',
    required: githubMode,
    target: 'external',
    ok: ghAuthOk,
    current: ghAuthOk ? '認証済み' : '未認証',
    hint: '`gh auth login` で認証してください（gh 未導入なら `brew install gh` / Ubuntu は `sudo apt install gh`）。',
  });

  // 2-1 github.owner（GitHub モードで必須。既定 vektor-inc のままは危険）
  //
  // owner は「表示」と「org.allowed_owners との一致判定」の両方に使う。判定には**生の値**を
  // 使い続け、表示にだけ ownerView を使う。制御文字を除去した値で比較すると
  // "vek\ntor-inc" が "vektor-inc" に化けて許可ゲートを通ってしまう（fail-open）ため。
  const ownerSet = hasNonEmpty(cfg, 'github.owner');
  const owner = ownerSet ? String(getPath(cfg, 'github.owner')).trim() : DEFAULT_OWNER;
  const ownerView = toDisplayValue(owner);
  // 設定値が文字列として書かれているか。オブジェクト・配列・数値・真偽値は String() を通すと
  // "[object Object]" のような**値の形をした文字列**に化けるだけで、オーナー名としては使えない。
  // 未設定のときは既定値（文字列）を見るので、文字列として扱う。
  const ownerIsString = !ownerSet || typeof getPath(cfg, 'github.owner') === 'string';
  // 未設定なら表示するのは既定値の案内文なので、加工の有無は問わない。
  const ownerAltered = ownerSet && ownerView.altered;
  requirements.push({
    id: 'github.owner',
    group: 'GitHub',
    label: 'GitHub オーナー（github.owner）',
    required: githubMode,
    target: 'A',
    ok: ownerSet,
    current: ownerSet ? ownerView.display : `（未設定・既定 ${DEFAULT_OWNER}）`,
    hint: 'config.json の github.owner に自分のユーザー／組織名を設定してください（既定 vektor-inc のままだと他組織のキューを見に行きます）。',
    ...displaySanitizedFlag(ownerAltered),
  });

  // 2-2 github.repo（GitHub モードのみ。既定 task-queue で可）
  const repoSet = hasNonEmpty(cfg, 'github.repo');
  const repo = repoSet ? String(getPath(cfg, 'github.repo')).trim() : DEFAULT_REPO;
  const repoView = toDisplayValue(repo);
  requirements.push({
    id: 'github.repo',
    group: 'GitHub',
    label: 'タスク登録リポジトリ名（github.repo）',
    required: githubMode,
    target: 'A',
    // 既定 task-queue も有効な値なので、名前が解決できていれば ok（実在確認はネットワーク検知のため行わない）。
    ok: true,
    current: repoSet ? repoView.display : `${DEFAULT_REPO}（既定）`,
    hint: 'config.json の github.repo に task-queue の Issue を登録するリポジトリ名を設定してください（既定 task-queue で可）。',
    ...displaySanitizedFlag(repoSet && repoView.altered),
  });

  // 2-5 orchestrator.assigneeFilter（GitHub モードで必須。空＝一切取り込まない）
  const assigneeSet = hasNonEmpty(cfg, 'orchestrator.assigneeFilter');
  const assigneeView = toDisplayValue(getPath(cfg, 'orchestrator.assigneeFilter'));
  requirements.push({
    id: 'orchestrator.assigneeFilter',
    group: 'GitHub',
    label: '担当者フィルタ（orchestrator.assigneeFilter）',
    required: githubMode,
    target: 'A',
    ok: assigneeSet,
    // ok は hasNonEmpty（生の値）で判定済み。ここは表示だけを整える。
    current: assigneeSet ? assigneeView.display : '（未設定・一切取り込まない）',
    hint: 'config.json の orchestrator.assigneeFilter に GitHub ログイン名（自分だけなら自分の login）か all を設定してください（空＝一切取り込まない安全側既定）。',
    ...displaySanitizedFlag(assigneeSet && assigneeView.altered),
  });

  // 3-1 org.allowed_owners に owner を含める（両モードで必須。硬ゲート通過用）
  //
  // 一致判定は生の owner と readAllowedOwners の生の値で行う（サニタイズ済みの値で比較すると
  // 制御文字入りの owner が正規化されて許可ゲートを通る＝ fail-open になる）。
  // label / hint にも owner を埋め込んでおり、未充足時は `- ${label}: ${hint}` の形で
  // レポートに出るため、current と同じく表示は必ずサニタイズ済みの値を使う。
  const allowedOwners = readAllowedOwners(canonicalConfigPath);
  const allowedOwnersOk = allowedOwners.includes(owner);
  const allowedOwnersView = toDisplayValue(allowedOwners.join(', '));
  // この行こそが issue #252 の当事者。owner を加工して表示していると
  // 「label に出ている名前が current の一覧にも並んでいるのに ❌」という自己矛盾に見え、
  // doctor のバグだと受け取られて真因（設定ファイルの制御文字）へ辿り着けない。
  //
  // label / hint は owner の状態で 3 通りに分ける。**この行の hint は「未充足時に利用者が
  // 実際に打つ手」なので、加工が起きているときに従来文（一覧へ追加してください）を先に
  // 読ませてはいけない。** 一覧には既にその名前があるので、言われたとおり開いても直らず、
  // #252 と同じ袋小路に戻る。しかも前半だけ読んで動くと、許可オーナー一覧
  // （＝セキュリティ境界）へ不要な項目を足すことになる。だから末尾に足すのではなく、
  // 「原因 → 最初にやること → それでもダメなら」の順に **hint ごと差し替える**。
  let allowedOwnersLabel = `org.allowed_owners に "${ownerView.text}" を含む`;
  let allowedOwnersHint = `vk-agents 正本 config の org.allowed_owners に "${ownerView.text}" を追加してください（値を A の config.json に入れてから \`vk-orchestrator apply\` で投影。未追加だと staff 系スキル／vk-kore の硬ゲートで弾かれます）。`;
  //
  // 分岐の起点は「加工されたか」ではなく **「オーナー名として見せられる値か」**。
  // 加工の有無で分岐すると、文字列以外の値が素通りして `"" を追加してください` が復活する。
  // 拾うべき経路は 2 つあり、どちらも String() の結果を引用符に入れると壊れた案内になる:
  //   - 表示できる文字が残らない値（制御文字だけの値、`"github.owner": []` など）
  //   - 文字列として書かれていない値（`{}` なら "[object Object]" に化けるだけで空にならない）
  // 設定ファイルは手編集でも改竄でも書けるので、どちらも現実の入力として扱う。
  if (ownerView.text === '' || !ownerIsString) {
    // オーナー名として見せられる値が無いので、**引用符で見せない**。`"" を含む` /
    // `"[object Object]" を追加してください` と出すと、そのとおり操作した人が許可オーナー
    // 一覧へ無意味な項目を足すことになる（セキュリティ境界を無駄に広げる指示）。追加の案内
    // 自体を出さず、「まず owner を直す」だけに絞る。直せば次の doctor で通常の案内に戻る。
    allowedOwnersLabel = 'org.allowed_owners に github.owner の値を含む';
    // 原因が「制御文字だけ」かどうかで、利用者が config.json で探すものが変わるので言い分ける。
    // 文字列以外の値は `{}` / `[]` / 数値 / 真偽値をまとめて 1 文で扱う（利用者がやることは
    // どれも同じ「github.owner を正しいユーザー／組織名へ直す」なので、分けても選択肢が増えるだけ）。
    // 制御文字側で「出所を疑ってください」を繰り返さないのは、加工が起きた＝ ⚠️ ブロックが
    // 必ず出る側で、同じ一文が数行上に既にあるため。
    //
    // 文字列以外の側は「可能性があります」と引かない。typeof で文字列でないことを**確定して
    // 知っている**ので、断定できる場面で引くと「では他に何が考えられるのか」と余計な探索を
    // 始めさせる。実態はほぼ引用符の付け忘れなので、直し方は語で説明するより形を 1 つ見せる。
    // ここに出る `"vektor-inc"` は書き方の例示（固定値）であって設定値の表示ではないので、
    // 「設定値を引用符で見せない」という上の判断とは衝突しない。
    allowedOwnersHint = ownerAltered
      ? 'config.json の github.owner が制御文字（画面に表示できない文字）だけの値になっています。この値では許可オーナーの判定ができないため、まず github.owner を正しいユーザー／組織名へ直してください。'
      : `config.json の github.owner が、文字列のオーナー名になっていません。この値では許可オーナーの判定ができないため、まず github.owner を \`"${DEFAULT_OWNER}"\` のように引用符で囲んだユーザー／組織名へ直してください。`;
  } else if (ownerAltered) {
    // 注記は current ではなく **label の末尾** へ出す。この行で加工されているのは current
    // （許可オーナー一覧）ではなく label に埋めた owner なので、current に付けると
    // 「一覧のほうに制御文字がある」という誤った指し示しになる。引用符の中へ入れないのは、
    // 値の一部に読めてしまうため（引用符の内側に同じ文字列を仕込まれても、本物は外側に出る）。
    //
    // 注記は値と「を含む」の区切りも兼ねる。加工時は注記が区切りになるので半角スペースを
    // 重ねない。加工がなければ従来どおりの `"acme" を含む` で、1 文字も変わらない。
    allowedOwnersLabel = `org.allowed_owners に "${ownerView.text}"${DISPLAY_SANITIZED_NOTE}を含む`;
    // この hint が出るのは ownerAltered のときだけで、そのとき ⚠️ ブロック（レポート一覧の
    // 直後）は必ず出る。用語の言い換え（画面には表示されない文字）と「出所を疑ってください」は
    // そちらに既にあり、読む順も ⚠️ が先なので、ここでは繰り返さない。
    //
    // **この寄りかかりが成立するのは、⚠️ ブロックを描画する経路に限る**
    // （formatDoctorReport と bin の `up` 未充足警告。どちらも
    // formatDisplaySanitizedWarning を通す）。hint だけを別の場所へ載せる経路を足すときは、
    // ブロックも一緒に載せること。さらに削るなら、この前提を先に確認すること。
    // #252 の核心である「一覧と同じ名前に見えるのに ❌」の一文だけは必ず残す。
    allowedOwnersHint = `config.json の github.owner に制御文字が混ざっています。上の表示では取り除いてあるので一覧と同じ名前に見えますが、判定は元の値で行うため未充足のままです。まず github.owner を制御文字の無い値へ直してください。直してもなお未充足なら、vk-agents 正本 config の org.allowed_owners に "${ownerView.text}" を追加してください（値を A の config.json に入れてから \`vk-orchestrator apply\` で投影）。`;
  }
  requirements.push({
    id: 'org.allowed_owners',
    group: 'vk-agents',
    label: allowedOwnersLabel,
    required: true,
    target: 'C',
    ok: allowedOwnersOk,
    // 一覧は項目数が多くなるのが正常なので、長さでは切らない（途中で切ると
    // 「自分のオーナー名が入っているのに見えない」という別の混乱になる）。
    current: allowedOwners.length ? allowedOwnersView.display : '（未設定）',
    hint: allowedOwnersHint,
    ...displaySanitizedFlag(ownerAltered, allowedOwners.length > 0 && allowedOwnersView.altered),
  });

  return requirements;
}

/**
 * 要件配列を要約する。
 * @param {ReturnType<typeof runDoctor>} requirements
 * @returns {{ total:number, okCount:number, requiredCount:number, requiredOkCount:number, missingRequired:Array, allRequiredOk:boolean }}
 */
export function summarizeDoctor(requirements) {
  const required = requirements.filter((r) => r.required);
  const missingRequired = required.filter((r) => !r.ok);
  return {
    total: requirements.length,
    okCount: requirements.filter((r) => r.ok).length,
    requiredCount: required.length,
    requiredOkCount: required.filter((r) => r.ok).length,
    missingRequired,
    allRequiredOk: missingRequired.length === 0,
  };
}

/**
 * 未充足時の締め（＝次にどこへ行けばよいか）の一文を組み立てる。
 *
 * 従来は無条件で「Claude Code でこのリポジトリを開き `/vk-orchestrator-setup` を実行」と
 * 締めていたが、Claude Code 未導入で ❌ が出ている人にとっては実行不可能な指示で、
 * この診断が救おうとしている当事者がそのまま二度目の壁にぶつかる（詰みループ）。
 * claude が未充足のときだけ、先にインストールを促す締めへ差し替える。
 *
 * **判定は summary.missingRequired ではなく claude 要件の ok を見る。** 別マシン構成では
 * claude が required: false になって missingRequired から消えるため、missingRequired だけを
 * 見ると「手元では不要」と表示した数行後に「手元の Claude Code で開いて実行してください」と
 * 締めてしまう（issue #249 の対応で生まれた矛盾）。その構成では、対話セットアップにだけは
 * 手元の Claude Code が要ることと、入れない場合の逃げ道（config.json の直接編集）を示す。
 *
 * doctor のレポートと `up` の警告で判断と文言を一致させるため、ここを唯一の正にする。
 * @param {ReturnType<typeof summarizeDoctor>} summary
 * @param {ReturnType<typeof runDoctor>} [requirements] 要件配列。省略すると
 *   summary.missingRequired だけを見る従来動作（任意扱いの claude は判定に入らない）。
 * @returns {string}
 */
export function formatSetupEntryGuidance(summary, requirements) {
  const claude = (requirements ?? summary.missingRequired).find((r) => r.id === 'claude');
  const claudeMissing = claude && !claude.ok ? claude : null;
  if (!claudeMissing) {
    return 'Claude Code でこのリポジトリを開き `/vk-orchestrator-setup` を実行すると、対話でまとめてセットアップできます。';
  }
  // 別マシン構成（claude は任意）。ペイン起動には手元の claude は要らないので
  // 「まずインストールを」とは言わない。ただし対話セットアップは手元で走るため、
  // 手元に入れない人が詰まらないよう config.json を直接書く道も併記する。
  if (claudeMissing.required === false) {
    return '`/vk-orchestrator-setup` は手元の Claude Code で実行します（ペイン起動には手元の Claude Code は要りませんが、この対話セットアップには必要です）。手元に入れない場合は、上記の項目を config.json に直接記入してください。';
  }
  // 独自コマンド（tmux.claudeCommand）が見つからないだけの場合、Claude Code 自体は入って
  // いることが多く、インストールを勧めても解決しない（勧めても生えるのは claude で、
  // 設定した独自コマンドは直らない）。設定の見直しは要件側の hint に出ているので、
  // ここでは「その項目を解消してから」とだけ伝える。
  // 「残りの項目」とは書かない。claude だけが未充足のときは残りが無く、setup 実行を促す
  // 迂回になるため、どちらのケースでも成立する言い方にする。
  return claudeMissing.usesDefaultCommand
    ? `まず Claude Code をインストールしてください（例: ${CLAUDE_INSTALL_COMMAND}）。導入後、Claude Code でこのリポジトリを開き \`/vk-orchestrator-setup\` を実行すると、ほかに未充足の項目があれば対話でまとめて設定できます。`
    : 'まず上記の「Claude Code コマンド導入」を解消してください。そのうえで Claude Code でこのリポジトリを開き `/vk-orchestrator-setup` を実行すると、ほかに未充足の項目があれば対話でまとめて設定できます。';
}

/**
 * 人間可読の診断レポート（✅/❌/⚠️ と次にやること）を組み立てる。
 * @param {ReturnType<typeof runDoctor>} requirements
 * @param {ReturnType<typeof summarizeDoctor>} [summary]
 * @returns {string}
 */
export function formatDoctorReport(requirements, summary = summarizeDoctor(requirements)) {
  const lines = [];
  lines.push('VK Orchestrator セットアップ診断');
  lines.push('');

  let currentGroup = null;
  for (const r of requirements) {
    if (r.group !== currentGroup) {
      currentGroup = r.group;
      lines.push(`[${currentGroup}]`);
    }
    const mark = r.ok ? '✅' : r.required ? '❌' : '⚠️';
    const kind = r.required ? '必須' : '任意';
    lines.push(`  ${mark} ${r.label}（${kind}） … ${r.current}`);
  }

  // 表示のために値を加工した項目があれば、**未充足の有無にかかわらず** 一度だけ警告する
  // （issue #252）。加工が許可オーナー一覧の側だけで起きた場合、必須項目はすべて充足して
  // 終わるため要件ごとの hint はどこにも出ず、正体不明の注記だけが残って「何をすればよいか」
  // が一切書かれない状態になる。制御文字の混入は改竄の痕跡でありうるので、✅ で終わるとき
  // こそ次の一手を示す必要がある。
  //
  // 位置は一覧の直後（締めのブロックの前）。「上の一覧は表示だけ加工されている」という
  // 一覧の読み方についての注意なので、一覧の直後に置くのが情報の順序として自然で、
  // ✅／❌ のどちらでも同じ位置に出せる（条件で位置が動かない）。
  // 固定文言・行頭インデント無しなので、要件行（`  ✅ …`）と混ざることもない。
  // 文言は `up` の未充足警告と共有する（formatDisplaySanitizedWarning）。
  const sanitizedWarning = formatDisplaySanitizedWarning(requirements);
  const hasDisplaySanitized = sanitizedWarning !== '';
  if (hasDisplaySanitized) {
    lines.push('');
    lines.push(...sanitizedWarning.split('\n'));
  }

  lines.push('');
  if (summary.allRequiredOk) {
    lines.push(`✅ 必須項目はすべて充足しています（${summary.requiredOkCount}/${summary.requiredCount}）。`);
    // 全充足のときはここがレポートの最終行になる。端末では画面下端に残った文字列が最後の
    // 印象になるので、⚠️ を出しておきながら締めを全面 GO にすると、警告が「起動していいですよ」で
    // 上書きされてしまう（注記が出るのは値が細工されている可能性を含む状況）。
    //
    // 但し書きを括弧で後から足すと「起動できます」と「起動してください」が同居して、
    // 読み終えてから前提に戻される。条件を先に置いた 1 文へ丸ごと差し替える。
    // 注記が無いときは従来の文言のまま 1 文字も変えない。
    lines.push(
      hasDisplaySanitized
        ? '   上の ⚠️ を確認してから `vk-orchestrator up` で起動してください。'
        : '   `vk-orchestrator up` で起動できます。',
    );
  } else {
    lines.push(`❌ 未充足の必須項目が ${summary.missingRequired.length} 件あります。次のことをしてください:`);
    for (const r of summary.missingRequired) {
      lines.push(`  - ${r.label}: ${r.hint}`);
    }
    lines.push('');
    // requirements も渡す。任意（⚠️）に落ちた claude は missingRequired に入らないため、
    // summary だけでは別マシン構成の締めを選べない。
    lines.push(formatSetupEntryGuidance(summary, requirements));
  }

  return lines.join('\n');
}
