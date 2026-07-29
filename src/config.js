// 設定の解決。
//
// VK Orchestrator は自分自身の設定を ~/.vk-orchestrator/config.json に持ち、
// 設定パネルは group.targetPath ごとに各ツールの永続 config へ直接読み書きする。
// 秘密情報(GITHUB_TOKEN)は gh auth login または .env に置く
// （config.json はコミット対象にしやすいよう秘密を含めない設計）。
//
// 設定の優先順位: 明示的な環境変数 / .env > config.json > gh auth token > 各既定値。
// （移設した engine 側は従来どおり process.env を読むため、applyConfigToEnv() で
//   config.json の値を process.env に流し込んでから engine を起動する。挙動は不変。）

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { resolve, dirname, join, basename } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
export const DEFAULT_VENDORED_VK_AGENTS_DIR = join(REPO_ROOT, 'vendor', 'vk-agents-public');
const DEFAULT_VK_TERMINALS_PORT = 13847;
export const DEFAULT_VK_TERMINALS_TIMEOUT_SCALE = 1;
// 最短の基準値 3000ms でも 300ms は確保でき、打ち切り時間が 0ms へ
// 丸められて全 API が即 abort する事故を防ぐ。
export const MIN_VK_TERMINALS_TIMEOUT_SCALE = 0.1;
// 60 倍なら最長のペイン作成でも 10 分。設定ミスで通信待ちが事実上無制限に
// なることを防ぎつつ、高レイテンシ環境向けの十分な調整幅を確保する。
export const MAX_VK_TERMINALS_TIMEOUT_SCALE = 60;
const VK_TERMINALS_CONFIG_TARGET_PATH = '~/.vk-terminals/config.json';
const VK_TERMINALS_SETTINGS_NOTE = 'VK Terminals 本体の設定ファイル（~/.vk-terminals/config.json）に直接保存され、VK Terminals が読み込みます。';
// VK Terminals 本体スキーマ由来の項目のうち、orchestrator の設定画面には
// 出したくないキーを列挙する。現状は本体スキーマの全項目を表示する。
const VK_TERMINALS_SCHEMA_HIDDEN_KEYS = [];

export const GITHUB_TOKEN_RESOLUTION_HELP = 'GitHub トークンを解決できません。gh CLI 未導入の場合は `brew install gh`（Ubuntu: `sudo apt install gh`）でインストールし、`gh auth login` で認証してください。';

// -------------------------------------------------------
// 汎用化に向けた設定セクションの既定値。
//
// これらは現時点で engine / github が「ハードコードしている値」をそのまま複製した
// ものであり、config.json に何も書かなければ getter は必ずこの既定値を返す
// （＝単体では挙動不変）。実際にこの既定値を engine / github の呼び出し箇所へ
// 反映するのは後続 sub-issue (#1〜#5) の仕事で、この issue では「枠」だけを用意する。
// -------------------------------------------------------

/**
 * task セクションの既定値。
 * vk-kore へ渡すコマンドテンプレートと wp-env ポート割り当ての基準値。
 */
export const DEFAULT_TASK = {
  // src/engine/index.js の `/vk-kore ${targetIssue.url} wp-env-port=${wpPort} headless=1` に対応。
  // {issueUrl} / {wpPort} は消費側で置換し、headless=1 は無人モードの正式トリガーとして渡す。
  commandTemplate: '/vk-kore {issueUrl} wp-env-port={wpPort} headless=1',
  // src/engine/index.js の assignWpEnvPort: 9100 + (termId-1)*2 に対応。
  portBase: 9100,
  portStride: 2,
  // wp-env 連携の ON/OFF。既定 null＝自動判定（タスク着手時に対象リポの `.wp-env.json`
  // 有無を見て決める。WordPress 案件なら ON、そうでなければ OFF）。config.json / 環境変数で
  // true / false を明示指定すると自動判定より優先する脱出ハッチになる。有効時はポート
  // 割り当て・{wpPort} 展開・マージ後クリーンアップを行い、無効時はそれらを一切行わず
  // {wpPort} を含まないテンプレートに差し替えることで vk-kore 以外のスキル／素のプロンプトも起動できる。
  wpEnv: { enabled: null },
};

/**
 * queue セクションの既定値。
 * キューの永続化先を切り替える。既定はローカル JSON（~/.task-queue/queue.json）。
 */
export const DEFAULT_QUEUE = {
  backend: 'local',
};

/**
 * protocol セクションの既定値。
 * decision-record の Status 行のトークン（decision-record.js に対応）。
 * 判定は単独 `Status:` 行のみに依存し、識別行マーカーは撤去済み（#9）。
 */
export const DEFAULT_PROTOCOL = {
  // src/engine/decision-record.js の STATUS_LINE_RE の `Status:` 接頭辞に対応。
  statusLinePrefix: 'Status:',
  statusTokens: {
    waitingInput: 'waiting-input',
    noAction: 'no-action',
    answered: 'answered',
  },
};

/**
 * labels セクションの既定値。
 * task-queue のステータス/優先度ラベルと、対象リポ側の作業中ラベル。
 * エージェントレビュー完了マーカー（ラベル名・SHA 接頭辞）は config 化せず、src/github/index.js の
 * 固定定数（REVIEW_PASSED_LABEL / REVIEW_PASSED_SHA_PREFIX）のまま運用する。
 */
export const DEFAULT_LABELS = {
  status: {
    awaitingApproval: 'status:awaiting-approval',
    ready: 'status:ready',
    inProgress: 'status:in-progress',
    waitingInput: 'status:waiting-input',
    waitingMerge: 'status:waiting-merge',
    done: 'status:done',
    failed: 'status:failed',
  },
  priority: {
    high: 'priority:high',
    medium: 'priority:medium',
    low: 'priority:low',
  },
  blocked: {
    conflict: 'blocked:conflict',
  },
  automerge: 'automerge',
  sequential: 'sequential',
  parallel: 'parallel',
  // 対象リポ側に付ける作業中ラベル（src/github/index.js）。既定は英語の 'working'。
  // config.json の labels.workingInProgress で任意名に上書き可能（GUI には出さない隠しオプション）。
  workingInProgress: 'working',
};

/**
 * プレーンオブジェクトどうしを再帰的にディープマージする内部ヘルパ。
 * override 側のプレーンオブジェクトのみ再帰し、配列・スカラ・null は置換する。
 * base は破壊せず新しいオブジェクトを返す。
 * @param {object} base 既定値
 * @param {object} override 上書き値（config.json 由来）
 * @returns {object}
 */
