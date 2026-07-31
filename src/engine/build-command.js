// -------------------------------------------------------
// タスク着手時にペインへ投入するコマンド（プロンプト）の組み立てと、
// wp-env ポート割り当て・テンプレート展開の純粋関数群。
//
// engine/index.js は import しただけで orchestrator 本体を自走させる（副作用実行）ため、
// テストから安全に import できるよう、副作用の無いこれらの関数はこのモジュールへ分離する。
// engine/index.js からは import して利用しつつ再 export もするので、index.js からも参照できる。
//
// いずれの関数も taskConfig を DI 可能にしており（既定は getTaskConfig()）、
// config.json / 環境変数に依存せずユニットテストできる。
// -------------------------------------------------------

import net from 'node:net';

import { getTaskConfig } from '../config.js';

const DEFAULT_PORT_PROBE_HOST = '127.0.0.1';
export const DEFAULT_WP_ENV_PORT_SCAN_LIMIT = 128;
const RESERVED_WP_ENV_PORTS = new Set([8888, 8889]);

// -------------------------------------------------------
// 表示不能な制御文字の除去（多層防御用の純粋ヘルパー）。
//
// 除去対象は C0(\x00-\x1f)・DEL(\x7f)・C1(\x80-\x9f)。これらがタイトル文字列に
// 混じると、OSC 0 でペインタイトルを送る際にシーケンスを途中で壊したり、8bit C1 を
// OSC/ST として解釈する端末でブレイクアウトを許してしまう。外部由来（GitHub issue
// タイトル等）の文字列を扱うため、送信前に一段落として正規化する。
//
// terminals/index.js の buildPaneTitleSequence と同一の正規表現を共有し、除去ロジックを
// 2 箇所に複製しないための単一の出所とする（DRY）。
//
// @param {string} str 正規化したい文字列（文字列以外は String() 化する）
// @returns {string} 制御文字を除去した文字列
// -------------------------------------------------------
export function stripControlChars(str) {
  // eslint-disable-next-line no-control-regex
  return String(str).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

/**
 * 表示値から ANSI エスケープ・制御文字・行区切り文字（U+2028 / U+2029）を落とす
 * （長さは変えない）。
 *
 * doctor のレポート（sanitizeReportValue / sanitizeConfigDisplayValue の共通部分）と、
 * `up` が出す tmux セッション名の表示で共有する。どちらも「外部由来の値をコンソールへ出し、
 * その出力が GitHub の issue へ貼られる」経路なので、線引きを 2 か所に持たない（issue #253）。
 *
 * ANSI CSI シーケンスは ESC ごと先に落とす。ESC 単体は次段の stripControlChars で消えるが、
 * 先に消さないと `[0m` のような残骸が表示に残って値が読みにくくなるため。ESC を伴わない
 * `[0m` のような文字列は消えないので、正当な設定値を削ってしまうことはない。
 *
 * U+2028 / U+2029 は C0/C1 の範囲外なので stripControlChars では落ちない。端末では行が
 * 割れないが、CSS はこの 2 文字を強制改行として扱うため、診断結果やログを GitHub の issue へ
 * 貼るとブラウザ上では行が割れ、偽の行が独立して見えてしまう（issue へ貼る運用があるので
 * 現実的な経路）。表示経路を守るため、C0/C1 とは別にここで落とす。
 * @param {*} value 表示したい値
 * @returns {string} ANSI と制御文字・行区切り文字を除いた文字列
 */
export function stripAnsiAndControlChars(value) {
  const withoutAnsi = String(value ?? '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ''); // ANSI CSI シーケンス（ESC 自体は次段で落ちる）
  // 残った C0/C1 制御文字は stripControlChars で落とす（文字クラスを複製しない）。
  return stripControlChars(withoutAnsi).replace(/[\u2028\u2029]/g, '');
}

/**
 * 実行ファイル名・パス・tmux セッション名として正常な文字だけで構成された値かを判定する
 * （許可リスト。**案内文の組み立て専用**で、実行してよいかの判定ではない）。
 *
 * 英数字と `. _ - / + : @ =` のみを安全とみなす。実行ファイル名・パス・セッション名として
 * 現実に必要な文字はこの範囲に収まり、シェルで意味を持つ文字（`` ` `` `$` `(` `)` `;` `&`
 * `|` `<` `>` `*` `?` `!` `~` `#` `'` `"` `\` `{` `}` `[` `]`・空白・制御文字）はすべて
 * 範囲外になる。空文字も不許可（`+` は 1 文字以上）なので、値が取れないときは不安全側へ
 * 倒れる（fail-close）。
 *
 * **禁止文字を並べる方式（ブラックリスト）にはしない。** シェルの特殊文字はシェルの種類や
 * 文脈で増えるため、列挙は必ず取りこぼす。「安全と分かっている文字以外は全部不安全」に
 * しておけば、想定外の文字が来ても危険側へは倒れない。ASCII 以外（`~/bin/claude` の `~` や
 * 和文を含むパス）も不安全側に落ちるが、それは「案内文にコマンド行を出さない」だけで
 * 動作は妨げないので、案内の文言では原因を断定しない（issue #253）。
 *
 * 用途は「案内文へ**そのまま貼れるコマンド行**として値を埋めてよいか」の判定に限る。
 * 設定ファイル由来の値をコマンド行へ埋めると、細工された設定を含むリポジトリを clone した
 * 人が案内どおりに貼った時点で意図しないコマンドが動く（issue #253）。
 *
 * **「この判定を通らない＝実行されない」ではない。** 値の実行経路（doctor の
 * execFileSync）で防げるのは値に含まれるシェルのメタ文字の解釈だけで、**値が指す実行
 * ファイルそのものは動く**。さらに tmux ペインの起動は terminals/backend-tmux.js が
 * `sh -c <claudeCommand>` へ渡す設計なので、そちらはシェルを通る。この関数は表示経路を
 * 守るためのもので、実行経路の安全性を保証するものではない。
 * @param {*} value 判定する値（設定ファイル由来の実行ファイル名／パス／セッション名を想定）
 * @returns {boolean} コマンド行へ埋めても安全な文字だけで構成されていれば true
 */
export function isShellSafeCommandForDisplay(value) {
  return /^[A-Za-z0-9._\-/+:@=]+$/.test(String(value ?? ''));
}

// -------------------------------------------------------
// GitHub issue URL の抽出
// -------------------------------------------------------
export function extractGitHubIssueUrl(text) {
  if (!text) return null;
  const match = text.match(
    /https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/issues\/(\d+)/
  );
  if (!match) return null;
  return { url: match[0], owner: match[1], repo: match[2], number: Number(match[3]) };
}

// -------------------------------------------------------
// ペインヘッダーに表示するタイトル・リンクの組み立て。
//
// task-queue に複製したメタ issue ではなく、元の作業対象リポジトリの issue の
// タイトル・リンクを表示するための純粋関数（issue #23）。
// - metaIssue:      タスク登録リポジトリ側のメタ issue（`{ number, title, html_url }`）
// - resolvedTarget: 元の作業対象 issue が解決できたときのみ `{ number, title, url }`。
//                   解決できない汎用タスクや取得失敗時は null を渡す。
// resolvedTarget があればそれを、無ければ従来どおりメタ issue を表示対象にする。
//
// 返す url は表示（リンク）だけでなく、**ペインの identity** としても使う。state に控えた URL と
// ペインの apiUrl を突き合わせて「この termId は今もこのタスクのペインか」を判定するため
// （#263、src/engine/pane-identity.js）。そのため url はタスクごとに一意である必要がある。
// @returns {{ titleText: string, url: string }}
// -------------------------------------------------------
export function buildPaneTitle(metaIssue, resolvedTarget) {
  // titleText は外部由来（issue タイトル）を含むため制御文字を除去して正規化する
  // （多層防御。URL 側は github.com 由来でスキーム検証済みのため触らない）。
  if (resolvedTarget) {
    return {
      titleText: stripControlChars(`#${resolvedTarget.number} ${resolvedTarget.title}`),
      // 元 issue の URL に、メタ issue 番号のフラグメントを足してタスク一意にする。
      //
      // なぜ必要か: resolveTarget() はメタ issue 本文から元 issue の URL を拾うだけで排他が無く、
      // 同じ元 issue を指すメタ issue は複数作られうる（失敗タスクの再登録・作業分割）。
      // 元 issue の URL をそのまま使うと、その 2 タスクのペインでヘッダー URL が同値になり、
      // termId の掴み違いが起きたときにペイン照合が「一致した」と誤答する（#263）。
      //
      // 表示への影響: フラグメントなので、クリック時に開くページは元 issue のままで変わらない
      // （存在しないアンカーはブラウザに無視され、ページ先頭が表示される）。VK Terminals 側も
      // 受け取った URL を new URL() で検証するだけで正規化せずそのまま保持するため、
      // apiUrl として往復してもフラグメントは落ちない（main.js の validateUrlField）。
      //
      // **消さないこと。** 「元 issue へ飛ぶだけなら不要な文字列」に見えるが、これを外すと
      // 上記の誤判定が復活し、別タスクのペインへマージ通知や差し戻し指示が届く。
      url: `${resolvedTarget.url}#vk-task-${metaIssue.number}`,
    };
  }
  // メタ issue へのリンクは元々タスク単位で一意なので、フラグメントは足さない。
  return {
    titleText: stripControlChars(`#${metaIssue.number} ${metaIssue.title}`),
    url: metaIssue.html_url,
  };
}

// -------------------------------------------------------
// 実 OS レベルのポート空き確認。テストでは assignWpEnvPort の options.isPortAvailable で
// スタブを注入し、この関数へ到達しないようにする。
// probe 後から wp-env 起動までの間に他プロセスへポートを奪われる TOCTOU は原理的に残る。
// その場合は wp-env 自身の起動失敗として顕在化させ、ここでは事前スクリーニングに徹する。
// -------------------------------------------------------
export function isPortAvailable(port, host = DEFAULT_PORT_PROBE_HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const done = (available) => {
      if (settled) return;
      settled = true;
      resolve(available);
    };

    server.once('error', () => done(false));
    server.once('listening', () => {
      server.close(() => done(true));
    });
    try {
      server.listen(port, host);
    } catch {
      done(false);
    }
  });
}

