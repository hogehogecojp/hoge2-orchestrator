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

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { execFileSync as realExecFileSync } from 'child_process';
import {
  resolveConfigPath,
  loadUnifiedConfig,
  getQueueBackend,
  resolveVkTerminalsDir as realResolveVkTerminalsDir,
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
import { stripControlChars } from './engine/build-command.js';
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
 * 表示値から ANSI エスケープ・制御文字・行区切り文字（U+2028 / U+2029）を落とす
 * （長さは変えない）。
 *
 * sanitizeReportValue（外部コマンド出力用）と sanitizeConfigDisplayValue（設定値用）の
 * 共通部分。両者の違いは「先頭行に切るか」「長さを制限するか」だけなので、除去ロジックは
 * ここ 1 か所に持つ。
 *
 * ANSI CSI シーケンスは ESC ごと先に落とす。ESC 単体は次段の stripControlChars で消えるが、
 * 先に消さないと `[0m` のような残骸が表示に残って値が読みにくくなるため。ESC を伴わない
 * `[0m` のような文字列は消えないので、正当な設定値を削ってしまうことはない。
 * @param {*} value
 * @returns {string} ANSI と制御文字を除いた文字列
 */
function stripAnsiAndControlChars(value) {
  const withoutAnsi = String(value ?? '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ''); // ANSI CSI シーケンス（ESC 自体は次段で落ちる）
  // 残った C0/C1 制御文字は共通ヘルパで落とす（文字クラスを複製しない）。
  // U+2028 / U+2029 は C0/C1 の範囲外なので stripControlChars では落ちない。端末では行が
  // 割れないが、CSS はこの 2 文字を強制改行として扱うため、診断結果を GitHub の issue へ
  // 貼るとブラウザ上では行が割れ、偽の要件行が独立して見えてしまう（診断結果を issue へ
  // 貼る運用があるので現実的な経路）。表示経路を守るため、C0/C1 とは別にここで落とす。
  return stripControlChars(withoutAnsi).replace(/[\u2028\u2029]/g, '');
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
 * @param {*} value 設定ファイルから読んだ値
 * @returns {string} 表示に使える値（空なら空文字）
 */
function sanitizeConfigDisplayValue(value) {
  return stripAnsiAndControlChars(value).trim();
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
  requirements.push({
    id: 'vk-terminals',
    group: '前提',
    label: 'VK Terminals 導入',
    required: !tmuxMode,
    target: 'external',
    ok: vkTerminalsOk,
    // config 由来ではなく require.resolve のパスだが、外から来る表示値であることは同じなので、
    // 行崩しの経路を残さないよう同じ整形（長さ制限なし）を通す。パスは長くなるのが正常なため
    // sanitizeReportValue（64 文字）は使わない。
    current: vkTerminalsOk ? sanitizeConfigDisplayValue(vkTerminalsDir) : '未導入',
    hint: tmuxMode
      ? 'tmux モードでは VK Terminals(GUI) は不要です（vk-terminals モードに切り替えるときだけ `npm run setup:terminals` で導入してください）。'
      : '`npm run setup:terminals` で導入してください（GUI は macOS 専用。非対応 OS では別マシンの VK Terminals API を使う構成を利用）。',
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

  // Claude Code コマンド導入（両モードで必須）
  //
  // オーケストレーターの中核は「ペインで Claude Code を起動して作業させる」ことなので、
  // claude コマンドが無いとペインは開いても即終了し、タスクが一切進まない。それにも関わらず
  // 従来はこの要件自体が無く、doctor も `up` も何も案内しないまま詰んでいた（issue #247）。
  //
  // 自動インストールはしない。doctor は副作用の無いローカル高速判定に限定し、外部依存
  // （Node.js / tmux / gh など）はすべて「検知して hint で案内」に統一しているため。
  const claudeCommand = resolveClaudeCommandName(tmuxMode, cfg);
  // 検査対象は実行に渡すため切り詰めていないので、レポートへ載せるときだけ 1 行・長さ制限へ整える。
  const claudeCommandLabel = sanitizeReportValue(claudeCommand);
  // 素の claude を見ているか、利用者が設定した独自コマンドを見ているかで案内すべき行動が変わる。
  const usesDefaultClaudeCommand = claudeCommand === DEFAULT_CLAUDE_COMMAND;
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
    required: true,
    target: 'external',
    ok: claudeOk,
    // 独自コマンド運用のときだけコマンド名を添える。何を見て ❌／✅ になったのかが分からないと
    // 「claude は入っているのに ❌ になる」「自分の設定が見られているのか分からない」と混乱するため。
    // 既定の claude しか使っていない大多数には、余計な情報を出さない。
    current: claudeOk
      ? (usesDefaultClaudeCommand ? claudeVersion : `${claudeVersion}（コマンド: ${claudeCommandLabel}）`)
      : `未導入（コマンド: ${claudeCommandLabel}）`,
    // 独自コマンドが見つからないときに「npm install -g @anthropic-ai/claude-code してください」を
    // 先頭に置くと、それを実行しても生えるのは claude で、設定した独自コマンドは直らない。
    // 一番効く行動（PATH 確認 → 設定値の見直し）を先に出す。
    // 2 分岐とも「何が見つからないか → 打つ手」の型で揃える（レポート末尾の締めは
    // 単独で読まれるので自己完結させ、重複はコマンド文字列だけに留める）。
    hint: usesDefaultClaudeCommand
      ? `\`claude\` コマンドが見つかりません。${CLAUDE_INSTALL_COMMAND} でインストールし、\`claude --version\` が動くことを確認してください（インストール済みなのに未導入と出る場合は、シェルを開き直して PATH を通し直してください）。`
      : `ペイン起動に使うコマンド "${claudeCommandLabel}" が見つかりません。\`${claudeCommandLabel} --version\` が動くか確認してください。動かない場合は config.json の tmux.claudeCommand（環境変数 VK_TMUX_CLAUDE_CMD）の値を見直すか、素の Claude Code を使うなら設定を外して ${CLAUDE_INSTALL_COMMAND} でインストールしてください。`,
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
  requirements.push({
    id: 'vk-agents-version',
    group: '前提',
    label: '展開済みエージェント定義の版',
    required: false,
    target: 'manifest',
    ok: agentsVersionView.ok,
    // 版の文字列は同梱ファイルと ~/.claude の記録ファイル（どちらも手編集できる JSON）由来で、
    // config.json と同じく利用者の手元のファイルから来る表示値なので同じ整形を通す。
    current: sanitizeConfigDisplayValue(agentsVersionView.current),
    hint: sanitizeConfigDisplayValue(agentsVersionView.hint),
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
  // 使い続け、表示にだけ ownerDisplay を使う。制御文字を除去した値で比較すると
  // "vek\ntor-inc" が "vektor-inc" に化けて許可ゲートを通ってしまう（fail-open）ため。
  const ownerSet = hasNonEmpty(cfg, 'github.owner');
  const owner = ownerSet ? String(getPath(cfg, 'github.owner')).trim() : DEFAULT_OWNER;
  const ownerDisplay = sanitizeConfigDisplayValue(owner);
  requirements.push({
    id: 'github.owner',
    group: 'GitHub',
    label: 'GitHub オーナー（github.owner）',
    required: githubMode,
    target: 'A',
    ok: ownerSet,
    current: ownerSet ? ownerDisplay : `（未設定・既定 ${DEFAULT_OWNER}）`,
    hint: 'config.json の github.owner に自分のユーザー／組織名を設定してください（既定 vektor-inc のままだと他組織のキューを見に行きます）。',
  });

  // 2-2 github.repo（GitHub モードのみ。既定 task-queue で可）
  const repoSet = hasNonEmpty(cfg, 'github.repo');
  const repo = repoSet ? String(getPath(cfg, 'github.repo')).trim() : DEFAULT_REPO;
  requirements.push({
    id: 'github.repo',
    group: 'GitHub',
    label: 'タスク登録リポジトリ名（github.repo）',
    required: githubMode,
    target: 'A',
    // 既定 task-queue も有効な値なので、名前が解決できていれば ok（実在確認はネットワーク検知のため行わない）。
    ok: true,
    current: repoSet ? sanitizeConfigDisplayValue(repo) : `${DEFAULT_REPO}（既定）`,
    hint: 'config.json の github.repo に task-queue の Issue を登録するリポジトリ名を設定してください（既定 task-queue で可）。',
  });

  // 2-5 orchestrator.assigneeFilter（GitHub モードで必須。空＝一切取り込まない）
  const assigneeSet = hasNonEmpty(cfg, 'orchestrator.assigneeFilter');
  requirements.push({
    id: 'orchestrator.assigneeFilter',
    group: 'GitHub',
    label: '担当者フィルタ（orchestrator.assigneeFilter）',
    required: githubMode,
    target: 'A',
    ok: assigneeSet,
    // ok は hasNonEmpty（生の値）で判定済み。ここは表示だけを整える。
    current: assigneeSet
      ? sanitizeConfigDisplayValue(getPath(cfg, 'orchestrator.assigneeFilter'))
      : '（未設定・一切取り込まない）',
    hint: 'config.json の orchestrator.assigneeFilter に GitHub ログイン名（自分だけなら自分の login）か all を設定してください（空＝一切取り込まない安全側既定）。',
  });

  // 3-1 org.allowed_owners に owner を含める（両モードで必須。硬ゲート通過用）
  //
  // 一致判定は生の owner と readAllowedOwners の生の値で行う（サニタイズ済みの値で比較すると
  // 制御文字入りの owner が正規化されて許可ゲートを通る＝ fail-open になる）。
  // label / hint にも owner を埋め込んでおり、未充足時は `- ${label}: ${hint}` の形で
  // レポートに出るため、current と同じく表示は必ずサニタイズ済みの値を使う。
  const allowedOwners = readAllowedOwners(canonicalConfigPath);
  const allowedOwnersOk = allowedOwners.includes(owner);
  requirements.push({
    id: 'org.allowed_owners',
    group: 'vk-agents',
    label: `org.allowed_owners に "${ownerDisplay}" を含む`,
    required: true,
    target: 'C',
    ok: allowedOwnersOk,
    // 一覧は項目数が多くなるのが正常なので、長さでは切らない（途中で切ると
    // 「自分のオーナー名が入っているのに見えない」という別の混乱になる）。
    current: allowedOwners.length ? sanitizeConfigDisplayValue(allowedOwners.join(', ')) : '（未設定）',
    hint: `vk-agents 正本 config の org.allowed_owners に "${ownerDisplay}" を追加してください（値を A の config.json に入れてから \`vk-orchestrator apply\` で投影。未追加だと staff 系スキル／vk-kore の硬ゲートで弾かれます）。`,
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
 * doctor のレポートと `up` の警告で判断と文言を一致させるため、ここを唯一の正にする。
 * @param {ReturnType<typeof summarizeDoctor>} summary
 * @returns {string}
 */
export function formatSetupEntryGuidance(summary) {
  const claudeMissing = summary.missingRequired.find((r) => r.id === 'claude');
  if (!claudeMissing) {
    return 'Claude Code でこのリポジトリを開き `/vk-orchestrator-setup` を実行すると、対話でまとめてセットアップできます。';
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

  lines.push('');
  if (summary.allRequiredOk) {
    lines.push(`✅ 必須項目はすべて充足しています（${summary.requiredOkCount}/${summary.requiredCount}）。`);
    lines.push('   `vk-orchestrator up` で起動できます。');
  } else {
    lines.push(`❌ 未充足の必須項目が ${summary.missingRequired.length} 件あります。次のことをしてください:`);
    for (const r of summary.missingRequired) {
      lines.push(`  - ${r.label}: ${r.hint}`);
    }
    lines.push('');
    lines.push(formatSetupEntryGuidance(summary));
  }

  return lines.join('\n');
}