function deepMerge(base, override) {
  const isPlain = (v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isPlain(override)) return isPlain(base) ? { ...base } : base;
  const out = isPlain(base) ? { ...base } : {};
  for (const [key, val] of Object.entries(override)) {
    // プロトタイプ汚染の多層防御: 危険キーは絶対にマージしない。
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (isPlain(val) && isPlain(out[key])) {
      out[key] = deepMerge(out[key], val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * config.json 由来の override から「空とみなす値」を再帰的に除去する。
 *
 * VK Terminals(GUI) の設定パネルは汎用エディタで、保存時にディスクリプタ上の全項目を
 * 書き戻す。ユーザーが未入力の項目は空文字 / 空配列 / null として保存され、そのまま
 * deepMerge すると既定値（DEFAULT_TASK / DEFAULT_PROTOCOL / DEFAULT_LABELS）を空で
 * 上書きしてしまう（例: `labels.status: []`, `task.commandTemplate: ""`）。
 * これらを「未指定」とみなして取り除き、既定へフォールバックさせるための前処理。
 * false / 0 は有意な値として残す（enabled:false 等を潰さない）。
 * @param {*} v
 * @returns {*} 空を除去した値（全体が空なら undefined）
 */
function pruneEmpty(v) {
  if (v === null || v === undefined || v === '') return undefined;
  if (Array.isArray(v)) {
    const arr = v.map(pruneEmpty).filter((x) => x !== undefined);
    return arr.length ? arr : undefined;
  }
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      // deepMerge と同様にプロトタイプ汚染キーは扱わない。
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      const pv = pruneEmpty(val);
      if (pv !== undefined) out[k] = pv;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return v; // 非空の string / number(0 含む) / boolean(false 含む)
}

/**
 * config.json の探索順:
 *   1. 環境変数 VK_ORCHESTRATOR_CONFIG（明示指定）
 *   2. ~/.vk-orchestrator/config.json（ユーザー固有・推奨）
 *   3. <repo>/config.json（ローカル・.gitignore 対象）
 * @returns {string} 最初に見つかったパス（無ければ repo 直下のパスを返す）
 */
export function resolveConfigPath() {
  if (process.env.VK_ORCHESTRATOR_CONFIG) return process.env.VK_ORCHESTRATOR_CONFIG;
  const home = join(homedir(), '.vk-orchestrator', 'config.json');
  if (existsSync(home)) return home;
  return join(REPO_ROOT, 'config.json');
}

/**
 * 統合設定ファイルを読み込む。存在しなければ空オブジェクトを返す（全て既定/env に委ねる）。
 * @param {string} [path]
 * @returns {object}
 */
export function loadUnifiedConfig(path = resolveConfigPath()) {
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`[Config] 設定ファイルの読み込みに失敗しました (${path}): ${err.message}`);
  }
}

/**
 * config.json の値を process.env に反映する。
 * 既に定義済みの環境変数は上書きしない（env > config.json）。
 * @param {object} cfg loadUnifiedConfig() の戻り値
 */
export function applyConfigToEnv(cfg = {}) {
  const set = (key, val) => {
    if (val === undefined || val === null || val === '') return;
    if (process.env[key] !== undefined && process.env[key] !== '') return;
    process.env[key] = String(val);
  };
  const gh = cfg.github ?? {};
  // 後方互換のため github.token は引き続き読むが、新規設定では gh auth login を推奨する。
  // .env に GITHUB_TOKEN があればそちらが優先される（env/.env > config.json）。
  set('GITHUB_TOKEN', gh.token);
  set('GITHUB_OWNER', gh.owner);
  set('GITHUB_REPO', gh.repo);
  set('SOURCE_ORG', gh.sourceOrg);
  set('QUEUE_LABEL', gh.queueLabel);

  const o = cfg.orchestrator ?? {};
  set('POLL_INTERVAL_MS', o.pollIntervalMs);
  set('WATCHDOG_IDLE_MS', o.watchdogIdleMs);
  set('PANE_RESUME_MAX', o.paneResumeMax);
  set('CONFLICT_HANDBACK_MAX', o.conflictHandbackMax);
  set('REPLY_FORWARD_RETRY_MAX', o.replyForwardRetryMax);
  set('ASSIGNEE_FILTER', o.assigneeFilter);

  const vk = cfg.vkTerminals ?? {};
  // port は ~/.vk-terminals/config.json の `port` が正本のため env へは流さない。
  // host は現在 ~/.vk-terminals/config.json の apiHost が正本。
  // 旧 config.json(vkTerminals.host) を使っている環境だけ後方互換として env へ流す。
  set('VK_TERMINALS_HOST', vk.host);
  // getStates は約 2 秒間隔で呼ばれるため、API 呼び出しごとに統合 config.json を
  // 読み直さず、host と同じ config.json → env → 呼び出し時解決の流れに揃える。
  set('VK_TERMINALS_TIMEOUT_SCALE', vk.timeoutScale);

  const queue = cfg.queue ?? {};
  set('QUEUE_BACKEND', queue.backend);
}

/**
 * orchestrator 自身の旧配置 config.json をユーザー固有の正本へ移行する。
 *
 * 既に home 側の config.json がある場合は何もしない。旧配置のみ存在する初回だけ
 * コピーして、以後の loadUnifiedConfig() が home 側を読むようにする。
 * @param {{ repoRoot?: string, homeDir?: string, log?: (message:string)=>void }} [options]
 * @returns {{ migrated: boolean, sourcePath: string, targetPath: string }}
 */
export function migrateLegacyOrchestratorConfig(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const homeDir = options.homeDir ?? homedir();
  const log = options.log ?? console.log;
  const sourcePath = join(repoRoot, 'config.json');
  const targetPath = join(homeDir, '.vk-orchestrator', 'config.json');
  if (existsSync(targetPath) || !existsSync(sourcePath)) {
    return { migrated: false, sourcePath, targetPath };
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  try {
    // wx（排他生成）で check-then-act の TOCTOU を閉じる。併走プロセスが先に
    // 作成していた場合は EEXIST となり、既存の正本を上書きしない。
    writeFileSync(targetPath, readFileSync(sourcePath), { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') return { migrated: false, sourcePath, targetPath };
    throw err;
  }
  log(`[Config] 正本を ${targetPath} へ移行しました。今後リポジトリ直下 config.json は読まれません。削除して構いません。`);
  return { migrated: true, sourcePath, targetPath };
}

// vk-agents#291 で、メンバーの実行エンジン設定キーが `<スキル名>.engine` から
// `agents.engine.<エージェント定義名>` のマップ形式へ変わった（vk-agents 側は後方互換を持たない）。
// 旧→新の対応は本リポジトリだけが受け持つため、対応表をここに単一ソース化して
// 移行処理・退避対象キー一覧の両方から参照する。
const LEGACY_ENGINE_KEY_MAP = Object.freeze({
  'staff_wp_dev.engine': 'agents.engine.vk-wp-developer',
  'staff_review.engine': 'agents.engine.vk-ui-tester',
});

/** エンジン設定として受理する値（これ以外は投影せず、正本に残っていれば未設定へ正規化する）。 */
const ENGINE_SETTING_VALUES = Object.freeze(['claude', 'codex']);

/** 受理値の表示ラベル（descriptor の options は必ずここから組む）。 */
const ENGINE_VALUE_LABELS = Object.freeze({ claude: 'Claude', codex: 'Codex' });

/** GUI 保存値を vk-agents 正本 config へ投影するエンジン系キー（受理条件は共通）。 */
const ENGINE_SETTING_KEYS = Object.freeze([
  'agents.default_engine',
  'agents.engine.vk-wp-developer',
  'agents.engine.vk-ui-tester',
  'multi_repo_task.default_engine',
]);

const LEGACY_VK_AGENTS_GUI_KEYS = [
  'features.coderabbit',
  'features.coderabbit_ignore',
  // エンジン系キーは ENGINE_SETTING_KEYS から導出する（メンバーを増やすときの触り漏れを防ぐ）。
  ...ENGINE_SETTING_KEYS,
  // 旧エンジン設定キー（vk-agents#291 以前の形式）も退避対象に残す。旧 orchestrator config に
  // 残っていると up/apply の投影で正本を汚すため、いったん canonical へ移してから
  // migrateLegacyEngineKeys() で新キーへ変換し、旧キーは canonical にも残さない。
  ...Object.keys(LEGACY_ENGINE_KEY_MAP),
  'org.review_assets_repo',
];

/**
 * エンジン select の選択肢を組む。
 *
 * 受理値の列挙をハードコードせず ENGINE_SETTING_VALUES から生成し、
 * 「パネルに出るが投影されない」値のズレを構造的に防ぐ。
 * @param {string} unsetLabel 空値（未設定）の表示ラベル
 * @returns {{ value: string, label: string }[]}
 */
function engineSelectOptions(unsetLabel) {
  return [
    { value: '', label: unsetLabel },
    ...ENGINE_SETTING_VALUES.map((value) => ({ value, label: ENGINE_VALUE_LABELS[value] ?? value })),
  ];
}

/**
 * エンジン設定として受理できる値か（`claude` / `codex` のみ）。
 * @param {*} value
 * @returns {boolean}
 */
function isAcceptedEngineValue(value) {
  return ENGINE_SETTING_VALUES.includes(String(value ?? '').trim());
}

/**
 * 旧エンジン設定キーを新しい `agents.engine.<定義名>` 形式へ移し、旧キーを削除する。
 *
 * 対象オブジェクトを in-place で書き換える。判定は「キーの存在」ではなく
 * **新キーに受理できる値（`claude` / `codex`）が入っているか** で行う。
 * 設定パネルは「未設定」を空文字として保存し、config.example.json も空文字の新キーを持つため、
 * 存在だけで判定すると利用者が設定した旧キーの `codex` が黙って消える。
 * 新キーに受理できる値が無ければ旧キーの受理できる値を移し、旧キーは常に削除する
 * （旧キーの値が `claude` / `codex` 以外なら移さず捨てる）。
 * @param {object} config vk-agents 正本 config 相当のオブジェクト
 * @param {{ log?: (message: string) => void }} [options]
 * @returns {{ changed: boolean, migratedPaths: string[] }} changed=旧キーを削除・変換したか（＝書き込みが必要か）
 *   / migratedPaths=旧キーの値を引き継いだ新キーのパス
 */
function migrateLegacyEngineKeys(config, options = {}) {
  const result = { changed: false, migratedPaths: [] };
  if (!config || typeof config !== 'object' || Array.isArray(config)) return result;
  const details = [];
  for (const [legacyPath, nextPath] of Object.entries(LEGACY_ENGINE_KEY_MAP)) {
    if (!hasOwnPath(config, legacyPath)) continue;
    const legacyValue = String(getByPath(config, legacyPath) ?? '').trim();
    if (!isAcceptedEngineValue(getByPath(config, nextPath)) && isAcceptedEngineValue(legacyValue)) {
      setByPath(config, nextPath, legacyValue);
      result.migratedPaths.push(nextPath);
      details.push(`${legacyPath} → ${nextPath}=${legacyValue}`);
    } else {
      details.push(`${legacyPath}（値を破棄）`);
    }
    deleteLeafAndPruneParents(config, legacyPath);
  }
  if (details.length === 0) return result;
  options.log?.(`[Config] 旧エンジン設定キーを新形式へ移行しました: ${details.join(' / ')}`);
  result.changed = true;
  return result;
}

/**
 * 値が blank のエンジン設定キーだけを「未設定」へ畳む。
 *
 * 設定パネル（VK Terminals）はこのグループを正本 config へ直接書き、select の「未設定」を
 * キー削除ではなく空文字として保存するため、正本に `"vk-wp-developer": ""` が残り得る。
 * vk-agents のエンジン解決（rules/agent-launch.md「起動エンジンの解決」）は
 * 「キー未設定なら次の順へ」しか定義しておらず、空文字が共通既定へ進むのか即 Claude なのかが
 * 決まっていない。blank をキーごと落として「未設定」と同義にし、設定パネルの説明どおりの
 * フォールバックを保証する。設定パネル経由の値は cfg には現れないため、cfg の有無に関わらず
 * 正本側を見る。
 *
 * **落とすのは blank（`''` / `null` / `undefined` / 空白のみ）だけ**で、`gemini` や `Codex` の
 * ように受理できないが非空の値は保持する。ENGINE_SETTING_VALUES は vk-agents 側の知識の複製
 * なので、受理できない値をすべて消すと「vk-agents が対応した新エンジンを利用者が手書きしたのに、
 * vk-orchestrator が追随するまで `up` の度に黙って消える」「`Codex` の打ち間違いに気づけない」
 * という後退になる。投影ループの「受理できない値は無視して既存値を保持」とも揃える。
 *
 * 対象は ENGINE_SETTING_KEYS の 4 キーだけで、利用者が手で書いた
 * `agents.engine.vk-ux-designer` などには触らない。
 * @param {object} config vk-agents 正本 config 相当のオブジェクト
 * @returns {boolean} blank のキーを削除したか（＝書き込みが必要か）
 */
function normalizeEngineSettings(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  let changed = false;
  for (const key of ENGINE_SETTING_KEYS) {
    if (!hasOwnPath(config, key)) continue;
    if (!isBlankValue(getByPath(config, key))) continue;
    deleteLeafAndPruneParents(config, key);
    changed = true;
  }
  return changed;
}

/**
 * 「未設定」と同義とみなす blank な値か（`''` / `null` / `undefined` / 空白のみ）。
 * @param {*} value
 * @returns {boolean}
 */
function isBlankValue(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/**
 * leaf を削除し、空になった親オブジェクトを畳む。
 *
 * 正本 config は利用者が手で開くファイルなので、`agents: { engine: {} }` のような残骸を
 * 残して「何か設定されている」と誤読させないための後片付けを 1 か所に集約する。
 * 兄弟キーが残っている親は空でないため畳まれない。
 * @param {object} config 対象オブジェクト（in-place で書き換える）
 * @param {string} path ドット区切りのキーパス
 */
function deleteLeafAndPruneParents(config, path) {
  deleteByPath(config, path);
  pruneEmptyParents(config, path);
}

/**
 * 旧 orchestrator config に残った vk-agents GUI 設定を、vk-agents 正本 config へ初回移行する。
 *
 * #100 以降、設定パネルの Agents グループは ~/.vk-agents/config.json を直接編集する。
 * ただし旧 orchestrator config に同じ leaf が残っていると、up/apply の投影時に古い値で
 * 正本を上書きしてしまう。起動前に旧 leaf を削除し、正本が未設定の値だけを保全移送する。
 * @param {{ orchestratorConfigPath?: string, canonicalConfigPath?: string, homeDir?: string, log?: (message:string)=>void }} [options]
 * @returns {{ migrated: boolean, sourcePath: string, targetPath: string }}
 */
export function migrateLegacyVkAgentsGuiKeys(options = {}) {
  const homeDir = options.homeDir ?? homedir();
  const log = options.log ?? console.log;
  const sourcePath = options.orchestratorConfigPath ?? resolveConfigPath();

  let orchestratorConfig;
  try {
    orchestratorConfig = readJsonObject(sourcePath);
  } catch (err) {
    const targetPath = options.canonicalConfigPath ?? resolveVkAgentsCanonicalConfigPath({}, { homeDir });
    console.warn(`[Config] ${sourcePath} の読み込みに失敗したため vk-agents GUI 設定の移行をスキップしました: ${err.message}`);
    return { migrated: false, sourcePath, targetPath };
  }
  const targetPath = options.canonicalConfigPath ?? resolveVkAgentsCanonicalConfigPath(orchestratorConfig, { homeDir });

  const legacyKeys = LEGACY_VK_AGENTS_GUI_KEYS.filter((path) => hasOwnPath(orchestratorConfig, path));
  if (legacyKeys.length === 0) {
    return { migrated: false, sourcePath, targetPath };
  }

  let canonicalConfig;
  try {
    canonicalConfig = readJsonObject(targetPath);
  } catch (err) {
    console.warn(`[Config] ${targetPath} の読み込みに失敗したため vk-agents GUI 設定の移行をスキップしました: ${err.message}`);
    return { migrated: false, sourcePath, targetPath };
  }

  let canonicalChanged = false;
  const movedKeys = [];
  for (const path of legacyKeys) {
    const value = getByPath(orchestratorConfig, path);
    // blank（空文字・null）は「未設定」と同義なので正本へ書かない（正本に殻を増やさないため）。
    if (!hasOwnPath(canonicalConfig, path) && !isBlankValue(value)) {
      setByPath(canonicalConfig, path, value);
      movedKeys.push(path);
      canonicalChanged = true;
    }
    deleteLeafAndPruneParents(orchestratorConfig, path);
  }

  // 退避で旧エンジンキーが canonical へ入り得るため、書き込み前に新形式へ畳む。
  if (migrateLegacyEngineKeys(canonicalConfig, { log }).changed) canonicalChanged = true;

  if (canonicalChanged) {
    writeJsonAtomic(targetPath, canonicalConfig);
  }
  writeJsonAtomic(sourcePath, orchestratorConfig);
  // 実際に移送した項目が無い（正本に既に値がある・値が blank だけ）ケースもあるため、
  // 「移行しました」と言い切らず実態を出す。
  log(
    movedKeys.length > 0
      ? `[Config] 旧 vk-agents GUI 設定を ${sourcePath} から削除し、正本が未設定だった ${movedKeys.join(' / ')} を ${targetPath} へ移行しました。`
      : `[Config] 旧 vk-agents GUI 設定を ${sourcePath} から削除しました（${targetPath} へ移送した項目はありません）。`,
  );
  return { migrated: true, sourcePath, targetPath };
}

// -------------------------------------------------------
// GUI(Electron) の GPU 起動モード。
//
// VK Terminals(GUI) は Electron アプリで、Chromium が起動時に GPU を初期化する。
// macOS では HW アクセラがそのまま効くが、WSLg 等の Linux では GPU 初期化に失敗し
// `Exiting GPU process` / `kTransientFailure` などのエラーが多発する（利用可能な
// Vulkan ICD がソフトウェア実装のみで SwiftShader へフォールバックするため）。
// ここでは起動モードを env(VK_TERMINALS_GPU) / VK Terminals 本体 config(gpu) で選べるようにし、
// bin 側の spawn 引数と追加環境変数へ写像する。
// -------------------------------------------------------

/** GPU 起動モードの取りうる値。 */
export const GPU_MODES = ['off', 'default'];

/**
 * GPU 起動モードのプラットフォーム既定値を返す。
 * macOS は HW アクセラがそのまま効くためフラグ不要（'default'）。
 * それ以外（WSLg 等の Linux）は Chromium の GPU 初期化失敗によるエラーを抑制するため
 * 既定で GPU を無効化する（'off'）。
 * @param {string} [platform] process.platform 互換の値
 * @returns {'off'|'default'}
 */
export function defaultGpuMode(platform = process.platform) {
  return platform === 'darwin' ? 'default' : 'off';
}

// 未知の GPU モードを警告済みか（プロセス内で一度だけ通知するためのフラグ）。
let warnedUnknownGpuMode = false;

/**
 * GUI 起動時の GPU モードを解決する。
 * 優先順位: 環境変数 VK_TERMINALS_GPU > ~/.vk-terminals/config.json(gpu) > プラットフォーム既定。
 * 空文字・未知の値はプラットフォーム既定にフォールバックする。撤去した 'hardware' など
 * 非空の未知値が来た場合は、挙動変更に気づけるよう一度だけ警告する（起動は止めない）。
 * @param {{ homeDir?: string, configPath?: string }} [options]
 * @param {string} [platform] process.platform 互換の値
 * @returns {'off'|'default'}
 */
export function getVkTerminalsGpuMode(options = {}, platform = process.platform) {
  const configPath = options.configPath ?? join(options.homeDir ?? homedir(), '.vk-terminals', 'config.json');
  let rawValue = process.env.VK_TERMINALS_GPU;

  if (rawValue === undefined) {
    try {
      const config = readJsonObject(configPath);
      rawValue = config.gpu ?? '';
    } catch (err) {
      const fallback = defaultGpuMode(platform);
      console.warn(`[Config] ${configPath} の読み込みに失敗したため既定 GPU モード "${fallback}" を使用します: ${err.message}`);
      return fallback;
    }
  }

  const raw = String(rawValue ?? '').trim().toLowerCase();
  if (GPU_MODES.includes(raw)) return raw;
  // 空（＝自動）は正常。非空の未知値（例: 旧 'hardware'）だけ一度警告してフォールバック。
  const fallback = defaultGpuMode(platform);
  if (raw !== '' && !warnedUnknownGpuMode) {
    warnedUnknownGpuMode = true;
    console.warn(
      `[Config] 未知の GPU モード "${raw}" は無視し、既定 "${fallback}" を使用します` +
      `（有効値: ${GPU_MODES.join(' / ')}、空=自動）。`
    );
  }
  return fallback;
}

/**
 * GPU モードから、Electron(GUI) 起動時に渡すフラグと追加環境変数を組み立てる。
 *  - 'off'      : GPU を無効化してエラーログを抑制する（描画はソフトウェア。
 *                 ターミナル用途では実害なし）。
 *  - 'default'  : フラグ・env を足さず Chromium 任せ（macOS 既定 / 明示的に素の挙動）。
 *
 * ※ WSLg での HW アクセラは対応しない。Vulkan は HW ICD（dzn 等）が提供されず、
 *    OpenGL もターミナル用途では体感差が無く、WSLg では Mesa/Dawn 由来の警告も出る
 *    ため。GPU を使いたい場合は 'default'（Chromium 任せ）を選ぶ。
 * @param {string} mode 'off'|'default'
 * @returns {{ args: string[], env: Record<string,string> }}
 */
export function gpuLaunchOptions(mode) {
  switch (mode) {
    case 'off':
      return { args: ['--disable-gpu', '--disable-software-rasterizer'], env: {} };
    case 'default':
    default:
      return { args: [], env: {} };
  }
}

/** 実行面モードの取りうる値。 */
export const TERMINALS_MODES = ['vk-terminals', 'tmux'];

let warnedUnknownTerminalsMode = false;

// 通信待ち時間倍率の警告種別ごとの通知済みフラグ。
const warnedVkTerminalsTimeoutScale = {
  invalid: false,
  belowMin: false,
  aboveMax: false,
};

function warnVkTerminalsTimeoutScaleOnce(kind, message) {
  if (warnedVkTerminalsTimeoutScale[kind]) return;
  warnedVkTerminalsTimeoutScale[kind] = true;
  console.warn(message);
}

/**
 * VK Terminals API の通信待ち時間に掛ける倍率を解決する。
 * process.env は dotenv の読み込み後の値を反映できるよう、関数の呼び出し時に読む。
 * 未設定は 1、不正値は警告して 1、範囲外は警告して上下限へクランプする。
 * 0 と負数は倍率として成立せず設定ミスの可能性が高いため、下限へクランプせず不正値として扱う。
 * @returns {number} MIN_VK_TERMINALS_TIMEOUT_SCALE 以上 MAX_VK_TERMINALS_TIMEOUT_SCALE 以下の有限数
 */
export function resolveVkTerminalsTimeoutScale() {
  const rawValue = process.env.VK_TERMINALS_TIMEOUT_SCALE;
  if (rawValue === undefined) return DEFAULT_VK_TERMINALS_TIMEOUT_SCALE;

  const raw = String(rawValue).trim();
  if (raw === '') return DEFAULT_VK_TERMINALS_TIMEOUT_SCALE;

  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    if (parsed > MAX_VK_TERMINALS_TIMEOUT_SCALE) {
      warnVkTerminalsTimeoutScaleOnce(
        'aboveMax',
        `[Config] VK_TERMINALS_TIMEOUT_SCALE "${raw}" は上限を超えるため ` +
          `${MAX_VK_TERMINALS_TIMEOUT_SCALE} を使用します。`,
      );
      return MAX_VK_TERMINALS_TIMEOUT_SCALE;
    }
    if (parsed < MIN_VK_TERMINALS_TIMEOUT_SCALE) {
      warnVkTerminalsTimeoutScaleOnce(
        'belowMin',
        `[Config] VK_TERMINALS_TIMEOUT_SCALE "${raw}" は下限を下回るため ` +
          `${MIN_VK_TERMINALS_TIMEOUT_SCALE} を使用します。`,
      );
      return MIN_VK_TERMINALS_TIMEOUT_SCALE;
    }
    return parsed;
  }

  warnVkTerminalsTimeoutScaleOnce(
    'invalid',
    `[Config] 不正な VK_TERMINALS_TIMEOUT_SCALE "${raw}" は無視し、` +
      `既定 "${DEFAULT_VK_TERMINALS_TIMEOUT_SCALE}" を使用します。`,
  );
  return DEFAULT_VK_TERMINALS_TIMEOUT_SCALE;
}

/**
 * 実行面モードを解決する。優先順位: env VK_TERMINALS_MODE > config(terminals.mode) > 既定。
 * 未知値は既定 'vk-terminals' へフォールバックし、一度だけ警告する（起動は止めない）。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @returns {'vk-terminals'|'tmux'}
 */
export function resolveTerminalsMode(cfg = loadUnifiedConfig()) {
  const raw = String(process.env.VK_TERMINALS_MODE ?? cfg?.terminals?.mode ?? '').trim().toLowerCase();
  if (TERMINALS_MODES.includes(raw)) return raw;
  if (raw !== '' && !warnedUnknownTerminalsMode) {
    warnedUnknownTerminalsMode = true;
    console.warn(`[Config] 未知の実行面モード "${raw}" は無視し、既定 "vk-terminals" を使用します（有効値: ${TERMINALS_MODES.join(' / ')}）。`);
  }
  return 'vk-terminals';
}

/**
 * tmux モードで使うセッション名。env VK_TMUX_SESSION > config(tmux.session) > 'vk-orch'。
 * @param {object} [cfg]
 * @returns {string}
 */
export function resolveTmuxSession(cfg = loadUnifiedConfig()) {
  const raw = String(process.env.VK_TMUX_SESSION ?? cfg?.tmux?.session ?? '').trim();
  return raw || 'vk-orch';
}

/**
 * tmux モードで新規ペイン作成時に起動する Claude コマンド。
 * env VK_TMUX_CLAUDE_CMD > config(tmux.claudeCommand) > 'claude'。
 * bypass 運用は 'claude --dangerously-skip-permissions' 等をここで指定する（コードに埋めない）。
 * @param {object} [cfg]
 * @returns {string}
 */
export function resolveTmuxClaudeCommand(cfg = loadUnifiedConfig()) {
  const raw = String(process.env.VK_TMUX_CLAUDE_CMD ?? cfg?.tmux?.claudeCommand ?? '').trim();
  return raw || 'claude';
}

/**
 * 同梱している VK Terminals のインストールディレクトリを解決する。
 * (optionalDependencies として導入される package の実体パス)
 * 未導入なら例外を投げる。
 * @returns {string} VK Terminals パッケージのルートディレクトリ
 */
export function resolveVkTerminalsDir() {
  return dirname(require.resolve('vk-terminals/package.json'));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function validateVkTerminalsSettingsSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('top-level schema must be an object');
  }
  if (!Array.isArray(schema.groups)) {
    throw new Error('schema.groups must be an array');
  }
  for (const [groupIndex, group] of schema.groups.entries()) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      throw new Error(`schema.groups[${groupIndex}] must be an object`);
    }
    if (!isNonEmptyString(group.label)) {
      throw new Error(`schema.groups[${groupIndex}].label must be a non-empty string`);
    }
    if (!Array.isArray(group.fields)) {
      throw new Error(`schema.groups[${groupIndex}].fields must be an array`);
    }
    for (const [fieldIndex, field] of group.fields.entries()) {
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        throw new Error(`schema.groups[${groupIndex}].fields[${fieldIndex}] must be an object`);
      }
      for (const key of ['key', 'label', 'type']) {
        if (!isNonEmptyString(field[key])) {
          throw new Error(`schema.groups[${groupIndex}].fields[${fieldIndex}].${key} must be a non-empty string`);
        }
      }
      if (field.options !== undefined && !Array.isArray(field.options)) {
        throw new Error(`schema.groups[${groupIndex}].fields[${fieldIndex}].options must be an array`);
      }
    }
  }
  return schema;
}

/**
 * vk-terminals 同梱の設定スキーマを読み込む。
 * @param {string} vkDir VK Terminals パッケージのルートディレクトリ
 * @returns {object|null}
 */
export function loadVkTerminalsSettingsSchema(vkDir) {
  const schemaPath = join(vkDir, 'settings-schema.json');
  try {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    return validateVkTerminalsSettingsSchema(schema);
  } catch (err) {
    console.warn(`[Config] ${schemaPath} を読み込めませんでした: ${err.message}`);
    return null;
  }
}

function getByPath(obj, path) {
  return path.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

function hasOwnPath(obj, path) {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) {
      return false;
    }
    cur = cur[key];
  }
  return true;
}