function normalizePortSet(ports = []) {
  const normalized = new Set();
  for (const port of ports ?? []) {
    const n = Number(port);
    if (Number.isInteger(n) && n > 0) normalized.add(n);
  }
  return normalized;
}

function isReservedPair(port, reservedPorts) {
  return (
    RESERVED_WP_ENV_PORTS.has(port) ||
    RESERVED_WP_ENV_PORTS.has(port + 1) ||
    reservedPorts.has(port) ||
    reservedPorts.has(port + 1)
  );
}

// state.json の issue レコード群から、他アクティブタスクが確保済みの wp-env ポート集合を作る。
// wp-env は wpPort と testsPort(wpPort+1) のペアを使うため、両方を予約済みに含める。
// 現在起動しようとしている issue 自身の古いレコードは除外し、再開時の自己衝突を避ける。
// -------------------------------------------------------
export function collectReservedWpEnvPorts(taskRecords = {}, currentIssueNumber = null) {
  const reserved = new Set();
  const currentKey = currentIssueNumber == null ? null : String(currentIssueNumber);

  for (const [issueNumber, record] of Object.entries(taskRecords ?? {})) {
    if (currentKey !== null && String(issueNumber) === currentKey) continue;
    const wpPort = Number(record?.wpPort);
    if (!Number.isInteger(wpPort) || wpPort <= 0) continue;
    reserved.add(wpPort);
    reserved.add(wpPort + 1);
  }

  return reserved;
}