/**
 * プロトタイプ汚染につながるキーを含むパスかどうか。
 *
 * deepMerge / pruneEmpty と同じ多層防御を path 操作にも揃える。`agents.engine.<定義名>` の
 * ように将来キーの一部が外部由来になりうるため、書き込み・削除の入口で弾く。
 * @param {string} path ドット区切りのキーパス
 * @returns {boolean}
 */
function hasUnsafePathKey(path) {
  return path
    .split('.')
    .some((key) => key === '__proto__' || key === 'constructor' || key === 'prototype');
}

/**
 * ドット区切りパスへ値を書き込む（中間オブジェクトは自動生成）。
 *
 * **危険キー（`__proto__` / `constructor` / `prototype`）を含むパスは黙って no-op する。**
 * 将来 `agents.engine.<定義名>` のようにキーを動的生成する場合、この静かな失敗は
 * 「設定パネルに項目は出るのに保存されない」という無言の不具合になるため、
 * 呼び出し側でキー名を検証すること。
 * @param {object} obj 対象オブジェクト（in-place で書き換える）
 * @param {string} path ドット区切りのキーパス
 * @param {*} value 書き込む値
 */
function setByPath(obj, path, value) {
  if (hasUnsafePathKey(path)) return;
  const keys = path.split('.');
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    if (cur[key] == null || typeof cur[key] !== 'object' || Array.isArray(cur[key])) {
      cur[key] = {};
    }
    cur = cur[key];
  }
  cur[keys.at(-1)] = value;
}

/**
 * ドット区切りパスの leaf を削除する。
 *
 * setByPath と同様、**危険キーを含むパスは黙って no-op する**（削除されないまま
 * 「消したのに残る」という無言の不具合になりうるため、動的キーは呼び出し側で検証すること）。
 * @param {object} obj 対象オブジェクト（in-place で書き換える）
 * @param {string} path ドット区切りのキーパス
 */
function deleteByPath(obj, path) {
  if (hasUnsafePathKey(path)) return;
  const keys = path.split('.');
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    if (cur == null || typeof cur !== 'object') return;
    cur = cur[key];
  }
  if (cur != null && typeof cur === 'object') delete cur[keys.at(-1)];
}

function pruneEmptyParents(obj, path) {
  const keys = path.split('.').slice(0, -1);
  for (let i = keys.length; i >= 1; i--) {
    const parentPath = keys.slice(0, i).join('.');
    const parent = getByPath(obj, parentPath);
    if (
      parent &&
      typeof parent === 'object' &&
      !Array.isArray(parent) &&
      Object.keys(parent).length === 0
    ) {
      deleteByPath(obj, parentPath);
    }
  }
}

function readJsonObject(path) {
  if (!path || !existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    throw new Error(`[Config] JSON ファイルの読み込みに失敗しました (${path}): ${err.message}`);
  }
}

export function writeJsonAtomic(path, obj) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(
    dir,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(tmpPath, JSON.stringify(obj, null, 2) + '\n', { flag: 'wx' });
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // temp が作られる前の失敗、または rename 済みなら削除不要。
    }
    throw err;
  }
}

function detectVkAgentsRepoPath() {
  const candidates = [
    join(dirname(REPO_ROOT), 'vk-agents'),
    join(dirname(dirname(REPO_ROOT)), 'vk-agents'),
    join(homedir(), 'Documents', 'git', 'vk-agents'),
    join(homedir(), 'Documents', 'claude', 'vk-agents'),
    DEFAULT_VENDORED_VK_AGENTS_DIR,
  ];
  return candidates.find((dir) => existsSync(join(dir, 'scripts', 'sync.sh'))) ?? null;
}

/**
 * vk-agents リポジトリのパスを解決する。
 * 優先順位: env VK_AGENTS_DIR/VK_AGENTS_REPO_PATH > config(vkAgents.repoPath) > 既知の兄弟配置。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @returns {string|null}
 */
export function resolveVkAgentsRepoPath(cfg = loadUnifiedConfig()) {
  const raw =
    process.env.VK_AGENTS_DIR ??
    process.env.VK_AGENTS_REPO_PATH ??
    cfg?.vkAgents?.repoPath ??
    '';
  const explicit = String(raw).trim();
  if (explicit) return resolve(explicit);
  return detectVkAgentsRepoPath();
}

/**
 * vk-agents の個人設定 config.json パスを解決する。
 * 優先順位: env VK_AGENTS_CONFIG/VK_AGENTS_CONFIG_PATH > config(vkAgents.configPath)
 * > ~/.vk-agents/config.json（存在する場合） > 解決済み vk-agents リポジトリ直下 config.json。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @param {{ homeDir?: string }} [options]
 * @returns {string|null}
 */
/**
 * vk-agents 設定パスの「明示指定」（env / config）だけを解決する。
 * env VK_AGENTS_CONFIG > VK_AGENTS_CONFIG_PATH > config(vkAgents.configPath)。
 * どれも無ければ null（呼び出し側で既定のフォールバックを決める）。
 * @param {object} cfg loadUnifiedConfig() の戻り値
 * @returns {string|null}
 */
function resolveExplicitVkAgentsConfigPath(cfg) {
  const raw =
    process.env.VK_AGENTS_CONFIG ??
    process.env.VK_AGENTS_CONFIG_PATH ??
    cfg?.vkAgents?.configPath ??
    '';
  const explicit = String(raw).trim();
  return explicit ? resolve(explicit) : null;
}

export function resolveVkAgentsConfigPath(cfg = loadUnifiedConfig(), options = {}) {
  const explicit = resolveExplicitVkAgentsConfigPath(cfg);
  if (explicit) return explicit;
  const homeConfig = join(options.homeDir ?? homedir(), '.vk-agents', 'config.json');
  if (existsSync(homeConfig)) return homeConfig;
  const repoPath = resolveVkAgentsRepoPath(cfg);
  return repoPath ? join(repoPath, 'config.json') : null;
}

/**
 * vk-agents 設定の「書き込み先」正本パスを解決する。
 *
 * READ 用の resolveVkAgentsConfigPath() は home 正本が無いと旧リポ／vendored 直下へ
 * フォールバックするが、それらは re-clone / re-install で消える揮発パスであり、
 * GUI パネル（設定ディスクリプタ）や orchestrator の投影の「書き込み先」に使うと
 * 揮発問題を再導入してしまう。書き込み先は常に永続の正本 ~/.vk-agents/config.json
 * とし（env / config での明示上書きのみ尊重）、存在有無に関わらず具体パスを返す
 * （null を返さない＝ディスクリプタが無効化されて GUI から全項目が消える事故を防ぐ）。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @param {{ homeDir?: string }} [options]
 * @returns {string} 書き込み先の正本パス
 */
export function resolveVkAgentsCanonicalConfigPath(cfg = loadUnifiedConfig(), options = {}) {
  return resolveExplicitVkAgentsConfigPath(cfg)
    ?? join(options.homeDir ?? homedir(), '.vk-agents', 'config.json');
}

/**
 * VK Terminals API の接続先 host を解決する。
 * 優先順位: env VK_TERMINALS_HOST > ~/.vk-terminals/config.json(apiHost) > 既定値。
 * @param {{ homeDir?: string, configPath?: string }} [options]
 * @returns {string}
 */
export function resolveVkTerminalsApiHost(options = {}) {
  const envHost = String(process.env.VK_TERMINALS_HOST ?? '').trim();
  if (envHost) return envHost;

  const configPath = options.configPath ?? join(options.homeDir ?? homedir(), '.vk-terminals', 'config.json');
  let config;
  try {
    config = readJsonObject(configPath);
  } catch (err) {
    // ~/.vk-terminals/config.json は VK Terminals(GUI) が書き込む外部ファイル。
    // 不正 JSON や書き込み途中の読み取り競合で例外になっても、呼び出し元（up 等）を
    // 落とさず既定ホストへフォールバックする（writeVkAgentsSettings と同じ安全側の扱い）。
    console.warn(`[Config] ${configPath} の読み込みに失敗したため既定ホスト 127.0.0.1 を使用します: ${err.message}`);
    return '127.0.0.1';
  }
  const apiHost = typeof config.apiHost === 'string' ? config.apiHost.trim() : '';
  return apiHost || '127.0.0.1';
}