// ターミナルID → wp-env ポート割り当て（8888/8889 は禁止）
// terminal 1 → portBase、terminal 2 → portBase+portStride …を探索起点にし、
// 起点から portStride 刻みで wpPort/testsPort の空きペアを前方走査する。
// 起点ペアが空いていれば従来どおり同一ポートを返す（後方互換）。
// -------------------------------------------------------
export async function assignWpEnvPort(termId, taskConfig = getTaskConfig(), options = {}) {
  const base = Number(taskConfig.portBase);
  const stride = Number(taskConfig.portStride);
  const term = Number(termId);
  if (!Number.isInteger(base) || base <= 0 || !Number.isInteger(stride) || stride <= 0 || !Number.isInteger(term) || term <= 0) {
    throw new Error(`wp-env ポート割り当て設定が不正です (termId=${termId}, portBase=${taskConfig.portBase}, portStride=${taskConfig.portStride})`);
  }

  const startPort = base + (term - 1) * stride;
  const maxScanAttempts = options.maxScanAttempts ?? DEFAULT_WP_ENV_PORT_SCAN_LIMIT;
  if (!Number.isInteger(maxScanAttempts) || maxScanAttempts <= 0) {
    throw new Error(`wp-env ポート探索上限が不正です (maxScanAttempts=${maxScanAttempts})`);
  }

  const probe = options.isPortAvailable ?? isPortAvailable;
  const host = options.host ?? DEFAULT_PORT_PROBE_HOST;
  const reservedPorts = normalizePortSet(options.reservedPorts);

  for (let attempt = 0; attempt < maxScanAttempts; attempt += 1) {
    const port = startPort + attempt * stride;
    if (isReservedPair(port, reservedPorts)) continue;

    const [wpAvailable, testsAvailable] = await Promise.all([
      probe(port, host),
      probe(port + 1, host),
    ]);
    if (wpAvailable && testsAvailable) return port;
  }

  const lastPort = startPort + (maxScanAttempts - 1) * stride;
  throw new Error(
    `wp-env の空きポートペアが見つかりません (start=${startPort}, last=${lastPort}, stride=${stride}, attempts=${maxScanAttempts})`
  );
}