function normalizeApiPort(raw) {
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * VK Terminals API の接続先 port を解決する。
 * 優先順位: env VK_TERMINALS_PORT > ~/.vk-terminals/config.json(port) > 既定値。
 * @param {{ homeDir?: string, configPath?: string }} [options]
 * @returns {number}
 */
export function resolveVkTerminalsApiPort(options = {}) {
  const envPort = normalizeApiPort(process.env.VK_TERMINALS_PORT);
  if (envPort !== null) return envPort;

  const configPath = options.configPath ?? join(options.homeDir ?? homedir(), '.vk-terminals', 'config.json');
  let config;
  try {
    config = readJsonObject(configPath);
  } catch (err) {
    // ~/.vk-terminals/config.json は VK Terminals(GUI) が書き込む外部ファイル。
    // 不正 JSON や書き込み途中の読み取り競合で例外になっても、呼び出し元（up 等）を
    // 落とさず既定ポートへフォールバックする。
    console.warn(`[Config] ${configPath} の読み込みに失敗したため既定ポート ${DEFAULT_VK_TERMINALS_PORT} を使用します: ${err.message}`);
    return DEFAULT_VK_TERMINALS_PORT;
  }
  return normalizeApiPort(config.port) ?? DEFAULT_VK_TERMINALS_PORT;
}

/**
 * VK Terminals がタスク一覧表示に読む、正規化済み task-queue snapshot のパス。
 * @param {{ homeDir?: string }} [options]
 * @returns {string}
 */
export function resolveTasksViewPath(options = {}) {
  return join(options.homeDir ?? homedir(), '.task-queue', 'tasks-view.json');
}

/**
 * VK Terminals がタスク一覧表示に読む、宣言的ウィジェット（tasks-widget.json）のパス。
 * tasks-view.json の後継となる新形式で、当面は両方を dual-write する。
 * @param {{ homeDir?: string }} [options]
 * @returns {string}
 */
export function resolveTasksWidgetPath(options = {}) {
  return join(options.homeDir ?? homedir(), '.task-queue', 'tasks-widget.json');
}

/**
 * VK Terminals がステータス変更依頼を追記する commands.jsonl のパス。
 * @param {{ homeDir?: string }} [options]
 * @returns {string}
 */
export function resolveCommandsPath(options = {}) {
  return join(options.homeDir ?? homedir(), '.task-queue', 'commands.jsonl');
}

/**
 * up 起動時に VK Terminals 本体 config へ tasks-view.json のパスを注入する。
 * 既存キーは保持し、tasksViewPath だけを上書きする。
 * @param {{ homeDir?: string, configPath?: string, tasksViewPath?: string }} [options]
 * @returns {{ configPath: string, tasksViewPath: string }}
 */
export function writeVkTerminalsTasksViewConfig(options = {}) {
  const homeDir = options.homeDir ?? homedir();
  const configPath = options.configPath ?? join(homeDir, '.vk-terminals', 'config.json');
  const tasksViewPath = options.tasksViewPath ?? resolveTasksViewPath({ homeDir });
  const config = readJsonObject(configPath);
  config.tasksViewPath = tasksViewPath;
  writeJsonAtomic(configPath, config);
  return { configPath, tasksViewPath };
}

/**
 * up 起動時に VK Terminals 本体 config へ tasks-widget.json のパスを注入する。
 * 既存キーは保持し、tasksWidgetPath だけを上書きする。
 * @param {{ homeDir?: string, configPath?: string, tasksWidgetPath?: string }} [options]
 * @returns {{ configPath: string, tasksWidgetPath: string }}
 */
export function writeVkTerminalsTasksWidgetConfig(options = {}) {
  const homeDir = options.homeDir ?? homedir();
  const configPath = options.configPath ?? join(homeDir, '.vk-terminals', 'config.json');
  const tasksWidgetPath = options.tasksWidgetPath ?? resolveTasksWidgetPath({ homeDir });
  const config = readJsonObject(configPath);
  config.tasksWidgetPath = tasksWidgetPath;
  writeJsonAtomic(configPath, config);
  return { configPath, tasksWidgetPath };
}

/**
 * up 起動時に VK Terminals 本体 config へ commands.jsonl のパスを注入する。
 * 既存キーは保持し、commandsPath だけを上書きする。
 * @param {{ homeDir?: string, configPath?: string, commandsPath?: string }} [options]
 * @returns {{ configPath: string, commandsPath: string }}
 */
export function writeVkTerminalsCommandsConfig(options = {}) {
  const homeDir = options.homeDir ?? homedir();
  const configPath = options.configPath ?? join(homeDir, '.vk-terminals', 'config.json');
  const commandsPath = options.commandsPath ?? resolveCommandsPath({ homeDir });
  const config = readJsonObject(configPath);
  config.commandsPath = commandsPath;
  writeJsonAtomic(configPath, config);
  return { configPath, commandsPath };
}

/**
 * vk-agents の Claude グローバル派生設定パス。
 * sync.sh --claude-global と同じ場所へ、vk-agents config.json の投影として書く。
 * @param {string} [homeDir]
 * @returns {string}
 */
export function vkAgentsGlobalSettingsPath(homeDir = homedir()) {
  return join(homeDir, '.claude', 'vk-agents-settings.json');
}

/**
 * sync.sh --claude-global が更新するスキルマニフェストのパス。
 * @param {string} [homeDir]
 * @returns {string}
 */
export function vkAgentsSkillsManifestPath(homeDir = homedir()) {
  return join(homeDir, '.claude', 'skills', '.agent-skills-manifest');
}

/**
 * orchestrator が管理する、スキル展開元記録のサイドカーファイル。
 * sync.sh は .agent-skills-manifest を毎回上書きするため、別ファイルに分離する。
 * @param {string} [homeDir]
 * @returns {string}
 */
export function vkAgentsSkillsManifestSourcePath(homeDir = homedir()) {
  return join(homeDir, '.claude', 'skills', '.agent-skills-manifest-source');
}

/**
 * up 起動時の未セットアップ判定。
 * manifest があれば、展開元サイドカーの有無に関係なくセットアップ済みとみなす。
 * @param {{ manifestPath?: string, homeDir?: string }} [options]
 * @returns {boolean}
 */
export function isVkAgentsSetup(options = {}) {
  const manifestPath = options.manifestPath ?? vkAgentsSkillsManifestPath(options.homeDir);
  return existsSync(manifestPath);
}

/**
 * setup:agents 実行後に、sync.sh に消されないサイドカーへ展開元を記録する。
 * @param {string} sourcePath
 * @param {{ sourceRecordPath?: string, homeDir?: string, now?: Date }} [options]
 * @returns {string}
 */
export function writeVkAgentsManifestSource(sourcePath, options = {}) {
  const sourceRecordPath =
    options.sourceRecordPath ?? vkAgentsSkillsManifestSourcePath(options.homeDir);
  const payload = {
    sourcePath: resolve(sourcePath),
    writtenAt: (options.now ?? new Date()).toISOString(),
  };
  writeJsonAtomic(sourceRecordPath, payload);
  return sourceRecordPath;
}

function normalizedStringArray(value) {
  if (!Array.isArray(value)) return null;
  return value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item !== '');
}

function firstOwnedValue(obj, paths) {
  for (const path of paths) {
    if (hasOwnPath(obj, path)) return getByPath(obj, path);
  }
  return undefined;
}

// owner/repo 形式の受理条件（単一ソース）。
// descriptor の pattern（GUI 側の入力検証）と、GUI 保存値を vk-agents config へ投影する
// applyVkAgentsGuiSettings の受理判定を同一ソースにするため、正規表現を文字列定数で 1 箇所に定義する。
// descriptor は JSON 直列化されるため RegExp オブジェクトではなく文字列で保持する必要がある。
// 先頭の否定先読みで owner が `.`/`..`、末尾の否定先読みで repo が `.`/`..` になるケースを弾き、
// `..foo/repo` のような正規なリポジトリ名は通す（旧・二段ガードと論理等価であることを検証済み）。
const OWNER_REPO_PATTERN = '^(?!\\.{1,2}/)[A-Za-z0-9._-]+/(?!\\.{1,2}$)[A-Za-z0-9._-]+$';
const OWNER_REPO_RE = new RegExp(OWNER_REPO_PATTERN);

function applyVkAgentsGuiSettings(vkAgentsConfig, cfg, options = {}) {
  const log = options.log ?? console.log;
  const out = deepMerge({}, vkAgentsConfig);

  // 旧エンジンキーの読み替えは正本（canonical）の中だけで行う。cfg（orchestrator 統合 config）に
  // 残った旧キーは読まない（stale な値で正本を蘇らせないため。CodeRabbit 設定と同じ方針）。
  // 「移行 → 正規化 → 投影」の順で、cfg 由来の明示値が最後に勝つ。
  // 戻り値の changed は使わない（writeVkAgentsSettings はここで得た out を常に書き出すため、
  // 「変わったか」で書き込みを分岐する必要がない）。
  const { migratedPaths } = migrateLegacyEngineKeys(out, { log });
  normalizeEngineSettings(out);

  if (hasOwnPath(cfg, 'features')) {
    const rawFeatures = pruneEmpty(getByPath(cfg, 'features'));
    if (rawFeatures && typeof rawFeatures === 'object' && !Array.isArray(rawFeatures)) {
      setByPath(out, 'features', deepMerge(getByPath(out, 'features') ?? {}, rawFeatures));
    }
  }

  // GUI の boolean 保存値が文字列になる古い設定も受け入れる。
  if (hasOwnPath(cfg, 'features.coderabbit')) {
    const raw = getByPath(cfg, 'features.coderabbit');
    if (raw === 'true' || raw === 'false') {
      setByPath(out, 'features.coderabbit', raw === 'true');
    }
  }
  if (hasOwnPath(cfg, 'features.coderabbit_ignore')) {
    const raw = getByPath(cfg, 'features.coderabbit_ignore');
    if (raw === 'true' || raw === 'false') {
      setByPath(out, 'features.coderabbit_ignore', raw === 'true');
    }
  }

  const disabledSkills = normalizedStringArray(firstOwnedValue(cfg, [
    'vkAgents.disabledSkills',
    'vkAgents.skills.disabled',
    'skills.disabled',
  ]));
  if (disabledSkills) {
    setByPath(out, 'skills.disabled', disabledSkills);
  }

  const allowedOwners = normalizedStringArray(firstOwnedValue(cfg, [
    'vkAgents.allowedOwners',
    'vkAgents.allowed_owners',
    'vkAgents.org.allowed_owners',
    'org.allowed_owners',
  ]));
  if (allowedOwners) {
    setByPath(out, 'org.allowed_owners', allowedOwners);
  }

  if (hasOwnPath(cfg, 'org.review_assets_repo')) {
    const raw = String(getByPath(cfg, 'org.review_assets_repo') ?? '').trim();
    if (raw === '') {
      deleteLeafAndPruneParents(out, 'org.review_assets_repo');
    } else if (OWNER_REPO_RE.test(raw)) {
      // 受理条件は OWNER_REPO_PATTERN に単一ソース化済み（descriptor の pattern と同一）。
      setByPath(out, 'org.review_assets_repo', raw);
    }
  }

  // エンジン系キーは cfg 側の受理条件が共通（空文字＝正本の値を削除して既定へ戻す /
  // claude・codex＝採用 / それ以外＝無視して正本の既存値をそのまま残す）なので 1 か所で扱う。
  // 正本側に残っている blank は上の normalizeEngineSettings が畳んでいる。
  for (const key of ENGINE_SETTING_KEYS) {
    if (!hasOwnPath(cfg, key)) continue;
    const raw = String(getByPath(cfg, key) ?? '').trim();
    if (raw === '') {
      // 空文字は「明示値」ではなく「意見なし」。設定パネルはこのグループを正本へ直接書くので、
      // cfg 側の空文字は config.example.json の雛形が残っているだけのことが多い。
      // 同じ実行の移行で旧キーから引き継いだ値を、その雛形で消してしまわないようにする。
      //
      // この例外は「移行が同じ実行で走ったとき」だけ効く。2 回目以降の呼び出しでは旧キーが
      // 既に消えており migratedPaths が空になるため、cfg の空文字で削除される。
      // 実運用ではこれに到達しない: bin/vk-orchestrator.js の起動時に
      // migrateLegacyVkAgentsGuiKeys() が統合 config 側のエンジンキーを退避・削除するため、
      // up/apply の時点で cfg にエンジンキーは残っていない。この前提が崩れると
      // 2 回目の up で設定が消えるので、起動時退避を外すときはここも見直すこと。
      if (migratedPaths.includes(key)) continue;
      deleteLeafAndPruneParents(out, key);
    } else if (ENGINE_SETTING_VALUES.includes(raw)) {
      setByPath(out, key, raw);
    }
  }

  return out;
}

/**
 * 統合 config.json の vk-agents 共通設定を、vk-agents リポジトリの config.json へ投影する。
 *
 * vk-agents の config.json を正本として read-merge-write し、GUI が扱うキーだけを更新する。
 * そのうえで sync.sh --claude-global と同じく ~/.claude/vk-agents-settings.json へ同内容を
 * 派生ファイルとして書き出す（reader はこの派生ファイルを読むため）。
 * @param {object} cfg loadUnifiedConfig() の戻り値
 * @param {{ configPath?: string, globalSettingsPath?: string, force?: boolean, log?: (message:string)=>void }} [options]
 * @returns {{ configPath: string, globalSettingsPath: string }|null}
 */
export function writeVkAgentsSettings(cfg = {}, options = {}) {
  const configPath = options.configPath ?? resolveVkAgentsCanonicalConfigPath(cfg);
  if (!configPath) return null;

  const hasConfig = existsSync(configPath);
  const hasGuiSettings =
    hasOwnPath(cfg, 'features') ||
    hasOwnPath(cfg, 'vkAgents.disabledSkills') ||
    hasOwnPath(cfg, 'vkAgents.skills.disabled') ||
    hasOwnPath(cfg, 'vkAgents.allowedOwners') ||
    hasOwnPath(cfg, 'vkAgents.allowed_owners') ||
    hasOwnPath(cfg, 'vkAgents.org.allowed_owners') ||
    hasOwnPath(cfg, 'skills.disabled') ||
    hasOwnPath(cfg, 'org.allowed_owners') ||
    hasOwnPath(cfg, 'org.review_assets_repo') ||
    // エンジン系キーは ENGINE_SETTING_KEYS から導出する（descriptor / 投影と単一ソースを共有）。
    ENGINE_SETTING_KEYS.some((key) => hasOwnPath(cfg, key));
  if (!hasConfig && !hasGuiSettings && options.force !== true) return null;

  let vkAgentsConfig;
  try {
    vkAgentsConfig = readJsonObject(configPath);
  } catch (err) {
    console.warn(`[vk-agents] ${configPath} が不正な JSON のため設定投影をスキップしました: ${err.message}`);
    return null;
  }

  const next = applyVkAgentsGuiSettings(vkAgentsConfig, cfg, { log: options.log });
  writeJsonAtomic(configPath, next);

  const globalSettingsPath = options.globalSettingsPath ?? vkAgentsGlobalSettingsPath();
  writeJsonAtomic(globalSettingsPath, next);

  return { configPath, globalSettingsPath };
}

function vkTerminalsPortField() {
  return {
    key: 'port',
    label: 'API ポート',
    type: 'number',
    help: `VK Terminals 本体の API サーバーが待ち受けるポート番号（既定: ${DEFAULT_VK_TERMINALS_PORT}）`,
  };
}

function insertVkTerminalsPortField(fields) {
  const next = fields.map((field) => ({ ...field }));
  if (next.some((field) => field.key === 'port')) return next;
  const apiHostIndex = next.findIndex((field) => field.key === 'apiHost');
  next.splice(apiHostIndex >= 0 ? apiHostIndex + 1 : 0, 0, vkTerminalsPortField());
  return next;
}

function vkTerminalsPortOnlySettingsGroup() {
  return {
    label: 'VK Terminals（本体設定）',
    tab: 'terminals',
    note: VK_TERMINALS_SETTINGS_NOTE,
    targetPath: VK_TERMINALS_CONFIG_TARGET_PATH,
    fields: [vkTerminalsPortField()],
  };
}

function resolveVkTerminalsSettingsSchemaForDescriptor(options) {
  let vkTerminalsDir = options.vkTerminalsDir;
  if (vkTerminalsDir === undefined) {
    try {
      vkTerminalsDir = resolveVkTerminalsDir();
    } catch (err) {
      console.warn(`[Config] VK Terminals のインストールディレクトリを解決できないため settings-schema.json を読み込めません: ${err.message}`);
      return null;
    }
  }
  if (!vkTerminalsDir) return null;
  return loadVkTerminalsSettingsSchema(vkTerminalsDir);
}

function buildVkTerminalsSettingsGroups(options = {}) {
  const schema = resolveVkTerminalsSettingsSchemaForDescriptor(options);
  if (!schema) {
    console.warn('[Config] settings-schema.json が見つからない／読めないため、VK Terminals 本体設定は orchestrator 独自項目（port）のみ表示します。');
    return [vkTerminalsPortOnlySettingsGroup()];
  }

  const hiddenKeys = new Set(options.hiddenKeys ?? VK_TERMINALS_SCHEMA_HIDDEN_KEYS);
  const groups = [];
  for (const group of schema.groups) {
    const fields = group.fields
      .filter((field) => !hiddenKeys.has(field.key))
      .map((field) => ({ ...field }));
    if (fields.length === 0) continue;
    const label = schema.groups.length === 1
      ? 'VK Terminals（本体設定）'
      : `VK Terminals（本体設定）: ${group.label}`;
    groups.push({
      label,
      tab: 'terminals',
      note: VK_TERMINALS_SETTINGS_NOTE,
      targetPath: VK_TERMINALS_CONFIG_TARGET_PATH,
      fields,
    });
  }

  if (groups.length > 0) {
    groups[0] = {
      ...groups[0],
      fields: insertVkTerminalsPortField(groups[0].fields),
    };
  } else {
    console.warn('[Config] settings-schema.json に表示可能なスキーマ項目が無いため、VK Terminals 本体設定は orchestrator 独自項目（port）のみ表示します。');
    return [vkTerminalsPortOnlySettingsGroup()];
  }
  return groups;
}

/**
 * VK Terminals の設定パネル用「設定ディスクリプタ」を組み立てる。
 *
 * VK Terminals 側は特定ツールの設定内容を知らない汎用パネルで、env
 * VK_TERMINALS_SETTINGS が指すこのディスクリプタ（targetPath + 項目スキーマ）に
 * 従って読み書きする。ここで VK Orchestrator の統合 config.json のスキーマを与える
 * ことで、GUI から config.json を直接手編集せずに済むようにする。
 *
 * @param {string} [targetPath] 編集対象の config.json パス（既定は解決済みパス）
 * @param {{ vkTerminalsDir?: string, hiddenKeys?: string[] }} [options]
 * @returns {object} 設定ディスクリプタ
 */