// -------------------------------------------------------
// コマンドテンプレートのプレースホルダ展開。
// `{issueUrl}` / `{wpPort}` などの `{name}` を vars[name] で置換する。
// - vars に値がある（null/undefined でない）キーだけを置換する。
// - 未知プレースホルダ・値が無い（null/undefined）プレースホルダは元の文字列
//   （例 `{wpPort}`）のまま残す（例外を投げない）。これにより wp-env 無効時に
//   wpPort が null でも展開が壊れない。
// -------------------------------------------------------
export function expandTemplate(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => {
    const val = vars[key];
    if (val === undefined || val === null) return match;
    return String(val);
  });
}

function normalizeCommandWhitespace(command) {
  return String(command).replace(/\s+/g, ' ').trim();
}

function removeDisabledWpPortToken(command, wpPort) {
  if (wpPort !== null && wpPort !== undefined) return normalizeCommandWhitespace(command);
  return String(command)
    .split(/\s+/)
    .filter((token) => {
      if (!token) return false;
      if (!token.includes('{wpPort}')) return true;
      return /\{\w+\}/.test(token.replaceAll('{wpPort}', ''));
    })
    .join(' ')
    .trim();
}

function assertNoUnexpandedPlaceholders(command) {
  const placeholders = [...String(command).matchAll(/\{\w+\}/g)].map(match => match[0]);
  if (placeholders.length === 0) return;
  throw new Error(
    `コマンドテンプレートに未展開プレースホルダが残っています: ${[...new Set(placeholders)].join(', ')}`
  );
}

// -------------------------------------------------------
// Claudeへの送信コマンドを組み立てる。
// 戻り値には wpPort も含め、呼び出し側（recordTaskStart）が再計算・再読み込みせずに
// 同じ値を使い回せるようにする（二重計算・二重 config 読み込みの回避）。
// -------------------------------------------------------
export async function buildCommand(title, body, termId, taskConfig = getTaskConfig(), wpEnvEnabled, portOptions = {}) {
  const fullText = [title, body].filter(Boolean).join('\n\n');
  const targetIssue = extractGitHubIssueUrl(fullText);
  // wp-env 連携が有効か。呼び出し側（startTask）が対象リポの `.wp-env.json` 有無から
  // 解決した boolean を第5引数で渡す。無効のときはポート割り当て・{wpPort} 展開・
  // クリーンアップ用の wpPort 保存をすべて行わない。
  // 未指定（ユニットテスト等で第5引数を省略）のときは taskConfig.wpEnv.enabled で判定する
  // （null/undefined = 自動扱いで有効、明示 false のみ無効）— 後方互換のためのフォールバック。
  const enabled = typeof wpEnvEnabled === 'boolean'
    ? wpEnvEnabled
    : (taskConfig.wpEnv?.enabled !== false);

  if (targetIssue) {
    // wp-env 有効時のみポートを割り当てる。無効時は null（state に保存されず、
    // 既存の runPostMergeCleanup / snapshotWorktreePath が !saved.wpPort で早期 return）。
    const wpPort = enabled ? await assignWpEnvPort(termId, taskConfig, portOptions) : null;
    console.log(`  → GitHub issue URLを検出: ${targetIssue.url} → コマンドテンプレートを使用`);
    if (wpPort != null) {
      console.log(`  → wp-env ポート割り当て: ${wpPort} (testsPort=${wpPort + 1})`);
    } else {
      console.log(`  → wp-env 無効（.wp-env.json 未検出 / 設定で false）: ポート割り当てをスキップ`);
    }

    // コマンドテンプレートを展開する。既定テンプレートは
    // `/vk-kore {issueUrl} wp-env-port={wpPort} headless=1` になる。
    // wpPort が null（wp-env 無効）でも、{wpPort} を含まないテンプレートなら壊れない。
    const prompt = expandTemplate(taskConfig.commandTemplate, {
      issueUrl: targetIssue.url,
      wpPort,
    });
    const normalizedPrompt = removeDisabledWpPortToken(prompt, wpPort);
    assertNoUnexpandedPlaceholders(normalizedPrompt);
    return { prompt: normalizedPrompt, targetIssue, wpPort };
  }

  // 汎用タスク（GitHub issue URL なし）: テンプレートは使わず title + body をそのまま送る。
  let prompt = title;
  if (body && body.trim()) prompt += `\n\n${body.trim()}`;
  return { prompt, targetIssue: null, wpPort: null };
}