export function buildSettingsDescriptor(targetPath = resolveConfigPath(), options = {}) {
  return {
    title: 'VK Orchestrator 設定',
    targetPath,
    tabs: [
      { id: 'orchestrator', label: 'Orchestrator', note: '保存した設定は次回起動時以降に反映されます。' },
      { id: 'terminals', label: 'Terminals', note: '保存した設定は次回起動時以降に反映されます。' },
      { id: 'agents', label: 'VK Agents', note: '保存した設定は次回セッション以降に反映されます。' },
    ],
    groups: [
      {
        label: 'オーケストレーター',
        tab: 'orchestrator',
        fields: [
          { key: 'queue.backend', label: 'タスクの保存先', type: 'select', default: 'local',
            options: [
              { value: 'local',  label: 'ローカル（既定）' },
              { value: 'github', label: 'GitHub' },
            ],
            help: 'オーケストレーターが処理するタスクの保存先を選びます。\nローカル: ローカルの JSON（~/.task-queue/queue.json）でタスクを管理します（既定）。task-queue リポジトリは不要で、純ローカルタスクは `vk-orchestrator task` コマンドで登録します。\nGitHub: task-queue リポジトリに Issue を登録して管理します。この場合は、同じ Orchestrator タブ内・下方の「GitHub」グループの「タスク登録リポジトリ名」（および GitHub オーナー）が必要です。' },
          { key: 'orchestrator.pollIntervalMs',  label: 'ポーリング間隔 (ms)',  type: 'number', help: '新しいタスクを確認する間隔をミリ秒で指定します（GitHub モードでは task-queue の Issue を、ローカルモードではローカルのタスクを確認します）。\n例: 60000 = 1 分' },
          { key: 'orchestrator.watchdogIdleMs',  label: 'ウォッチドッグ idle (ms)', type: 'number', help: 'この時間ターミナルが無活動だと停滞とみなす閾値をミリ秒で指定します。\n例: 10800000 = 3 時間' },
          { key: 'orchestrator.paneResumeMax',   label: 'ペイン消失時の自動再開上限 (回)', type: 'number', help: '作業ペイン消失時（PR 未生成に限る）に自動で再実行する上限回数。超えると failed になり手動確認が必要（既定: 3）' },
          { key: 'orchestrator.conflictHandbackMax', label: 'コンフリクト差し戻し上限 (回)', type: 'number', help: 'automerge ラベル付きタスクの PR がコンフリクトしたとき、作業ペインへ「解消 → push → 再レビュー」を自動依頼する上限回数。タスク 1 件あたりの通算で、一度解消しても回数はリセットされません。\n上限を超えるとタスクの issue にコメントし、ラベルを変えずに自動依頼をやめるため、以降は手動対応が必要です。\n0 を指定すると自動依頼を行わず、すべてのコンフリクトが手動対応になります（既定: 2）' },
          { key: 'orchestrator.replyForwardRetryMax', label: '返信転送の再試行上限 (回)', type: 'number', help: 'issue に投稿された返信が作業ペインの入力欄へ届かなかった場合に、再送する上限回数を指定します。初回送信は回数に含みません。上限に達すると issue にお知らせを投稿し、タスクは失敗にせず指示待ちのまま維持します。\n0 を指定すると再送せず、初回送信だけを行います（既定: 2）' },
          { key: 'task.commandTemplate', label: 'issue を処理する Claude のコマンドテンプレート', type: 'text', placeholder: '/vk-kore {issueUrl} wp-env-port={wpPort} headless=1', help: 'issue に対して仕様検討・実装・プルリク作成・レビューまで自動で処理してマージできる状態にする Claude のコマンドを指定してください。未指定の場合は、次の形式で投げられます。\n/vk-kore {issueUrl} wp-env-port={wpPort} headless=1\n{issueUrl} と {wpPort} は自動で置換します。\n独自のコマンドを使用する場合、オーケストレーターと円滑に連携するための決め事がいくつかあります。詳しくは docs/agent-rules.md をご確認ください。デフォルトの /vk-kore スキルは vendor/vk-agents-public/skills/vk-kore/ にありますので、必要に応じてそれを参考に独自のスキルをご利用の PC の .claude に作ってください。' },
        ],
      },
      ...buildVkTerminalsSettingsGroups(options),
      {
        label: 'VK Terminals との通信（Orchestrator 側設定）',
        tab: 'terminals',
        fields: [
          {
            key: 'vkTerminals.timeoutScale',
            label: '応答を待つ時間の倍率 (倍)',
            type: 'number',
            default: DEFAULT_VK_TERMINALS_TIMEOUT_SCALE,
            placeholder: '1',
            help: 'VK Terminals とのやり取り（状態の取得・ペインの作成・入力の送信など）で応答を待つ時間を、まとめて何倍にするか指定します。\n既定の 1 では 3〜10 秒待ちます。2 なら 6〜20 秒、3 なら 9〜30 秒に伸びます。\nTailscale 越しなど離れたネットワークから接続していて、ターミナルの状態表示が更新されない・入力待ちを検知できないときに 2〜3 へ上げてください。\n指定できるのは 0.1〜60 倍です。範囲外は自動で 0.1 / 60 に丸められます。空欄のままなら 1 倍として扱います。',
          },
        ],
      },
      {
        label: 'GitHub',
        tab: 'orchestrator',
        note: 'GitHub トークンは `gh auth login` で管理します（このパネルでの入力は廃止）。',
        fields: [
          { key: 'github.owner',      label: 'GitHub オーナー（ユーザー／組織）', type: 'text', help: '取り込み・タスク登録の基点となる GitHub のユーザー／組織名。両モード共通で、取り込み対象組織（下の「作業対象リポジトリのオーナー」が未指定のときの既定）として使われます。GitHub モードではタスク登録リポジトリ（task-queue）のオーナーも兼ねます。\n例: vektor-inc' },
          { key: 'github.repo',       label: 'タスク登録リポジトリ名',       type: 'text', visibleWhen: { key: 'queue.backend', value: 'local', hide: true }, help: 'オーケストレーターが処理する Issue を登録・管理するリポジトリ名。GitHub モードでのみ使用します（ローカルモードでは非表示・不要）。\n例: task-queue' },
          { key: 'github.sourceOrg',  label: '作業対象リポジトリのオーナー（組織・省略可）', type: 'text', help: '作業対象リポジトリが属する組織名。この組織を横断検索して `task-queue` ラベル付き Issue を取り込む。未指定時は GitHub オーナーと同じ組織を対象にする', emptyToNull: true },
          { key: 'github.queueLabel', label: '取り込みラベル名',           type: 'text', help: '作業対象リポジトリの Issue にこのラベルが付いていると、オーケストレーターのタスクとして取り込みます' },
          { key: 'orchestrator.assigneeFilter',  label: '担当者フィルタ (login)', type: 'text', help: 'この GitHub ログイン名が assign されている Issue だけを取り込む。空＝一切取り込まない（安全側の既定）。全件取り込むには all と入力', emptyToNull: true },
        ],
      },
      {
        label: 'vk-agents（エージェント共通設定）',
        tab: 'agents',
        note: 'エージェント共通設定は vk-agents の config に保存され、各スキル／エージェントが読み込みます。',
        targetPath: resolveVkAgentsCanonicalConfigPath(),
        fields: [
          { key: 'workspace.search_paths', label: '作業ディレクトリ（複数指定可・優先順）', type: 'lines', placeholder: '/Users/you/Documents/git\n/Users/you/ghq', help: '作業対象リポジトリのローカルクローンを探す起点ディレクトリを、1 行に 1 つ・絶対パスで指定します（上の行ほど優先）。\nこの設定は次の 2 つの場面で使われます。\n(1) issue を処理するスキルがクローンを探すとき\n(2) オーケストレーターがタスク着手時にタスクペインを開く場所を決めるとき\n上から順に走査し、origin が対象リポジトリと一致する既存クローンを最大 4 階層まで自動検出して、そのディレクトリでスキルの作業とペインを開始します。見つからない場合、スキルは 1 行目のディレクトリへクローンします。\nオーケストレーターのペインは、対象リポジトリを特定できないとき・この設定が未設定のとき・検出できないときは、専用ディレクトリ ~/vk-orchestrator-tasks（自動作成。ホームディレクトリや機密ディレクトリは起点にしません）で開きます。' },
          { key: 'org.review_assets_repo', label: 'レビュー用アセットリポジトリ', type: 'text', placeholder: 'owner/repo', pattern: OWNER_REPO_PATTERN, invalidMessage: 'owner/repo の形式で入力してください（例: vektor-inc/task-queue）', help: 'PR・テスト報告用の画像/GIF を保存するリポジトリを <owner>/<repo> 形式で指定します。\n例: vektor-inc/review-assets\n形式が正しくない値は反映されません。空欄時は画像アップロードをスキップし、テキスト記述にフォールバックします', emptyToNull: true },
          { key: 'agents.default_engine', label: 'メンバー共通の既定実行エンジン', type: 'select',
            options: engineSelectOptions('未設定（既定: Claude）'),
            help: '実行エンジンを個別に指定していないメンバーに使う既定値。ここも未設定なら Claude で起動します。\n実行エンジンを切り替えられるメンバー（現在は下に個別項目がある和田・麗美）に適用されます。\n下の「マルチリポジトリタスクの既定実行エンジン」は別項目で、この設定の影響を受けません。\nCodex を選んだメンバーは単独で完結する作業までを担当し、メンバー間の連携は司が引き取ります' },
          { key: 'agents.engine.vk-wp-developer', label: '和田（WordPress 実装担当）の実行エンジン', type: 'select',
            options: engineSelectOptions('未設定（共通の既定に従う）'),
            help: '和田を起動するときの実行エンジン。テーマ・プラグイン・ブロックなど WordPress の実装を担当します（設定キー: agents.engine.vk-wp-developer）\n「未設定」のときは上の「メンバー共通の既定実行エンジン」を使い、それも未設定なら Claude で起動します。\nCodex を選ぶと和田は実装とローカルコミットまでを担当し、push と PR 作成は司が引き取ります' },
          { key: 'agents.engine.vk-ui-tester', label: '麗美（UI・e2e テスト担当）の実行エンジン', type: 'select',
            options: engineSelectOptions('未設定（共通の既定に従う）'),
            help: '麗美を起動するときの実行エンジン。PR のブラウザ動作確認・Playwright テストを担当します（設定キー: agents.engine.vk-ui-tester）\n「未設定」のときは上の「メンバー共通の既定実行エンジン」を使い、それも未設定なら Claude で起動します。\nCodex を選ぶと麗美はテスト実行と判定までを担当し、PR コメントの投稿と差し戻しは司が引き取ります' },
          { key: 'multi_repo_task.default_engine', label: 'マルチリポジトリタスクの既定実行エンジン', type: 'select',
            options: engineSelectOptions('未設定（既定: Claude）'),
            help: 'マルチリポジトリタスク（vk-multi-repo-task）を新規作成するときの既定エンジン。未設定時は Claude にフォールバックします。\n上の「メンバー共通の既定実行エンジン」の影響は受けません' },
          { key: 'features.coderabbit', label: 'CodeRabbit 監視を有効化', type: 'boolean', default: true, help: 'OFF で PR 後の CodeRabbit 監視をスキップし、/code-review 等での確認を案内します。\nOFF のときは automerge ラベル付きタスクの自動マージでも「CodeRabbit のコメントを 30 分待つ」処理を省略し、CI 通過などの条件が揃った時点でマージします。\n社外・個人リポジトリなど CodeRabbit 未導入の環境では OFF 推奨です' },
          { key: 'features.coderabbit_ignore', label: 'CodeRabbit レビューをスキップ（PR 本文に @coderabbitai ignore を記載）', type: 'boolean', default: false, help: 'ON で /vk-pr が PR 本文に @coderabbitai ignore を記載し、CodeRabbit レビューを抑止します。\nレビューが来ないため、automerge ラベル付きタスクの自動マージでも「CodeRabbit のコメントを 30 分待つ」処理を省略し、CI 通過などの条件が揃った時点でマージします。\n上の「CodeRabbit 監視を有効化」（features.coderabbit）が OFF のときは @coderabbitai ignore の記載も 30 分待機も行われないため、この設定は効果がありません' },
        ],
      },
    ],
  };
}

/**
 * 設定ディスクリプタを VK Terminals のインストールディレクトリへ書き出す。
 * up 実行時にここへ書き出し、env VK_TERMINALS_SETTINGS でパスを GUI へ渡す。
 * @param {string} [vkDir] VK Terminals のインストールディレクトリ
 * @param {string} [targetPath] 編集対象の config.json パス
 * @returns {string} 書き出したディスクリプタのパス
 */
export function writeSettingsDescriptor(vkDir = resolveVkTerminalsDir(), targetPath = resolveConfigPath()) {
  const descPath = join(vkDir, 'settings-descriptor.json');
  writeFileSync(descPath, JSON.stringify(buildSettingsDescriptor(targetPath, { vkTerminalsDir: vkDir }), null, 2) + '\n');
  return descPath;
}

/**
 * 環境変数のブール値を解釈する。
 * `'false'` / `'0'`（大文字小文字・前後空白は無視）を false、それ以外の非空値を true とみなす。
 * 未定義・空文字は「未指定」として undefined を返す（呼び出し側で上書きをスキップする）。
 * @param {string|undefined} raw 環境変数の生値
 * @returns {boolean|undefined}
 */
function parseEnvBool(raw) {
  // trim 後に空なら「未指定」。空白のみの値も未指定として扱う（true に倒さない）。
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '') return undefined;
  return !(v === 'false' || v === '0');
}

/**
 * task セクションの解決済み設定を返す。
 * 優先順位: 環境変数 > config.json(cfg.task) > DEFAULT_TASK。
 * config.json は既定値へ再帰的にディープマージし、未指定キーは既定にフォールバックする。
 * env はスカラ値のみを上書きする（この repo の idiom に合わせ env 名を明示）。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @returns {typeof DEFAULT_TASK}
 */
export function getTaskConfig(cfg = loadUnifiedConfig()) {
  // 空値（GUI 保存由来の "" / null / [] 等）は除去してから既定へマージ（空で既定を潰さない）。
  const merged = deepMerge(DEFAULT_TASK, pruneEmpty(cfg?.task) ?? {});
  // 環境変数レイヤー（env > config.json）。空文字・未定義は無視（applyConfigToEnv の set と同じ扱い）。
  const env = process.env;
  if (env.TASK_COMMAND_TEMPLATE) merged.commandTemplate = env.TASK_COMMAND_TEMPLATE;
  if (env.TASK_WP_PORT_BASE)     merged.portBase = Number(env.TASK_WP_PORT_BASE);
  if (env.TASK_WP_PORT_STRIDE)   merged.portStride = Number(env.TASK_WP_PORT_STRIDE);
  // wpEnv.enabled の env 上書き。空文字・未定義は無視（parseEnvBool が
  // undefined を返す）。'false' / '0' を false 扱いにし、それ以外の非空値は true とみなす。
  const wpEnvEnabled = parseEnvBool(env.TASK_WP_ENV_ENABLED);
  if (wpEnvEnabled !== undefined) {
    merged.wpEnv = { ...merged.wpEnv, enabled: wpEnvEnabled }; // ネスト構造を保つ
  }
  return merged;
}

/**
 * queue backend を解決する。
 * 優先順位: 環境変数 QUEUE_BACKEND > config.json(cfg.queue.backend) > DEFAULT_QUEUE.backend。
 * 未知の値は安全側で既定（ローカル）backend にフォールバックする。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @returns {'github'|'local'}
 */
export function getQueueBackend(cfg = loadUnifiedConfig()) {
  const rawValue =
    process.env.QUEUE_BACKEND !== undefined && process.env.QUEUE_BACKEND !== ''
      ? process.env.QUEUE_BACKEND
      : (pruneEmpty(cfg?.queue)?.backend ?? DEFAULT_QUEUE.backend);
  const backend = String(rawValue ?? '').trim().toLowerCase();
  if (backend === 'github' || backend === 'local') return backend;

  if (!warnedUnknownQueueBackend) {
    warnedUnknownQueueBackend = true;
    console.warn(`[Config] 未知の queue.backend "${backend}" は無視し、既定 "local" を使用します（有効値: github / local）。`);
  }
  return DEFAULT_QUEUE.backend;
}

// CodeRabbit 関連の判定が見る設定キー。
const CODERABBIT_FEATURE_PATHS = ['features.coderabbit', 'features.coderabbit_ignore'];

/**
 * CodeRabbit 判定（有効か / レビュー抑止か）が読む設定を、正しい優先順位で 1 つに束ねる。
 *
 * #100 以降、設定パネルの Agents グループ（features.coderabbit / features.coderabbit_ignore を含む）は
 * vk-agents 正本 ~/.vk-agents/config.json を直接編集し、orchestrator 設定 ~/.vk-orchestrator/config.json
 * には値が残らない。にもかかわらず判定側が orchestrator 設定だけを読んでいたため、設定パネルの
 * CodeRabbit OFF が自動マージのコメント待ち判定に届いていなかった（#215）。
 * そこで正本にキーがあれば正本を優先し、無ければ orchestrator 設定へフォールバックする
 * （orchestrator 設定に値が残っている環境の互換維持）。
 *
 * 読み取りでも「書き込み先」の正本パス（resolveVkAgentsCanonicalConfigPath）を使う。
 * READ 用の resolveVkAgentsConfigPath() は home 正本が無いとき vk-agents リポジトリ直下・
 * 同梱ディレクトリ（vendor/vk-agents-public/config.json）まで落ちるが、それらは re-clone /
 * re-install で消える揮発パスであり、マージ挙動を左右する値の読み取り元にはできない。
 * 正本パス（env / config での明示上書き > ~/.vk-agents/config.json）は vk-agents 側ルール
 * （rules/coderabbit-monitoring.md の前提条件）が定める解決順序と一致し、各ペインの
 * エージェントと orchestrator が同じファイルから同じ判定を読むことになる。
 *
 * どちらのソースも読み込み失敗（不正 JSON 等）は警告だけ出して、読めた側と既定値で判定を続ける
 * （毎ループ呼ばれる自動マージ判定を設定ファイル 1 つの破損で落とさない）。両方読めなければ
 * 既定＝監視 ON・抑止 OFF＝「30 分待つ」に倒れるため、失敗方向は常にマージを急がない側になる。
 * @param {{ cfg?: object, orchestratorConfigPath?: string, vkAgentsConfigPath?: string, homeDir?: string }} [options]
 * @returns {object} features.coderabbit / features.coderabbit_ignore だけを持つ config 相当オブジェクト
 */
export function loadCoderabbitFeatureConfig(options = {}) {
  // options.cfg が明示された場合は読み込み自体を起こさない（純粋な判定として使える）。
  let orchestratorConfig = options.cfg ?? {};
  if (options.cfg === undefined) {
    try {
      orchestratorConfig = loadUnifiedConfig(options.orchestratorConfigPath ?? resolveConfigPath());
    } catch (err) {
      console.warn(`[Config] orchestrator 設定の読み込みに失敗したため CodeRabbit 設定は正本と既定値で判定します: ${err.message}`);
    }
  }
  const vkAgentsConfigPath =
    options.vkAgentsConfigPath
    ?? resolveVkAgentsCanonicalConfigPath(orchestratorConfig, { homeDir: options.homeDir });

  let vkAgentsConfig = {};
  try {
    vkAgentsConfig = readJsonObject(vkAgentsConfigPath);
  } catch (err) {
    console.warn(`[Config] vk-agents 設定の読み込みに失敗したため CodeRabbit 設定は orchestrator 設定側と既定値で判定します: ${err.message}`);
  }

  const out = {};
  for (const path of CODERABBIT_FEATURE_PATHS) {
    const source = hasOwnPath(vkAgentsConfig, path)
      ? vkAgentsConfig
      : hasOwnPath(orchestratorConfig, path)
        ? orchestratorConfig
        : null;
    if (source) setByPath(out, path, getByPath(source, path));
  }
  return out;
}

/**
 * CodeRabbit 監視が有効かどうかを解決する。
 * features.coderabbit は既定 true。明示的に false（真偽値 / 文字列 "false"）のときだけ無効扱いにする。
 * 未設定・不正値は安全側で有効（true）とみなす。
 * @param {object} [cfg] 判定対象の config（既定は vk-agents 正本優先で解決した CodeRabbit 設定）
 * @returns {boolean}
 */
export function isCoderabbitEnabled(cfg = loadCoderabbitFeatureConfig()) {
  if (!hasOwnPath(cfg, 'features.coderabbit')) return true;
  const raw = getByPath(cfg, 'features.coderabbit');
  return !(raw === false || raw === 'false');
}

/**
 * CodeRabbit のレビューを抑止する設定かどうかを解決する。
 * features.coderabbit_ignore が ON のとき /vk-pr は PR 本文に `@coderabbitai ignore` を記載し、
 * CodeRabbit はその PR にレビューを投稿しない。
 * 既定は false（抑止しない）。旧 GUI が保存した文字列 "true" も真として扱う。
 * @param {object} [cfg] 判定対象の config（既定は vk-agents 正本優先で解決した CodeRabbit 設定）
 * @returns {boolean}
 */
export function isCoderabbitIgnored(cfg = loadCoderabbitFeatureConfig()) {
  const raw = getByPath(cfg ?? {}, 'features.coderabbit_ignore');
  return raw === true || raw === 'true';
}

/**
 * CodeRabbit のレビューが投稿される見込みがあるかを解決する
 * （automerge で CodeRabbit のコメントを 30 分待つ必要があるかの判定に使う）。
 * 監視が無効なリポジトリ、またはレビューを抑止している設定では、待ってもコメントは来ないため false。
 * @param {object} [cfg] 判定対象の config（既定は vk-agents 正本優先で解決した CodeRabbit 設定）
 * @returns {boolean}
 */
export function isCoderabbitReviewExpected(cfg = loadCoderabbitFeatureConfig()) {
  return isCoderabbitEnabled(cfg) && !isCoderabbitIgnored(cfg);
}

/**
 * タスク用ペイン（Claude Code）の起点ディレクトリを返す。
 * 優先順位: 環境変数 TASK_CWD > 専用ディレクトリ。
 * 未設定時は `~/vk-orchestrator-tasks` を使う。これは $HOME 直下や特定リポジトリ、
 * config.json / .env 等の機密ディレクトリを起点にせず、空・非 git の専用ディレクトリから
 * タスクを始めるための安全側の既定。ただし cwd は隔離ではなく、絶対パス指定での
 * ファイル読み取りを防ぐものではない。
 * env の明示値は前後空白を除去し、空文字なら未指定として専用ディレクトリへ
 * フォールバックする。相対パスが指定された場合は process.cwd() 基準で resolve() される。
 * 既定ディレクトリは VK Terminals 側フォールバックで $HOME 起点にならないよう自動作成する。
 * 一方、明示値は typo を隠さないため自動作成せず、存在しない場合は警告だけ出して返す。
 * @param {object} [_cfg] 旧 API 互換の未使用引数。orchestrator.taskCwd は廃止済み。
 * @param {string} [homeDir] 既定ディレクトリの親となるホームディレクトリ
 * @returns {string}
 */
export function getTaskCwd(_cfg = {}, homeDir = homedir()) {
  const envValue = String(process.env.TASK_CWD ?? '').trim();
  if (envValue !== '') return resolveExplicitTaskCwd(envValue);

  const defaultDir = join(homeDir, 'vk-orchestrator-tasks');
  try {
    mkdirSync(defaultDir, { recursive: true });
  } catch {
    // 既に存在する / 作成に失敗した場合でも起点としては返す。
  }
  return defaultDir;
}

const warnedMissingTaskCwds = new Set();
let warnedUnknownQueueBackend = false;

function resolveExplicitTaskCwd(rawValue) {
  const taskCwd = resolve(rawValue);
  if (!existsSync(taskCwd) && !warnedMissingTaskCwds.has(taskCwd)) {
    warnedMissingTaskCwds.add(taskCwd);
    console.warn(`[Config] 指定された TASK_CWD が存在しません。存在しないと VK Terminals 側フォールバックで $HOME 起点になる恐れがあります: ${taskCwd}`);
  }
  return taskCwd;
}

/**
 * protocol セクションの解決済み設定を返す。
 * 優先順位: config.json(cfg.protocol) > DEFAULT_PROTOCOL（現時点では env レイヤー無し）。
 * 個別フィールドの env 上書きは、実際に消費する後続 sub-issue で必要になった時に追加する。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @returns {typeof DEFAULT_PROTOCOL}
 */
export function getProtocolConfig(cfg = loadUnifiedConfig()) {
  return deepMerge(DEFAULT_PROTOCOL, pruneEmpty(cfg?.protocol) ?? {});
}

/**
 * labels セクションの解決済み設定を返す。
 * 優先順位: config.json(cfg.labels) > DEFAULT_LABELS（現時点では env レイヤー無し）。
 * 個別フィールドの env 上書きは、実際に消費する後続 sub-issue で必要になった時に追加する。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @returns {typeof DEFAULT_LABELS}
 */
export function getLabelsConfig(cfg = loadUnifiedConfig()) {
  return deepMerge(DEFAULT_LABELS, pruneEmpty(cfg?.labels) ?? {});
}

/**
 * gh CLI の認証済みトークンを取得する。トークン値は呼び出し側でログ出力しないこと。
 * @param {(file: string, args: string[], options: object) => string|Buffer} [execFileSyncImpl]
 * @returns {string}
 */
export function getGitHubTokenFromGh(execFileSyncImpl = execFileSync) {
  return String(execFileSyncImpl('gh', ['auth', 'token'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })).trim();
}

/**
 * GITHUB_TOKEN が未設定なら gh auth token から取得して process.env に反映する。
 * 優先順位は、呼び出し前に dotenv / applyConfigToEnv 済みであることを前提に
 * 環境変数 > .env > config.json > gh auth token となる。
 * @param {{ execFileSync?: (file: string, args: string[], options: object) => string|Buffer }} [options]
 * @returns {string|undefined} 解決できた GITHUB_TOKEN
 */
export function ensureGitHubToken(options = {}) {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  try {
    const token = getGitHubTokenFromGh(options.execFileSync ?? execFileSync);
    if (token) {
      process.env.GITHUB_TOKEN = token;
      return token;
    }
  } catch {
    // 後段の必須チェックで gh auth login への誘導を出す。
  }
  return process.env.GITHUB_TOKEN;
}

/**
 * env(＋事前に applyConfigToEnv 済みの config.json)から、オーケストレーターの
 * 構造化ランタイム設定を解決する。GITHUB_TOKEN 未設定なら gh auth token を試し、
 * それでも解決できなければ例外。
 * @param {string[]} [argv]
 * @param {{ execFileSync?: (file: string, args: string[], options: object) => string|Buffer }} [options]
 */
export function loadConfig(argv = process.argv, options = {}) {
  ensureGitHubToken(options);

  const readArg = (name) => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(`--${name}=`.length);
    const idx = argv.indexOf(`--${name}`);
    if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
    return undefined;
  };

  const owner = process.env.GITHUB_OWNER ?? 'vektor-inc';
  const cfg = {
    githubToken:    process.env.GITHUB_TOKEN,
    owner,
    repo:           process.env.GITHUB_REPO ?? 'task-queue',
    sourceOrg:      process.env.SOURCE_ORG ?? owner,
    queueLabel:     process.env.QUEUE_LABEL ?? 'task-queue',
    vkPort:         resolveVkTerminalsApiPort({
      configPath: options.vkTerminalsConfigPath,
      homeDir: options.homeDir,
    }),
    vkHost:         process.env.VK_TERMINALS_HOST ?? '127.0.0.1',
    pollInterval:   Number(process.env.POLL_INTERVAL_MS ?? 60_000),
    watchdogIdle:   Number(process.env.WATCHDOG_IDLE_MS ?? 3 * 60 * 60 * 1000),
    assigneeFilter: readArg('assignee') ?? process.env.ASSIGNEE_FILTER ?? null,
    queueBackend:   getQueueBackend(),
  };
  if (!cfg.githubToken) {
    throw new Error(`[Config] ${GITHUB_TOKEN_RESOLUTION_HELP}`);
  }
  return cfg;
}
