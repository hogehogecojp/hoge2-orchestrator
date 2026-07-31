import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

// orchestrator/ の一つ上（task-queue/）の .env を読む
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '..', '.env') });

import { GitHubClient } from '../github/index.js';
import { LocalQueueClient } from '../local-queue/index.js';
import {
  GITHUB_TOKEN_RESOLUTION_HELP,
  ensureGitHubToken,
  getQueueBackend,
  DEFAULT_LABELS,
  getLabelsConfig,
  getTaskConfig,
  getTaskCwd,
  getUpdateConfig,
  loadCoderabbitFeatureConfig,
  loadUnifiedConfig,
  readUpdateSnapshot,
  resolveVkAgentsConfigPath,
  resolveVkTerminalsApiHost,
  resolveVkTerminalsApiPort,
} from '../config.js';
import {
  checkHealth,
  createNewPane,
  getStates,
  postMenu,
  setExternalWaiting,
  setOwnPaneTitle,
  reconfirmBodyEcho,
  setTerminalPrUrl,
  setTerminalTitle,
  submitToClaude,
  waitForClaudeReady,
} from '../terminals/index.js';
import {
  ensureTaskRecord,
  recordTaskStart,
  updateTask,
  removeTask,
  getTask,
  getAllTasks,
} from './state.js';
import { cleanupForIssue, formatCleanupSummary, inspectWorktreeByPort } from './cleanup.js';
import { canTransitionToDone as canTransitionToDoneImpl } from './done-gate.js';
import { closeSourceIssueBeforeGate as closeSourceIssueBeforeGateImpl } from './source-close.js';
import { handlePaneMissing, handleUndeliveredBody, normalizeResumeMax } from './pane-resume.js';
import { decideInProgressAction, needsReviewGate } from './in-progress-decision.js';
import {
  DEFAULT_CONFLICT_HANDBACK_MAX,
  DEFAULT_CONFLICT_HANDBACK_SEND_FAILURE_MAX,
  buildResolvedConflictHandbackState,
  buildConflictHandbackPrompt,
  decideConflictHandback,
  isPRConflicted,
  normalizeConflictHandbackMax,
  requiresBlockedLabelForHandbackDecision,
} from './conflict-handback.js';
import { selectAutomergeCandidates } from './automerge-candidates.js';
import { resolveWaitingMergeAction } from './waiting-merge-action.js';
import { coderabbitGateLine, prCompletionOptions } from './coderabbit-gate.js';
import { createScanInProgressMergedHandler } from './scan-in-progress-merged.js';
import { createPrLessParentDoneHandler } from './pr-less-parent-done.js';
import { createReconcileOrphanedMergedTasks } from './reconcile-orphaned-merged.js';
import { findReplyAfterWaitingInput, hasAgentAnsweredAfterWaitingInput } from './decision-record.js';
import { startKeepAwake } from '../power/keep-awake.js';
import { createNotifyPaneMerged } from './notify-pane-merged.js';
import { attachPrUrlToPane, openInitializedTaskPane } from './task-pane-init.js';
// state の termId が今もこのタスクのペインを指しているかの照合（#263）。
import { PANE_OWNERSHIP, findPaneByTermId, resolvePaneOwnership } from './pane-identity.js';
import { createWaitingMarkerScanner } from './waiting-marker-scanner.js';
import {
  DEFAULT_REPLY_FORWARD_RETRY_MAX,
  createReplyForwardScanner,
  normalizeReplyForwardRetryMax,
} from './reply-forward.js';
import { createCommandsFileProcessor, startCommandsFileWatcher } from './commands-file.js';
import { installPersistentConsoleLogger } from './persistent-logger.js';
import { createStartLock } from './start-lock.js';
import { dispatchReadyIssues } from './ready-dispatch.js';
import { writeAgentRulesHandoff } from './agentRulesHandoff.js';
import { formatErrorSummary } from './format-error.js';
import { refreshTasksSnapshots } from './tasks-view.js';
import { resolveRepoCwd } from './resolve-repo-cwd.js';
import { isLocalMachineHost } from './local-machine-host.js';
import { hasGitHubIntegration, disabledGitHubFeatures } from './github-capability.js';
import {
  BLOCKED_REASON_CONFLICT,
  BLOCKED_REASON_REVIEW_INCOMPLETE,
  createStaleBlockedLabelReconciler,
  decideBlockedLabelForConflict,
  issueHasLabel,
  requiresConflictBlockedLabel,
  shouldDisplayBlockedReason,
} from './blocked-reason.js';
import { createReviewIncompleteBlockedSync } from './review-gate-blocked.js';
// コマンド組み立て・ポート割り当て・テンプレート展開は副作用の無い純粋関数として
// build-command.js に分離してある（テストから安全に import するため）。ここでは
// 内部利用のために import しつつ、後段で再 export して index.js からも参照可能にする。
import {
  buildCommand,
  buildPaneTitle,
  collectReservedWpEnvPorts,
  extractGitHubIssueUrl,
  stripAnsiAndControlChars,
} from './build-command.js';
import { buildOrchestratorMenu } from './menu.js';

// --- 設定 ---
ensureGitHubToken();
const GITHUB_TOKEN       = process.env.GITHUB_TOKEN;
const GITHUB_OWNER       = process.env.GITHUB_OWNER        ?? 'vektor-inc';
const GITHUB_REPO        = process.env.GITHUB_REPO         ?? 'task-queue';
// 作業対象リポジトリのオーナー（組織）。省略時はタスク登録リポジトリと同じ owner を見る。
const SOURCE_ORG         = process.env.SOURCE_ORG          ?? GITHUB_OWNER;
// 作業対象リポジトリの取り込みラベル名。汎用化のため env 化（既定は従来の 'task-queue'）。
// 他組織は QUEUE_LABEL を自組織の取り込みラベルに変えれば、そのラベルで運用できる。
const QUEUE_LABEL        = process.env.QUEUE_LABEL         ?? 'task-queue';
const VK_PORT            = resolveVkTerminalsApiPort();
const POLL_INTERVAL      = Number(process.env.POLL_INTERVAL_MS    ?? 60_000);
// ウォッチドッグ: in-progress なのに PR も無く pane も無反応な時間がこれを超えたら
// 「自動進行できない異常」とみなして status:failed に倒す（通常遷移には使わない安全網）。
const WATCHDOG_IDLE      = Number(process.env.WATCHDOG_IDLE_MS     ?? 3 * 60 * 60 * 1000);
// pane 消失を failed と判断するまでの連続観測回数（VK Terminals 再起動等の一時的欠落で
// 早とちりしないため、2 tick 連続で消えていたら確定とする）。
const PANE_MISSING_TICKS = 2;
// pane 消失時（PR 未生成に限る）の自動再開（status:ready への再キュー）の上限回数。
// 超えたら従来どおり status:failed＋手動確認に倒す（無限リトライ防止）。
// env の不正値（NaN・負数・非整数）は normalizeResumeMax が既定 3 にフォールバック
// させる。素の Number() のままだと "abc" → NaN で上限判定が常に false になり、
// 無限リトライ防止が沈黙のうちに無効化されるため必ず健全化を通す。
const PANE_RESUME_MAX    = normalizeResumeMax(process.env.PANE_RESUME_MAX ?? 3);
// automerge 付き PR 同士が競合すると解消 push のたびに差し戻しが行き来しうるため、
// 通算上限を設ける。不正値は純関数側で健全化し、0 は差し戻し無効化として扱う。
const CONFLICT_HANDBACK_MAX = normalizeConflictHandbackMax(
  process.env.CONFLICT_HANDBACK_MAX ?? DEFAULT_CONFLICT_HANDBACK_MAX
);
// 返信転送は初回送信に加えて設定回数だけ再送する。不正値は既定 2 に戻し、
// 0 は「再試行なし」（初回送信だけ）として扱う。
const REPLY_FORWARD_MAX_ATTEMPTS = 1 + normalizeReplyForwardRetryMax(
  process.env.REPLY_FORWARD_RETRY_MAX ?? DEFAULT_REPLY_FORWARD_RETRY_MAX
);
// Claude Code の TUI 起動完了（入力待ち）を待つ readiness ゲートの全体タイムアウト。
// コールドスタート・高負荷時は起動バナーの描画（churn）が長引き、旧既定 15 秒では
// 静止を確認できず描画中の窓へ本文を送って取りこぼす（#172）。既定 45 秒に広げる。
const CLAUDE_READY_TIMEOUT_MS = Number(process.env.CLAUDE_READY_TIMEOUT_MS ?? 45_000);
// submitToClaude の本文送信後の基準待機時間（linear backoff の 1 単位）と本文/Enter の
// 最大再送回数。バナー churn を跨いでエコーを確認できるよう既定を 500→1000 / 2→3 に広げる（#172）。
const CLAUDE_SUBMIT_DELAY_MS   = Number(process.env.CLAUDE_SUBMIT_DELAY_MS ?? 1000);
const CLAUDE_SUBMIT_MAX_RETRIES = Number(process.env.CLAUDE_SUBMIT_MAX_RETRIES ?? 3);
const RUN_ONCE           = process.argv.includes('--once');
installPersistentConsoleLogger();

// `--flag=value` / `--flag value` の両形式から値を取り出す簡易パーサ。
function readArgValue(name) {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return undefined;
}

// 自分にアサインされた issue だけを監視・実行するための assignee フィルタ（GitHub ログイン名）。
// 優先順: --assignee 引数 > ASSIGNEE_FILTER 環境変数 > なし。
// なし / 空は安全側として何も拾わず、全件対象にする場合は "all" を明示する。
const ASSIGNEE_FILTER = readArgValue('assignee') ?? process.env.ASSIGNEE_FILTER ?? null;

const queueBackend = getQueueBackend();

// トークン未解決時の分岐（#157: capability フラグの初適用 / #138 方針5）。
// - GitHub モード         : 従来どおりトークン必須（未解決なら exit。挙動不変）。
// - ローカルモード × 無し : process.exit せず、GitHub 連携無効の純ローカルタスク専用で続行。
//                           何が無効になるか（source import / PR 監視 / automerge / 対象 issue 操作）を警告に明示する。
// - ローカルモード × 有り : フル capability（挙動不変）。
if (!GITHUB_TOKEN) {
  if (queueBackend === 'local') {
    console.warn('[warn] GITHUB_TOKEN を解決できませんでした。ローカルモード（queue.backend: local）のため純ローカルタスク専用で起動します。');
    console.warn(`[warn] GitHub 連携が無効のため次の機能はスキップされます: ${disabledGitHubFeatures().join(' / ')}。`);
    console.warn(`[warn] GitHub 連携を有効化するには: ${GITHUB_TOKEN_RESOLUTION_HELP}`);
  } else {
    console.error(`[Error] ${GITHUB_TOKEN_RESOLUTION_HELP}`);
    process.exit(1);
  }
}

const QueueClient = queueBackend === 'local' ? LocalQueueClient : GitHubClient;
const github = new QueueClient({
  token: GITHUB_TOKEN,
  owner: GITHUB_OWNER,
  repo:  GITHUB_REPO,
  assignee: ASSIGNEE_FILTER,
  queueLabel: QUEUE_LABEL,
});

// GitHub 連携 capability。クライアント自身が宣言した値を単一の真実の源にする。
// トークン無しローカルモードのときだけ false になり、GitHub 依存処理を早期 return でスキップする。
const GITHUB_INTEGRATION = hasGitHubIntegration(github);
const reconcileStaleBlockedLabels = createStaleBlockedLabelReconciler({
  removeBlockedLabel: github.removeBlockedLabel.bind(github),
  getLabelsConfig,
  logger: console,
});

async function syncConflictBlockedLabel(issue, prState, humanActionRequired, tag) {
  const blockedConflictLabel = getLabelsConfig().blocked?.conflict ??
    DEFAULT_LABELS.blocked.conflict;
  const decision = decideBlockedLabelForConflict({
    prState,
    hasBlockedLabel: issueHasLabel(issue, blockedConflictLabel),
    humanActionRequired,
  });
  try {
    if (decision.action === 'add') {
      await github.addBlockedReasonLabel(issue.number, BLOCKED_REASON_CONFLICT);
    } else if (decision.action === 'remove') {
      await github.removeBlockedReasonLabel(issue.number, BLOCKED_REASON_CONFLICT);
    }
  } catch (err) {
    console.warn(`  ${tag}: ${blockedConflictLabel} の${decision.action === 'add' ? '付与' : '除去'}失敗（次ループで再試行）: ${err.message}`);
  }
}

// レビュー完了マーカー未付与で自動マージが保留されていることを、メタ issue のコメントと
// blocked:review-incomplete ラベル（タスクカードの要対応バッジ）で可視化する（#251）。
// 付与時だけ 1 回通知し、マーカーが付く / PR がマージ・close されたらラベルを外す。
const syncReviewIncompleteBlockedLabel = createReviewIncompleteBlockedSync({
  addBlockedReasonLabel: (issueNumber, reason) => github.addBlockedReasonLabel(issueNumber, reason),
  removeBlockedReasonLabel: (issueNumber, reason) => github.removeBlockedReasonLabel(issueNumber, reason),
  addComment: (issueNumber, body) => github.addComment(issueNumber, body),
  getBlockedLabel: () => getLabelsConfig().blocked?.[BLOCKED_REASON_REVIEW_INCOMPLETE] ??
    DEFAULT_LABELS.blocked[BLOCKED_REASON_REVIEW_INCOMPLETE],
  logger: console,
});

function formatAssigneeMode(client) {
  if (!client.pickupEnabled) return '(なし・拾わない)';
  if (!client.assignee) return '(全件)';
  return `${client.assignee} (担当分のみ)`;
}

// 現在 startTask を起動中の issue 番号のセット。
// setInterval で並行発火する複数 loop が同じ issue を二重に起動するのを防ぐ。
// dispatch は撃ちっぱなし（ペイン作成＋送信のみ）になったので保持期間は短いが、
// status:in-progress ラベル反映前に並行 loop が同じ ready issue を fetch した場合の
// レースを抑えるために残す。
const inFlightIssues = new Set();

function getWorkspaceSearchPaths() {
  const configPath = resolveVkAgentsConfigPath();
  if (!configPath) return [];
  try {
    const config = loadUnifiedConfig(configPath);
    const searchPaths = config?.workspace?.search_paths;
    if (!Array.isArray(searchPaths)) return [];
    return searchPaths.filter((path) => typeof path === 'string' && path.trim() !== '');
  } catch (err) {
    console.warn(`  [task-cwd] vk-agents config の読み込み失敗（検出をスキップ）: ${err.message}`);
    return [];
  }
}

function resolveTaskPaneCwd(issue, target) {
  const fallback = () => getTaskCwd();
  const envTaskCwd = String(process.env.TASK_CWD ?? '').trim();
  if (envTaskCwd !== '') {
    const cwd = fallback();
    console.log(`  [task-cwd] TASK_CWD env を使用: ${cwd}`);
    return cwd;
  }

  const apiHost = resolveVkTerminalsApiHost();
  if (!isLocalMachineHost(apiHost)) {
    const cwd = fallback();
    console.log(`  [task-cwd] VK Terminals host=${apiHost} は別マシン（このマシンのアドレスに一致せず）のため検出をスキップし、安全既定を使用: ${cwd}`);
    return cwd;
  }

  if (target.isSelf) {
    const cwd = fallback();
    console.log(`  [task-cwd] issue #${issue.number} は対象リポジトリ未特定のため安全既定を使用: ${cwd}`);
    return cwd;
  }

  const searchPaths = getWorkspaceSearchPaths();
  if (searchPaths.length === 0) {
    const cwd = fallback();
    console.log(`  [task-cwd] workspace.search_paths 未設定のため安全既定を使用: ${cwd}`);
    return cwd;
  }

  const detected = resolveRepoCwd({
    owner: target.owner,
    repo: target.repo,
    searchPaths,
  });
  if (detected) {
    console.log(`  [task-cwd] ${target.owner}/${target.repo} のローカルクローンを検出: ${detected}`);
    return detected;
  }

  const cwd = fallback();
  console.log(`  [task-cwd] ${target.owner}/${target.repo} のローカルクローン未検出のため安全既定を使用: ${cwd}`);
  return cwd;
}

// issue の本文・タイトルから作業対象リポジトリのキー（"owner/repo"）を抽出する。
// GitHub issue URL を含まない汎用タスクは null（＝他と干渉しない独立タスクとして扱う）。
function getTargetRepoKey(issue) {
  const target = extractGitHubIssueUrl(
    [issue.title, issue.body].filter(Boolean).join('\n')
  );
  return target ? `${target.owner}/${target.repo}` : null;
}

// -------------------------------------------------------
// done 遷移ゲート（薄いラッパー）
// -------------------------------------------------------
// 実体は `done-gate.js`。`extractGitHubIssueUrl`、`github.getIssueState`、
// `github.listSubIssueStates` を
// 依存注入することでユニットテスト可能にしている。
//
// 背景: 作業対象リポジトリの issue (= タスク登録リポジトリ issue 本文に含まれる他リポジトリの issue URL) が
// まだ open のまま、対応 PR がマージされただけで done に進めてしまうと、
// 部分対応マージなどでタスク登録リポジトリ側が誤って close される事故が起きる。
// 例: task-queue#49 で対象 issue は未完了のままなのに PR マージ検知で
// done 化 → 手動 reopen が即座に再 close される、というループになった。
// 現在は scanInProgressIssues / checkWaitingMergeIssues / recheckFailedIssues の
// 全 done 遷移経路でこのゲートを通している。
function canTransitionToDone(issue, logTag = '[done-gate]') {
  return canTransitionToDoneImpl(
    issue,
    {
      extractGitHubIssueUrl,
      getIssueState: github.getIssueState.bind(github),
      getSubIssueStates: github.listSubIssueStates.bind(github),
    },
    { logTag }
  );
}

// マージ検知後、done-gate の直前に作業対象リポジトリ側 issue を close する。
// 本体 issue が cross-repo で PR 本文に close keyword が無い場合、GitHub の自動 close が効かず
// done-gate が open 判定で止まり続けるため、ここで先に明示 close する。
function closeSourceIssueBeforeGate(issue, logTag = '[source-close]') {
  return closeSourceIssueBeforeGateImpl(
    issue,
    {
      extractGitHubIssueUrl,
      closeSourceIssue: github.closeSourceIssue.bind(github),
      getSubIssueStates: github.listSubIssueStates.bind(github),
    },
    { logTag }
  );
}

// -------------------------------------------------------
// build-command.js の純粋関数を index.js からも参照できるよう再 export する
// （テストは副作用の無い build-command.js から直接 import するが、
//   index.js 経由の import 互換も保つ）。
// -------------------------------------------------------
export { buildCommand, buildPaneTitle, assignWpEnvPort, expandTemplate, extractGitHubIssueUrl } from './build-command.js';

// -------------------------------------------------------
// PR 検出時に PR 側 / VK Terminals 側へ反映する共通フック。
//
// - PR 本文末尾にタスク登録リポジトリ側 issue URL を back-reference として追記
//   （PR を単体で見てもタスク登録リポジトリ側のどの issue から出たかが追えるようにする）
// - VK Terminals に PR URL を流して apiPrUrl をセット
//   （ペイン上部の PR ボタンから PR ページにジャンプできるようにする）
//
// どちらも失敗してもタスク本処理は継続させたいため、warn のみで握る。
// VK Terminals 側のエンドポイント（/api/set-pr-url）は VK Terminals issue #44 で導入予定で、
// 未対応のバージョンでも本処理が止まらないように設計している。
//
// PR ボタンの書き込み先は state の termId 頼りだが、この termId はペインを閉じた後も残る
// ことがあり、実行面が同じ id を別タスクへ再採番していると別タスクのペインに「他人の PR」の
// ボタンが出る（#263）。そのため書き込み前に素性を照合し、別タスクだと分かったらバッジだけ
// 見送る（本流は止めない）。
//
// @param {object} args
// @param {string|number|null} args.termId        対象ターミナル ID（null なら VK Terminals 通知は省略）
// @param {string|null} [args.paneTitleUrl]       起動時にペインへ設定したヘッダーリンク（照合材料）
// @param {string} args.queueIssueHtmlUrl         タスク登録リポジトリ側 issue の HTML URL（back-ref に使う）
// @param {{owner:string,repo:string,number:number}} args.prRef  対象 PR の owner/repo/number
// @param {string} args.prUrl                     対象 PR の HTML URL
// @param {string} args.logTag                    ログプレフィクス
// -------------------------------------------------------
async function recordPRAcrossSurfaces({ termId, paneTitleUrl = null, queueIssueHtmlUrl, prRef, prUrl, logTag }) {
  if (queueIssueHtmlUrl) {
    try {
      await github.appendQueueIssueRefToPR(prRef, queueIssueHtmlUrl);
    } catch (err) {
      console.warn(`  ${logTag} PR 本文への task-queue URL 追記失敗（処理は継続）: ${err.message}`);
    }
  }

  if (termId != null) {
    // 判定材料はヘッダーリンク（起動時に設定した URL）だけにする。ここで期待値に使える PR URL は
    // 「これから書き込む値」なので、ペイン側は未設定か別値しか返しようがなく所有権の肯定材料に
    // ならない。むしろ PR を張り替えた（PR#1 を閉じて PR#2 を作った）自分自身のペインを
    // 別タスクと誤判定し、以後 PR ボタンが二度と更新されなくなる。
    const inspection = await inspectTaskPane({
      termId,
      expectedTitleUrl: paneTitleUrl,
      logTag,
    });
    if (inspection.ownership === PANE_OWNERSHIP.OTHER_TASK) {
      // ペイン由来の値は外部入力。ログは issue へ貼られる運用があるため、制御文字・ANSI を
      // 落としてから出す（既存の共通実装を再利用。#253）。期待値はこちらが持つ値なので触らない。
      console.warn(`  ${logTag} termId が別タスクのペインを指しているため PR ボタンの書き込みを見送ります (termId=${termId}, 不一致=${inspection.mismatch}, pane=${stripAnsiAndControlChars(inspection.paneValue)}, 期待=${inspection.expectedValue})`);
      return;
    }
    try {
      await setTerminalPrUrl(VK_PORT, termId, prUrl);
    } catch (err) {
      console.warn(`  ${logTag} VK Terminals への PR URL 送信失敗（処理は継続）: ${err.message}`);
    }
  }
}

/**
 * state の termId が指すペインの素性を照合する（VK Terminals へ問い合わせる版）。
 *
 * states を取得できない・ペインが一覧に無い場合は「照合不能」を返して呼び出し側の処理を
 * 続行させる（fail-open）。表示系の付随処理を実行面の一時不調で落とさないため。
 * 逆に「見送るべきときに続行してはいけない」経路（コンフリクト差し戻しのペイン再利用）は
 * 取得失敗時に見送る必要があるので、この関数を使わず個別に states を取得している。
 *
 * 判定材料はヘッダーリンクだけを受け取る。この関数を使う経路（PR ボタンの書き込み）が
 * 持っている PR URL は「これから書き込む値」で、所有権の肯定材料にならないため。
 *
 * @returns {Promise<{ownership:string, mismatch:string|null, paneValue:string|null, expectedValue:string|null}>}
 */
async function inspectTaskPane({ termId, expectedTitleUrl = null, logTag }) {
  const unverifiable = { ownership: PANE_OWNERSHIP.UNVERIFIABLE, mismatch: null, paneValue: null, expectedValue: null };
  if (termId == null) return unverifiable;

  let states;
  try {
    states = await getStates(VK_PORT);
  } catch (err) {
    console.warn(`  ${logTag} ペインの照合用 states を取得できないため state の termId を信頼します: ${err.message}`);
    return unverifiable;
  }

  const pane = findPaneByTermId(states?.terminals, termId);
  if (!pane) return unverifiable;
  return resolvePaneOwnership({ pane, expectedTitleUrl });
}

// runPostMergeCleanup は finally で removeTask し termId を含む state を消すので、
// 必ず cleanup 前に getTask から termId を取得して VK Terminals へ送る。
const notifyPaneMerged = createNotifyPaneMerged({
  getTask,
  setTerminalPrUrl,
  getStates,
  // 作業ペインの会話へ「マージされた」旨を 1 通残す（#241）。入力欄の残留文字クリアと
  // 再送を持つ submitToClaude を使う（sendToTerminal 直叩きは残留文字と連結するため不可）。
  submitToClaude,
  // 同じ PR について二重投稿しないための送信済みマーク（mergedNoticeSentPrUrl）の記録用。
  updateTask,
  port: VK_PORT,
  submitDelayMs: CLAUDE_SUBMIT_DELAY_MS,
  // clearBeforeSend:false — マージ検知は waiting-input（＝Claude が y/n 確認や権限承認の
  // ダイアログを出して止まっているペイン）にも到達する。生きたダイアログへ
  // Ctrl-A(\x01) + Ctrl-K(\x0b) を撃つと Claude Code 側がどう解釈するか（意図しない確定＝
  // 承認していないツール実行の許可）はこちらから検証できないため、初回クリアは撃たない。
  // #189 が守りたいのは新規ディスパッチ時のアイドルペインであって、この経路は対象外
  // （返信転送 src/engine/reply-forward.js と同じ理由・同じ方針）。
  submitOptions: { maxRetries: CLAUDE_SUBMIT_MAX_RETRIES, clearBeforeSend: false },
  logger: {
    log: (...args) => console.log(...args),
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
  },
});

const handleScanInProgressMerged = createScanInProgressMergedHandler({
  closeSourceIssueBeforeGate,
  canTransitionToDone,
  addComment: (...args) => github.addComment(...args),
  closeIssue: (...args) => github.closeIssue(...args),
  setStatus: (...args) => github.setStatus(...args),
  notifyPaneMerged,
  removeTask,
  logger: console,
});

const handlePrLessParentDone = createPrLessParentDoneHandler({
  getSubIssueStates: github.listSubIssueStates.bind(github),
  completeIssue: (issue) => handleScanInProgressMerged(issue, null, {
    completionComment: '✅ 完了\n\n全サブ issue が完了しました。',
    logMessage: `  [scan-in-progress] issue #${issue.number}: PR なし親調整 issue の全 sub-issue closed → done`,
  }),
  logger: console,
});

// state.json 残骸の掃除は毎ループのエントリ数分だけメタ issue を読む。
// GitHub API のリトライが積み上がると watch ループ全体を詰まらせるため単発試行にする。
function getMetaIssue(issueNumber) {
  return github.getIssueState(GITHUB_OWNER, GITHUB_REPO, issueNumber, { retryDelays: [] });
}

const commandsFileProcessor = createCommandsFileProcessor({
  github,
  getMetaIssue,
  logger: console,
});

const reconcileOrphanedMergedTasks = createReconcileOrphanedMergedTasks({
  getAllTasks,
  getMetaIssue,
  extractPRUrlFromIssueBody: (...args) => github.extractPRUrlFromIssueBody(...args),
  parsePRUrl: (...args) => github.parsePRUrl(...args),
  getPRState: (...args) => github.getPRState(...args),
  notifyPaneMerged,
  removeTask,
  logger: console,
});

const scanWaitingMarkers = createWaitingMarkerScanner({
  fetchWaitingInputIssues: () => github.fetchWaitingInputIssues(),
  getStates,
  getTask,
  setExternalWaiting,
  port: VK_PORT,
  logger: console,
});

const scanWaitingInputIssues = createReplyForwardScanner({
  githubIntegration: GITHUB_INTEGRATION,
  fetchWaitingInputIssues: () => github.fetchWaitingInputIssues(),
  getTask,
  gatherTargetState,
  ensurePRRecorded,
  findReplyAfterWaitingInput,
  submitToClaude,
  reconfirmBodyEcho,
  updateTask,
  setStatus: (...args) => github.setStatus(...args),
  addTargetComment: (...args) => github.addSourceComment(...args),
  port: VK_PORT,
  maxAttempts: REPLY_FORWARD_MAX_ATTEMPTS,
  logger: console,
});

// VK Terminals のサイドバーメニューへ「VK Orchestrator」セクションを投げる（冪等）。
// VK Terminals は再起動で注入項目を失うため、health ゲート通過後（＝接続確立時）に
// 毎ループ投げ直す。POST /api/menu は source 単位で丸ごと置換する冪等 API なので、
// 何度呼んでも重複しない。送信失敗は警告のみで握りつぶし、dispatch を止めない。
async function syncOrchestratorMenu() {
  try {
    const section = buildOrchestratorMenu({ updateSnapshot: readUpdateSnapshot() });
    await postMenu(VK_PORT, section);
  } catch (err) {
    console.log(`[warn] VK Terminals サイドバーメニューの更新に失敗しました: ${err.message}`);
  }
}

// -------------------------------------------------------
// 常駐中の新しい版の再確認
//
// 常駐中は「知らせるだけ」で、切り替えは行わない（実行中のタスクとターミナルを
// 巻き込まないため。切り替えは起動時の静止点だけで行う）。
// 一定間隔で確認し直し、設定画面の定義ファイルとサイドバーの項目を最新にする。
// GUI は設定パネルを開くたびに定義ファイルを読み直すので、書き換えれば開き直すだけで反映される。
//
// 確認はディスパッチループを待たせない。git 経路ではリモート照会（最大 15 秒）と
// ローカルの状態確認が入るため、ループの中で待つとタスクの起動や状態監視が止まる。
// そこで「ループでは開始するだけ」にして、結果は次のループのサイドバー再投稿で拾う。
// -------------------------------------------------------
let lastUpdateCheckAt = 0;
let updateCheckInFlight = false;

// ループから呼ぶ入口。条件を満たしたら確認を開始し、完了を待たずに戻る。
function scheduleUpdateStatusRefresh() {
  if (updateCheckInFlight) return;

  const intervalMs = Math.max(1, getUpdateConfig().checkIntervalHours) * 60 * 60 * 1000;
  if (lastUpdateCheckAt !== 0 && Date.now() - lastUpdateCheckAt < intervalMs) return;
  lastUpdateCheckAt = Date.now();
  updateCheckInFlight = true;

  refreshUpdateStatus()
    .catch((err) => console.log(`[warn] 新しい版の確認に失敗しました（処理は継続）: ${err.message}`))
    .finally(() => {
      updateCheckInFlight = false;
    });
}

async function refreshUpdateStatus() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { runUpdateCheck, saveUpdateSnapshot } = await import('./update-runner.js');
  // busy: true … 常駐中は当てないので、判定にも「稼働中」であることを伝える。
  const report = await runUpdateCheck({ repoRoot, busy: true });
  saveUpdateSnapshot(report);
  if (report.updateAvailable) {
    console.log(`[update] ${report.summary}`);
  }

  // 設定画面の定義ファイルを書き直す（GUI は開くたびに読み直すため、本体側の改修は不要）。
  try {
    const { writeSettingsDescriptor } = await import('../config.js');
    writeSettingsDescriptor();
  } catch (err) {
    // tmux モードなど GUI が無い構成では書き出し先が解決できない。知らせるだけで続行する。
    console.log(`[warn] 設定画面の定義ファイルの更新に失敗しました（処理は継続）: ${err.message}`);
  }
}

/**
 * Claude を起動する新規ペインを作り、タイトル設定と入力待ち確認まで行う。
 *
 * タイトル URL を受け付けない実行面では URL 無しで一度だけ再送し、タイトル設定や
 * readiness 確認に失敗しても従来どおり本文送信は試みる。通常起動とコンフリクト差し戻しで
 * この一連の仕様を共有し、片方だけリトライ条件が変わるのを防ぐ。
 *
 * **直接呼ばず、必ず openInitializedTaskPane()（task-pane-init.js）経由で使うこと。**
 * 元 issue の解決（resolvedTarget）と PR URL の登録まで含めて「通常起動のペインと同じ状態」
 * であり、呼び出し側ごとに手当てすると片方だけ抜ける（#258）。
 *
 * @param {object} input
 * @param {object} input.issue メタ issue
 * @param {string} input.cwd ペインの作業ディレクトリ
 * @param {object|null} [input.resolvedTarget] タイトル表示用の元 issue
 * @param {string} input.createdLogTag ペイン作成直後のログ本文
 * @param {string} input.titleLogTag タイトル設定ログ接頭辞
 * @param {string} input.readyLogTag 起動待ちログ接頭辞
 * @returns {Promise<{termId: string|number, titleUrl: string|null}>}
 *   titleUrl は **実際にペインへ設定できた** ヘッダーリンク（設定できなければ null）。
 *   呼び出し側はこれを state の paneTitleUrl として残し、後でペインの素性照合に使う（#263）。
 */
async function createInitializedTaskPane({
  issue,
  cwd,
  resolvedTarget = null,
  createdLogTag,
  titleLogTag,
  readyLogTag,
}) {
  const termId = await createNewPane(VK_PORT, cwd);
  console.log(`  ${createdLogTag} (termId: ${termId})`);
  const { titleText, url: titleUrl } = buildPaneTitle(issue, resolvedTarget);
  // URL 付きの送信が成功したときだけ控えを残す。URL を受け付けない実行面へのフォールバック
  // （URL 無しの再送）や送信自体の失敗ではペインに URL が入らないため、ここで控えを残すと
  // 後段の照合が必ず不一致になり、通知も差し戻しも一切出なくなる。
  let appliedTitleUrl = null;
  try {
    await setTerminalTitle(VK_PORT, termId, titleText, titleUrl);
    if (typeof titleUrl === 'string') appliedTitleUrl = titleUrl;
  } catch (err) {
    if (typeof titleUrl === 'string') {
      try {
        await setTerminalTitle(VK_PORT, termId, titleText);
      } catch (retryErr) {
        console.warn(`  ${titleLogTag} タイトル送信失敗（処理は継続）: ${retryErr.message}`);
      }
    } else {
      console.warn(`  ${titleLogTag} タイトル送信失敗（処理は継続）: ${err.message}`);
    }
  }

  const ready = await waitForClaudeReady(
    VK_PORT,
    termId,
    { readyTimeoutMs: CLAUDE_READY_TIMEOUT_MS }
  );
  if (!ready) {
    console.warn(`  ${readyLogTag} Claude 起動完了を確認できませんでした。送信を試みます (termId=${termId})`);
  }
  return { termId, titleUrl: appliedTitleUrl };
}

// -------------------------------------------------------
// タスク起動（撃ちっぱなし）
//
// 新方針（案B）では runTask の per-task 監視ループを廃止し、ここはペイン作成・
// プロンプト送信・state 記録までで終了する。以降の状態遷移は loop() のスキャナ
// （scanInProgressIssues / scanWaitingInputIssues / checkWaitingMergeIssues）が
// GitHub の客観状態と decision-record コメントを見て駆動する。
// -------------------------------------------------------
async function startTask(issue) {
  const { number, title, body } = issue;
  console.log(`\n[Task #${number}] "${title}" を起動`);
  const resolved = resolveTarget(issue);
  const taskPaneCwd = resolveTaskPaneCwd(issue, resolved);

  // ペイン上部にタスクタイトルを表示（失敗しても続行）。
  // task-queue のメタ issue 本文に元の作業対象 issue の URL が含まれていれば、
  // その元 issue のタイトル・リンクをヘッダーに出す（issue #23）。解決できない汎用タスクや
  // 元 issue の取得失敗時は従来どおりメタ issue のタイトル・リンクにフォールバックする。
  // PR URL はこの時点では未検知なので送らない（PR 検知時に recordPRAcrossSurfaces が送る）。
  let termId;
  let paneTitleUrl = null;
  try {
    ({ termId, titleUrl: paneTitleUrl } = await openInitializedTaskPane({
      issue,
      resolved,
      cwd: taskPaneCwd,
      prUrl: null,
      createInitializedTaskPane,
      getIssueState: (...args) => github.getIssueState(...args),
      setTerminalPrUrl,
      port: VK_PORT,
      createdLogTag: '→ 新規ペイン作成',
      titleLogTag: '[set-title]',
      readyLogTag: '[ready]',
    }));
  } catch (err) {
    console.error(`  新規ペイン作成失敗: ${err.message}`);
    return false;
  }

  // wp-env 連携の ON/OFF を解決する（設定で明示があればそれ、無ければ対象リポの
  // `.wp-env.json` 有無で自動判定）。結果を buildCommand に渡してポート割り当て・
  // {wpPort} 展開・クリーンアップ用 wpPort 保存の要否を決める。
  const wpEnvEnabled = await resolveWpEnvEnabled(issue, resolved);
  let reservedPorts = new Set();
  if (wpEnvEnabled) {
    try {
      reservedPorts = collectReservedWpEnvPorts(await getAllTasks(), number);
    } catch (err) {
      console.warn(`  [state] 予約済み wp-env ポート取得失敗（OS probe のみで続行）: ${err.message}`);
    }
  }
  let prompt;
  let targetIssue;
  let wpPort;
  try {
    ({ prompt, targetIssue, wpPort } = await buildCommand(
      title,
      body,
      termId,
      undefined,
      wpEnvEnabled,
      { reservedPorts }
    ));
  } catch (err) {
    // ペインを閉じる API がまだ無いためオーファンは残るが、failed 化でリトライストームは防止する。
    await markTaskFailed(issue, `wp-env の空きポートを確保できませんでした（${err.message}）`);
    return false;
  }

  // state を記録する。termId は scanWaitingInputIssues が返信を pane に転送する際の
  // 引き当てに使うため、汎用タスク（targetIssue なし）でも必ず残す。
  // wpPort / repo は wp-env クリーンアップ用なので対象 issue ありのときだけ意味を持つ。
  // wpPort は buildCommand が算出済みの値を再利用する（二重計算・二重 config 読み込みを回避）。
  // wp-env 無効時は wpPort が null になり state に保存されないため、既存のクリーンアップ経路
  // （!saved.wpPort で早期 return）が自然にスキップされる。
  // paneTitleUrl は「このペインへ実際に設定したヘッダーリンク」。ペインが閉じられた後に
  // 同じ termId が別タスクへ再採番されたことを検知するための控え（#263）。
  try {
    await recordTaskStart({
      issueNumber: number,
      termId,
      paneTitleUrl,
      wpPort,
      repo:   targetIssue ? `${targetIssue.owner}/${targetIssue.repo}` : null,
    });
  } catch (err) {
    console.warn(`  [state] 記録失敗（処理は継続）: ${err.message}`);
  }

  // status:in-progress に遷移してからプロンプトを送る（スキャナが拾えるように）。
  await github.setStatus(number, 'status:in-progress');

  console.log(`  → terminal #${termId} に送信`);
  const sent = await submitToClaude(
    VK_PORT, termId, prompt, CLAUDE_SUBMIT_DELAY_MS, { maxRetries: CLAUDE_SUBMIT_MAX_RETRIES }
  );
  if (sent?.bodyConfirmed === false) {
    // 本文再送を規定回数使い切ってもエコーを確認できなかった＝本文が入力欄に
    // 届いていない可能性がある。ここで in-progress のまま放置すると、ラベルだけ
    // in-progress・ペインは空プロンプトのまま詰まる（#172）。status:ready へ戻して
    // 自動再ディスパッチし、次ループで拾い直させる。

    // 偽陽性ガード: bodyConfirmed=false はエコー確認の偽陽性があり得るため、
    // ロールバック（再ディスパッチ）を発動する直前に states を取り直して一度だけ
    // 再確認する。ここで積極的にエコーを確認できたら実際には届いているので通常どおり
    // 成功扱いにする。reconfirmBodyEcho は throw せず、states 取得失敗は例外ではなく
    // 戻り値 false（fail-closed）で表す契約なので、ここでは try/catch で包まない。
    const echoedNow = await reconfirmBodyEcho(VK_PORT, termId, prompt);
    if (echoedNow) {
      console.warn(
        `  [submit] 本文エコーを再確認できたため再ディスパッチしません (issue #${number}, termId=${termId})`
      );
      return true;
    }

    console.warn(
      `  [submit] 本文が入力欄に届いていない可能性があります。status:ready へ戻して自動再ディスパッチします (issue #${number}, termId=${termId})`
    );
    return await rollbackUndeliveredBody(issue, termId, wpPort, '本文が入力欄に届いていない可能性があります');
  }
  return true;
}

/**
 * 「タスク本文をペインへ届けられなかった」ときのロールバック（status:ready へ戻して再ディスパッチ）。
 *
 * 呼び出し元は submitToClaude が bodyConfirmed=false を返した経路（#172）。新しいロールバック
 * 機構を作らず handleUndeliveredBody（handlePaneMissing と同じコア）に相乗りする。
 * startTask 本体から切り出しているのは、同じ「本文をペインへ届けられなかった」状況を扱う
 * 経路が今後増えても、resumeCount による上限判定（state レコードを取れないときは
 * 再ディスパッチしない安全装置）を必ず通させるため。
 *
 * @param {object} issue   task-queue issue
 * @param {string} termId  対象ターミナルID（ログ用）
 * @param {number|null} wpPort  buildCommand が確保した wp-env ポート（failed 化時のクリーンアップ用）
 * @param {string} cause   ログに出す理由（state レコードを取れず見送るときの説明に使う）
 * @returns {Promise<boolean>} startTask の戻り値。再ディスパッチしたら false（次ループで拾い直す）、
 *   上限判定ができず見送ったら true（watchdog / 次ループに委ねる）
 */
async function rollbackUndeliveredBody(issue, termId, wpPort, cause) {
  const { number } = issue;

  // handlePaneMissing と同じコアに相乗りして自動収束させる（pane 消失と resumeCount /
  // 上限を合算で管理）。最新の state（resumeCount / wpPort を含む）を渡す。
  // getTask が null（state レコード喪失）だと resumeCount で上限判定できず、偽の初回
  // 扱い（resumeCount=1 リセット）で無限リトライに化ける。readState は破損時も例外を
  // 投げず {issues:{}} を返すため getTask は null になり得る。上限の唯一の安全装置を
  // 状態喪失で失わないよう、レコードを取れないときは再ディスパッチせず watchdog /
  // 次ループに委ねる（フォールバックオブジェクトで resumeCount を偽装しない）。
  let saved = null;
  try {
    saved = await getTask(number);
  } catch (err) {
    console.warn(`  [submit] state 取得に失敗（今回は再ディスパッチを見送り）: ${err.message}`);
  }
  if (!saved) {
    console.warn(
      `  [submit] ${cause}が、state レコードを取得できず自動再開の上限判定ができないため再ディスパッチを見送ります。watchdog / 次ループに委ねます (issue #${number}, termId=${termId})`
    );
    return true;
  }

  await handleUndeliveredBody(
    issue,
    saved,
    {
      // GitHub 連携無効時は PR が存在しえないため「PR なし」を返す fake を渡す（scanWatchdog と同方針）。
      findPRForIssue: GITHUB_INTEGRATION ? github.findPRForIssue.bind(github) : async () => null,
      resolveTarget,
      cleanupForIssue,
      formatCleanupSummary,
      updateTask,
      setStatus: (issueNumber, label) => github.setStatus(issueNumber, label),
      addComment: (issueNumber, body) => github.addComment(issueNumber, body),
      failTask: (reason) => markTaskFailed(issue, reason, { cleanupWpPort: saved.wpPort ?? wpPort }),
    },
    { resumeMax: PANE_RESUME_MAX }
  );
  // ディスパッチ失敗として返す（次ループで status:ready を拾い直す）。
  return false;
}

// -------------------------------------------------------
// スキャナ共通: task-queue issue から「対象」を解決する。
// 本文に他リポの issue URL があればそれを対象に、無ければ task-queue issue 自身を対象とする。
// -------------------------------------------------------
function resolveTarget(issue) {
  const ext = extractGitHubIssueUrl(
    [issue.title, issue.body].filter(Boolean).join('\n')
  );
  if (ext) return { owner: ext.owner, repo: ext.repo, number: ext.number, isSelf: false };
  return { owner: GITHUB_OWNER, repo: GITHUB_REPO, number: issue.number, isSelf: true };
}

// -------------------------------------------------------
// wp-env 連携を有効にするか（タスク着手時に解決）。
// - config.json / 環境変数で task.wpEnv.enabled に true/false を明示していれば最優先
//   （自動判定より優先する脱出ハッチ）。
// - 明示が無い（null/undefined = 自動）ときは対象リポに `.wp-env.json` があるかで判定する
//   （WordPress 案件のみ ON）。汎用タスク（対象 issue URL 無し）や取得失敗時は false に倒す
//   （非 WP 前提。存在しない wp-env のポート割り当て・掃除を避ける安全側の既定）。
// -------------------------------------------------------
async function resolveWpEnvEnabled(issue, target = resolveTarget(issue)) {
  const configVal = getTaskConfig().wpEnv?.enabled;
  if (typeof configVal === 'boolean') return configVal;

  if (target.isSelf) return false;

  try {
    return await github.hasWpEnvConfig(target.owner, target.repo);
  } catch (err) {
    console.warn(`  [wp-env] .wp-env.json 判定に失敗（wp-env 無効として続行）: ${err.message}`);
    return false;
  }
}

// -------------------------------------------------------
// スキャナ共通: 対象 issue / PR の客観状態とコメントを集める。
// - findPRForIssue で PR を検知（あれば getPRState / 完了条件 checkPRCompletion）
// - decision-record コメント検知のため、対象 issue と PR のコメントを時系列で結合
// 失敗は warn で握り、取得できた範囲を返す（次ループで再試行）。
// checkPRCompletion に渡すオプション（CodeRabbit のコメント待ちの要否）は coderabbit-gate.js の
// prCompletionOptions() が純関数として判定する。設定の読み込みはこの関数側で 1 回だけ行い、
// 同じスナップショットを判定と issue コメントの文言（coderabbitGateLine）で共用する。
// -------------------------------------------------------
// @param {object} issue  メタ issue
// @param {object} [opts]
// @param {boolean} [opts.resolveReviewGate=false]  agent-review-passed マーカーの有無まで解決するか。
//   マーカー確認は pulls.get + コメント全件 paginate を伴うため、戻り値の reviewGateReady を
//   実際に使う scan（scanInProgressIssues）だけが true を渡す。他の呼び出し元
//   （scanAnsweredRecovery / scanWaitingInputIssues）は値を使わないので既定 false のまま
//   ＝毎ループの無駄な API 消費を作らない（automerge + waiting-input 滞留時に顕著）。
async function gatherTargetState(issue, { resolveReviewGate = false } = {}) {
  const target = resolveTarget(issue);
  const automerge = github.hasAutomergeLabel(issue);

  let pr = null;
  let prState = null;
  let prCompletionReady = false;
  let reviewGateReady = false;
  let prConflicted = false;
  let prLookupFailed = false;
  // CodeRabbit 設定は「この issue の判定 1 回」につき 1 度だけ解決し、完了判定に使った値を
  // そのまま呼び出し側へ返す。マージ待ちコメントの文言が、マージを許した判定と別時点の
  // 設定に基づいてズレるのを防ぐ（#215）。PR が無い / open でないときは読み込まない。
  let coderabbitCfg = {};
  try {
    pr = await github.findPRForIssue(target.owner, target.repo, target.number);
  } catch (err) {
    prLookupFailed = true;
    console.warn(`  [scan] issue #${issue.number}: PR 検索失敗: ${err.message}`);
  }
  if (pr) {
    try {
      prState = await github.getPRState(target.owner, target.repo, pr.number);
      prConflicted = isPRConflicted(prState);
    } catch (err) {
      console.warn(`  [scan] issue #${issue.number}: PR 状態取得失敗: ${err.message}`);
    }
    if (prState && prState.state === 'open' && !prState.merged) {
      let completion = null;
      coderabbitCfg = loadCoderabbitFeatureConfig();
      try {
        completion = await github.checkPRCompletion(target.owner, target.repo, pr.number, prCompletionOptions(coderabbitCfg));
        prCompletionReady = completion.ready;
      } catch (err) {
        console.warn(`  [scan] issue #${issue.number}: PR 完了判定失敗: ${err.message}`);
      }
      // agent-review-passed マーカー（現 head SHA 一致）の有無。automerge タスクの
      // waiting-merge 遷移を tryAutoMerge のレビューゲートと揃えるために使う（#213）。
      // 取得するのは「この値を使う scan（resolveReviewGate）」かつ「判定に効く状態
      // （needsReviewGate）」のときだけ。効く条件の定義は in-progress-decision.js 側に
      // 1 つだけ置き、ここで書き下さない（判定とガードが将来ズレるのを防ぐ）。
      // 照合は checkPRCompletion が返した headSha で行う
      // （検証後の push を弾く＝TOCTOU 対策。tryAutoMerge と同じ思想）。
      if (resolveReviewGate && needsReviewGate({
        automerge,
        prCompletionReady,
        draft: prState.draft,
        prConflicted,
      })) {
        try {
          reviewGateReady = await github.hasReviewGateMarker(target.owner, target.repo, pr.number, completion.headSha);
        } catch (err) {
          // fail-closed: 確認できない間はマージ待ちに出さず in-progress のまま次ループで再試行する。
          console.warn(`  [scan] issue #${issue.number}: agent-review-passed マーカー確認失敗（マーカー無しとして続行）: ${err.message}`);
        }
      }
    }
  }

  const comments = [];
  try {
    comments.push(...await github.listIssueComments(target.owner, target.repo, target.number));
  } catch (err) {
    console.warn(`  [scan] issue #${issue.number}: 対象 issue コメント取得失敗: ${err.message}`);
  }
  if (pr) {
    try {
      comments.push(...await github.listIssueComments(target.owner, target.repo, pr.number));
    } catch (err) {
      console.warn(`  [scan] issue #${issue.number}: PR コメント取得失敗: ${err.message}`);
    }
  }
  comments.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  return {
    target,
    pr,
    prState,
    prCompletionReady,
    reviewGateReady,
    prConflicted,
    automerge,
    comments,
    prLookupFailed,
    coderabbitCfg,
  };
}

// -------------------------------------------------------
// PR URL の本文記録 + PR アイコン反映（冪等）。状態遷移とは独立の副作用。
// 本文に既に同じ PR URL が記録済みなら何もしない（毎ティックの再 PATCH / 再送信を避ける）。
// -------------------------------------------------------
async function ensurePRRecorded(issue, target, pr) {
  if (github.extractPRUrlFromIssueBody(issue.body) === pr.html_url) return;

  let termId = null;
  let paneTitleUrl = null;
  try {
    const saved = await getTask(issue.number);
    termId = saved?.termId ?? null;
    // ペイン照合用の控え。この変更より前に起動したタスクには無いため null になりうる。
    paneTitleUrl = saved?.paneTitleUrl ?? null;
  } catch { /* state 取得失敗は致命的でない */ }

  try {
    await github.appendPRUrlToIssue(issue.number, pr.html_url);
  } catch (err) {
    console.warn(`  [scan] issue #${issue.number}: PR URL 追記失敗（処理は継続）: ${err.message}`);
  }
  await recordPRAcrossSurfaces({
    termId,
    paneTitleUrl,
    queueIssueHtmlUrl: issue.html_url,
    prRef: { owner: target.owner, repo: target.repo, number: pr.number },
    prUrl: pr.html_url,
    logTag: `[scan #${issue.number}]`,
  });
}

// -------------------------------------------------------
// in-progress スキャン: 対象 issue/PR の客観状態と decision-record コメントから
// 次の状態遷移を決めて適用する（新方針 案B の中核）。
// -------------------------------------------------------
async function scanInProgressIssues() {
  // GitHub 連携無効時は PR 監視（PR 検索・CI 判定・完了条件判定）を行わない。
  // 純ローカルタスクの in-progress → waiting-merge → done は手動操作（CLI / commands.jsonl）で
  // 進めるため、この scan を止めても一巡は成立する（gatherTargetState は GitHub を叩くのでスキップ）。
  if (!GITHUB_INTEGRATION) return;
  let issues;
  try {
    issues = await github.fetchInProgressIssues();
  } catch (err) {
    console.warn(`[scan-in-progress] in-progress issue 取得失敗: ${err.message}`);
    return;
  }
  if (issues.length === 0) return;

  for (const issue of issues) {
    // dispatch 直後で status 反映直後のレース中（起動処理中）の issue は次ループに回す。
    if (inFlightIssues.has(issue.number)) continue;

    let state;
    try {
      // reviewGateReady を判定に使う唯一の scan なので、ここだけマーカーを解決する。
      state = await gatherTargetState(issue, { resolveReviewGate: true });
    } catch (err) {
      console.warn(`  [scan-in-progress] issue #${issue.number}: 状態収集失敗: ${err.message}`);
      continue;
    }
    const {
      target,
      pr,
      prState,
      prCompletionReady,
      reviewGateReady,
      prConflicted,
      automerge,
      comments,
      coderabbitCfg,
    } = state;

    // PR URL 記録 + アイコン（冪等。状態遷移とは独立）
    if (pr && prState) {
      await ensurePRRecorded(issue, target, pr);
    }

    const action = decideInProgressAction({
      comments,
      // draft も渡す: 修正対応中の Draft PR を「マージ待ち」にしないため（#213）。
      pr: prState ? { state: prState.state, merged: prState.merged, draft: prState.draft } : null,
      prCompletionReady,
      // automerge 指定時は「完了済み PR に対するマージ判断依頼」の waiting-input で
      // 自動マージを止めない（司のマージ判断依頼コメントによる waiting-input 滞留を防ぐ）。
      automerge,
      // automerge タスクの waiting-merge 遷移を tryAutoMerge のレビューゲートと揃える（#213）。
      reviewGateReady,
      // コンフリクト差し戻し直後に waiting-merge へ戻して作業依頼を打ち消さない。
      prConflicted,
    });

    if (action.type === 'none') {
      // 完了条件は満たしたのに waiting-merge へ進めなかったケースは、保留理由を毎ループ出す。
      // ここを無音にすると「作業中」表示のまま誰も進めない終端状態（マーカー付与漏れ・
      // マーカー付与後の push による SHA ずれ・draft の戻し忘れ）に人が気づけない。
      // watchdog は PR がある issue には介入しない（pane-resume は has-pr で何もしない）ため、
      // tryAutoMerge() の保留ログと対称にここが唯一の痕跡になる。
      if (prCompletionReady && prState?.draft) {
        console.log(`  [scan-in-progress] issue #${issue.number}: 完了条件は充足したが PR が Draft のため waiting-merge を保留`);
      }
      if (prCompletionReady && prConflicted) {
        const conflictWait = automerge
          ? 'コンフリクト解消の差し戻し待ち'
          : 'コンフリクト解消（手動）待ち';
        console.log(`  [scan-in-progress] issue #${issue.number}: 完了条件は充足したが PR がコンフリクトしているため waiting-merge を保留（${conflictWait}）`);
      }
      if (prCompletionReady && automerge && !reviewGateReady && !prState?.draft) {
        console.log(`  [scan-in-progress] issue #${issue.number}: 完了条件は充足したが agent-review-passed マーカー（現 head SHA 一致）が無いため waiting-merge を保留`);
      }
      await handlePrLessParentDone(issue, state, action);
      continue;
    }

    if (action.type === 'waiting-input') {
      // 未応答の waiting-input を検知。指示待ちに倒す（確認内容は対象 issue/PR 側にある）。
      try {
        await github.setStatus(issue.number, 'status:waiting-input');
        console.log(`  [scan-in-progress] issue #${issue.number}: 未応答の指示待ち検知 → waiting-input`);
      } catch (err) {
        console.warn(`  [scan-in-progress] issue #${issue.number}: waiting-input 遷移失敗: ${err.message}`);
      }
      continue;
    }

    if (action.type === 'merged') {
      await handleScanInProgressMerged(issue, pr);
      continue;
    }

    if (action.type === 'pr-closed-unmerged') {
      try {
        await github.setStatus(issue.number, 'status:failed');
        await github.addComment(issue.number, `❌ 検出した PR が未マージのまま closed されています。手動で確認してください。`);
        console.log(`  [scan-in-progress] issue #${issue.number}: PR 未マージ closed → failed`);
      } catch (err) {
        console.warn(`  [scan-in-progress] issue #${issue.number}: failed 遷移失敗: ${err.message}`);
      }
      continue;
    }

    if (action.type === 'waiting-merge') {
      // checkWaitingMergeIssues は本文の PR URL を起点にするため、追記成功を保証してから遷移する。
      const prUrl = pr.html_url;
      try {
        await github.appendPRUrlToIssue(issue.number, prUrl);
      } catch (err) {
        console.warn(`  [scan-in-progress] issue #${issue.number}: PR URL 記録失敗（waiting-merge 見送り、次ループ再試行）: ${err.message}`);
        continue;
      }
      try {
        await github.setStatus(issue.number, 'status:waiting-merge');
        // 箇条書きは decideInProgressAction が実際に見た条件と 1 対 1 で対応させる（#213）。
        // CodeRabbit 行は tryAutoMerge() と同じ coderabbitGateLine() を使い、待機 0 分になる条件
        // （監視無効・レビュー抑止）で「30 分間なし」と嘘を書かないよう文言ソースを 1 つに揃える（#215）。
        // 渡す設定は完了判定（prCompletionReady）に使ったものと同一スナップショット。
        const lines = [
          '- CI 全通過',
          coderabbitGateLine(coderabbitCfg),
          '- PR は Draft ではない',
        ];
        // automerge タスクだけレビュー完了マーカーが遷移条件に含まれる。
        if (automerge) lines.push('- レビュー完了マーカー（agent-review-passed）を現 head SHA に対して確認済み');
        await github.addComment(
          issue.number,
          `🟢 マージ待ち\n\nPR: ${prUrl}\n\n${lines.join('\n')}\n\nマージされたらこの issue は自動で close されます。`
        );
        console.log(`  [scan-in-progress] issue #${issue.number}: 完了条件充足 → waiting-merge`);
      } catch (err) {
        console.warn(`  [scan-in-progress] issue #${issue.number}: waiting-merge 遷移失敗: ${err.message}`);
      }
    }
  }
}

// -------------------------------------------------------
// answered 復帰スキャン: 司がペイン経由で質問を直接解決し `Status: answered` を
// 明示宣言した waiting-input issue を in-progress へ復帰させる。
//
// answered はペインで既に解決済み＝返信転送が不要なので、VK Terminals の健全性に
// 依存しない。GitHub 上の客観状態（コメント）だけで復帰できるのが本機能の肝なので、
// loop() の checkHealth() ゲートより前（scanInProgressIssues と同じ健全性非依存ゾーン）
// で回す。健全性ゲートの内側に置くと VK Terminals 停止中に waiting-input が解除されず
// 固着するため（answered の設計目標を損なう）。
// -------------------------------------------------------
async function scanAnsweredRecovery() {
  // 対象 issue/PR のコメントを収集して answered を判定するため GitHub 連携が前提。無効時はスキップ。
  if (!GITHUB_INTEGRATION) return;
  let issues;
  try {
    issues = await github.fetchWaitingInputIssues();
  } catch (err) {
    console.warn(`[answered-recovery] waiting-input issue 取得失敗: ${err.message}`);
    return;
  }
  if (issues.length === 0) return;

  for (const issue of issues) {
    let state;
    try {
      state = await gatherTargetState(issue);
    } catch (err) {
      console.warn(`  [answered-recovery] issue #${issue.number}: 状態収集失敗: ${err.message}`);
      continue;
    }

    if (!hasAgentAnsweredAfterWaitingInput(state.comments)) continue;

    try {
      await github.setStatus(issue.number, 'status:in-progress');
      console.log(`  [answered-recovery] issue #${issue.number}: Status: answered 検知（転送不要）→ in-progress`);
    } catch (err) {
      // 失敗時は次ループで再試行（waiting-input のまま据え置き）。
      console.warn(`  [answered-recovery] issue #${issue.number}: in-progress 復帰失敗（次ループ再試行）: ${err.message}`);
    }
  }
}

// -------------------------------------------------------
// ウォッチドッグ（安全網）: in-progress タスクの pane 生存と無反応時間を監視する。
//
// 新方針では秒数で通常遷移しないが、「vk-kore が無言で死んだ／ハングした」ケースは
// シグナルも返信も来ず永久に in-progress のまま詰まる。これを異常として拾うのが目的。
//   - pane 消失（VK Terminals states に termId が居ない）が PANE_MISSING_TICKS 連続
//     → PR 未生成なら上限（PANE_RESUME_MAX）まで自動再開（status:ready へ再キュー）、
//       上限超過は従来どおり failed（pane-resume.js の handlePaneMissing）
//   - pane が WATCHDOG_IDLE 以上 無反応（lastOutputTime が古い） → failed
//     （pane は生きているので自動再開はしない。勝手に殺すと作業中の Claude を潰すため）
// いずれも「PR が無い」場合に限る。PR があれば scanInProgress / merge-watch が駆動するので触らない。
// VK Terminals が落ちている時は pane の生死を判定できないため、loop() の checkHealth() 後ろで呼ぶ。
// -------------------------------------------------------
async function scanWatchdog() {
  let issues;
  try {
    issues = await github.fetchInProgressIssues();
  } catch (err) {
    console.warn(`[watchdog] in-progress issue 取得失敗: ${err.message}`);
    return;
  }
  if (issues.length === 0) return;

  let states;
  try {
    states = await getStates(VK_PORT);
  } catch (err) {
    console.warn(`[watchdog] VK Terminals states 取得失敗: ${err.message}`);
    return;
  }
  const terms = states?.terminals ?? {};

  for (const issue of issues) {
    if (inFlightIssues.has(issue.number)) continue; // 起動処理中はスキップ

    let saved = null;
    try {
      saved = await getTask(issue.number);
    } catch { /* state 取得失敗 */ }
    if (!saved || saved.termId == null) continue; // termId 不明は pane 判定できない

    const term = Object.values(terms).find(t => String(t.termId) === String(saved.termId));

    // pane 消失検知（連続観測）
    if (!term) {
      const missing = (saved.paneMissingTicks ?? 0) + 1;
      try { await updateTask(issue.number, { paneMissingTicks: missing }); } catch {}
      if (missing < PANE_MISSING_TICKS) {
        console.log(`  [watchdog] issue #${issue.number}: pane(termId:${saved.termId}) 消失観測 ${missing}/${PANE_MISSING_TICKS}`);
        continue;
      }
      // pane が消失（クラッシュ等）が確定。PR 未生成なら残った wp-env コンテナ・
      // worktree を掃除のうえ上限回数まで自動再開（status:ready へ再キュー）し、
      // 上限超過・PR ありは従来ルート（failed／通常遷移）に倒す。
      await handlePaneMissing(
        issue,
        saved,
        {
          // GitHub 連携無効時は PR が存在しえないため「PR なし」を返す fake を渡し、
          // pane 消失時の自動再開／failed 化（いずれもローカル操作）へ進ませる。
          findPRForIssue: GITHUB_INTEGRATION ? github.findPRForIssue.bind(github) : async () => null,
          resolveTarget,
          cleanupForIssue,
          formatCleanupSummary,
          updateTask,
          setStatus: (issueNumber, label) => github.setStatus(issueNumber, label),
          addComment: (issueNumber, body) => github.addComment(issueNumber, body),
          failTask: (reason) => markTaskFailed(issue, reason, { cleanupWpPort: saved.wpPort }),
        },
        { resumeMax: PANE_RESUME_MAX }
      );
      continue;
    }

    // pane 復活 → 消失カウンタをリセット
    if (saved.paneMissingTicks) {
      try { await updateTask(issue.number, { paneMissingTicks: 0 }); } catch {}
    }

    // 長時間無反応検知（pane は生きているので wp-env は掃除せず、人の調査に残す）
    const idleMs = Date.now() - (term.lastOutputTime ?? Date.now());
    if (idleMs >= WATCHDOG_IDLE) {
      await failIfNoPR(issue, `作業ペインが ${Math.floor(idleMs / 60000)} 分以上 無反応です`);
    }
  }
}

// ウォッチドッグの failed 化。PR が既にある場合は scanInProgress / merge-watch が
// 駆動するのでウォッチドッグでは触らない（誤って進行中タスクを殺さないための保険）。
// cleanupWpPort が渡された場合（pane 消失時）は、残った wp-env コンテナ・worktree を掃除する。
async function failIfNoPR(issue, reason, { cleanupWpPort = null } = {}) {
  // GitHub 連携有効時のみ PR の有無を確認する。無効時（純ローカル）は PR が存在しえないため
  // 「PR なし」とみなしてそのまま failed 化する（cleanup / setStatus / addComment はローカル操作で完結する）。
  if (GITHUB_INTEGRATION) {
    const target = resolveTarget(issue);
    let pr = null;
    try {
      pr = await github.findPRForIssue(target.owner, target.repo, target.number);
    } catch (err) {
      console.warn(`  [watchdog] issue #${issue.number}: PR 確認失敗（今回は見送り）: ${err.message}`);
      return;
    }
    if (pr) return; // PR あり → 通常ルートに任せる
  }

  await markTaskFailed(issue, reason, { cleanupWpPort });
}

// failed 化の本体（PR チェック済みの経路用）。cleanup → status:failed ＋手動確認コメント
// → removeTask を行う。failIfNoPR（idle タイムアウト等）と、pane 消失時の自動再開
// 上限超過（handlePaneMissing の failTask）の両方から呼ばれる共通処理。
async function markTaskFailed(issue, reason, { cleanupWpPort = null } = {}) {
  // クラッシュで残った wp-env リソースを掃除する（失敗しても failed 化は続行）。
  let cleanupReport = null;
  if (cleanupWpPort != null) {
    try {
      const summary = await cleanupForIssue({ issueNumber: issue.number, wpPort: cleanupWpPort });
      cleanupReport = formatCleanupSummary(summary);
    } catch (err) {
      cleanupReport = `⚠️ クリーンアップ中にエラー: ${err.message}`;
    }
  }

  try {
    await github.setStatus(issue.number, 'status:failed');
    await github.addComment(
      issue.number,
      [
        `❌ ${reason}。自動で進められないため \`status:failed\` にしました。手動で確認してください。`,
        cleanupReport ? `\n**クリーンアップ結果:**\n${cleanupReport}` : '',
      ].filter(Boolean).join('\n')
    );
    await removeTask(issue.number);
    console.log(`  [watchdog] issue #${issue.number} → failed: ${reason}`);
  } catch (err) {
    console.warn(`  [watchdog] issue #${issue.number}: failed 遷移失敗（次ループ再試行）: ${err.message}`);
  }
}

// -------------------------------------------------------
// sequential 判定用: 現在「作業中」の作業対象リポジトリ（"owner/repo"）の集合を集める。
// in-progress / waiting-input / waiting-merge の issue から抽出する。
// 取得失敗時は緩め（待たせない）に倒す。
// -------------------------------------------------------
async function getOccupiedRepoKeys() {
  const occupied = new Set();
  const collect = async (fetchFn, tag) => {
    try {
      const list = await fetchFn();
      for (const i of list) {
        const k = getTargetRepoKey(i);
        if (k) occupied.add(k);
      }
    } catch (err) {
      console.warn(`  [dispatch] ${tag} 取得失敗（sequential 判定が緩くなる可能性）: ${err.message}`);
    }
  };
  await collect(() => github.fetchInProgressIssues(), 'in-progress');
  await collect(() => github.fetchWaitingInputIssues(), 'waiting-input');
  await collect(() => github.fetchWaitingMergeIssues(), 'waiting-merge');
  return occupied;
}

// -------------------------------------------------------
// マージ待ちissueのマージ検知
// status:waiting-merge の issue を毎ループでスキャンし、
// 紐づくPRがマージされていたら status:done + close する
// -------------------------------------------------------
async function checkWaitingMergeIssues() {
  // GitHub 連携無効時はマージ検知・automerge を行わない（純ローカルタスクは手動で done にする）。
  if (!GITHUB_INTEGRATION) return;
  let waitingMergeIssues;
  try {
    waitingMergeIssues = await github.fetchWaitingMergeIssues();
  } catch (err) {
    console.warn(`[merge-watch] waiting-merge issue 取得失敗: ${err.message}`);
    return;
  }

  // 後付け automerge（#207）: automerge ラベルを PR 作成後に付けた場合、司の
  // 「マージ判断をお願いします」で issue が status:waiting-input に落ちているため、
  // waiting-merge しか見ない従来の判定に乗らず永久にマージされなかった。automerge ラベル
  // 付きの waiting-input issue も automerge 候補に含める（本物の質問待ちは tryAutoMerge 内の
  // 完了条件・レビューマーカーゲートで自然に保留される＝安全側）。
  let waitingInputIssues = [];
  try {
    waitingInputIssues = await github.fetchWaitingInputIssues();
  } catch (err) {
    // waiting-input の取得失敗は後付け automerge を諦めるだけ。waiting-merge の検知は続行する。
    console.warn(`[merge-watch] waiting-input issue 取得失敗（後付け automerge をスキップ）: ${err.message}`);
  }

  const candidates = selectAutomergeCandidates({
    waitingMergeIssues,
    waitingInputIssues,
    hasAutomergeLabel: (issue) => github.hasAutomergeLabel(issue),
  });

  if (candidates.length === 0) return;

  const waitingInputCount = candidates.filter((c) => c.source === 'waiting-input').length;
  console.log(
    `[merge-watch] マージ待ち ${waitingMergeIssues.length} 件` +
      (waitingInputCount > 0 ? ` + 後付け automerge の waiting-input ${waitingInputCount} 件` : '') +
      ' をチェック'
  );

  for (const { issue, source } of candidates) {
    const prUrl = github.extractPRUrlFromIssueBody(issue.body);
    if (!prUrl) {
      console.warn(`  [merge-watch] issue #${issue.number}: 本文からPR URLを抽出できませんでした`);
      continue;
    }

    const prRef = github.parsePRUrl(prUrl);
    if (!prRef) {
      console.warn(`  [merge-watch] issue #${issue.number}: PR URLのパースに失敗: ${prUrl}`);
      continue;
    }

    // マージ前（wp-env コンテナが生存しているうちに）worktree パスを state へ snapshot しておく。
    // automerge は数ティック後に発火しうるため、その時点でコンテナが destroy 済みでも
    // runPostMergeCleanup が記録済みパスで worktree・ブランチを掃除できるようにする。
    await snapshotWorktreePath(issue.number);

    let prState;
    try {
      prState = await github.getPRState(prRef.owner, prRef.repo, prRef.number);
    } catch (err) {
      console.warn(`  [merge-watch] issue #${issue.number}: PR状態取得失敗: ${err.message}`);
      continue;
    }

    const hasAutomergeLabel = github.hasAutomergeLabel(issue);
    const humanActionRequired = requiresConflictBlockedLabel({
      prState,
      hasAutomergeLabel,
    });
    await syncConflictBlockedLabel(
      issue,
      prState,
      humanActionRequired,
      `[merge-watch] issue #${issue.number}`
    );
    // PR がマージ・close された時点で「レビュー未完了」の要対応バッジは意味を持たないため外す
    // （issue が close されると取り残し掃除の対象から外れるので、閉じる前のここで落とす）。
    // reviewPassed は渡さない＝マーカーの有無を見ていないので、open PR では何も操作しない。
    await syncReviewIncompleteBlockedLabel({
      issue,
      prState,
      tag: `[merge-watch] issue #${issue.number}`,
    });

    // merged 判定を source 分岐より前に共通化する（#209）。
    // prState.merged なら source（waiting-merge / waiting-input）を問わず完了ルートへ流す。
    // これにより、automerge ラベル付きで waiting-input に滞留した issue の PR が GitHub UI 等で
    // 外部から手動マージされても、close + done + cleanup 経路に確実に乗る。
    const action = resolveWaitingMergeAction({
      source,
      prState,
      hasAutomergeLabel,
    });

    if (action === 'complete-merge') {
      // automerge・外部マージ（GitHub UI 等）いずれで merged になった場合も共通の完了ルート。
      console.log(`  [merge-watch] issue #${issue.number}: PR #${prRef.number} がマージ済み → 完了`);
      await notifyPaneMerged(issue.number, prUrl, '[merge-watch]');
      // 対象 issue が open のままなら部分対応マージの可能性があるため done へ進めず、
      // waiting ラベルを維持して次ループで再評価する。
      await closeSourceIssueBeforeGate(issue, '[merge-watch]');
      if (!(await canTransitionToDone(issue, '[merge-watch]'))) {
        continue;
      }
      // close を先に行い、成功した場合のみ status:done に切り替える。
      // 途中で失敗してもラベルが waiting のまま残り、次ループで再試行される（冪等）。
      try {
        await github.addComment(issue.number, `✅ 完了\n\nPR: ${prUrl} がマージされました。`);
        await github.closeIssue(issue.number);
        await github.setStatus(issue.number, 'status:done');
      } catch (err) {
        console.warn(`  [merge-watch] issue #${issue.number}: 完了処理失敗（次ループで再試行）: ${err.message}`);
      }

      // 残った wp-env コンテナ・worktree・マージ済みブランチをここで掃除する。
      await runPostMergeCleanup(issue, prRef, prState, '[merge-watch]');
      continue;
    }

    if (action === 'try-automerge') {
      // 未マージ・open。automerge 条件（Draft 除外・mergeable・CI + CodeRabbit 静観・
      // agent-review-passed マーカー）は tryAutoMerge 内で再検証されるため、本物の質問待ちは保留のまま。
      // 実 merge 後は次ループの complete-merge 判定で close + done ルートに乗る。
      await tryAutoMerge(issue, prRef, prState, prUrl, source);
      continue;
    }

    // action === 'skip': 未マージで closed、または automerge 対象外の open。
    // どちらも「待ち続ける」方針（手動で再 open / 再マージ・後付け automerge ラベルを考慮）。
    console.log(`  [merge-watch] issue #${issue.number}: PR #${prRef.number} は ${prState.state}${prState.merged ? '(merged)' : ''} のため待機継続`);
  }
}

// -------------------------------------------------------
// automerge ラベル付き issue について PR の自動マージを試みる
// -------------------------------------------------------

async function notifyConflictHandbackExhausted({
  issue,
  prState,
  prUrl,
  saved,
  decision,
  tag,
}) {
  if (decision.notifyExhausted) {
    const lead = decision.type === 'skip-send-failed'
      ? `⚠️ 担当エージェントのターミナル（ペイン）へコンフリクト解消依頼を送れない状態が ${decision.sendFailures} 回続いたため、自動差し戻しを打ち切りました。VK Terminals が起動していない、または対象ターミナルが閉じられている可能性があります。送信失敗の上限 ${DEFAULT_CONFLICT_HANDBACK_SEND_FAILURE_MAX} 回は固定値で、設定からは変更できません。`
      : `⚠️ コンフリクト解消の差し戻しが上限（${CONFLICT_HANDBACK_MAX} 回）に達したため、自動差し戻しを打ち切りました。`;
    const maxAttemptsGuide = decision.type === 'skip-exhausted'
      ? [
          `自動差し戻しの上限回数は、設定パネルの「コンフリクト差し戻し上限 (回)」（\`orchestrator.conflictHandbackMax\`）で変更できます。`,
        ]
      : [];
    try {
      const blockedConflictLabel = getLabelsConfig().blocked?.conflict ??
        DEFAULT_LABELS.blocked.conflict;
      await github.addComment(
        issue.number,
        [
          lead,
          '',
          `PR: ${prUrl}`,
          '',
          `メタ issue は \`status:waiting-merge\`（マージ待ち）のままですが、\`${blockedConflictLabel}\`（要対応: コンフリクト）を付けました。オーケストレーターは以降このタスクを自動では進めないため、次の手順で手動対応してください。`,
          '',
          '1. コンフリクトを手動で解消して push する',
          '2. push 後の内容をレビューし直す',
          '3. 現在の head SHA（PR ブランチの最新コミット ID）で `agent-review-passed-sha: <SHA>` コメント（レビュー完了マーカー）を PR に付け直す',
          '',
          'コンフリクトを push した時点でタスクカードのバッジは消えますが、レビュー完了マーカーが現 head SHA と一致するまで自動マージは再開しません。',
          ...maxAttemptsGuide,
        ].join('\n')
      );
      const previous = saved.conflictHandback ?? {};
      await updateTask(issue.number, {
        conflictHandback: {
          headSha: previous.headSha,
          attempts: previous.attempts ?? 0,
          sendFailures: previous.sendFailures ?? 0,
          delivered: previous.delivered === true,
          exhaustedNotified: true,
        },
      });
    } catch (err) {
      console.warn(`  ${tag}: コンフリクト差し戻し打ち切り通知の記録に失敗（次ループで再試行）: ${err.message}`);
    }
  }
  await syncConflictBlockedLabel(
    issue,
    prState,
    requiresBlockedLabelForHandbackDecision(decision),
    tag
  );
  const reason = decision.type === 'skip-send-failed'
    ? `送信失敗 ${decision.sendFailures} 回`
    : `通算上限 ${CONFLICT_HANDBACK_MAX} 回`;
  console.log(`  ${tag}: コンフリクト差し戻しの${reason}に到達 → 自動差し戻しを打ち切り`);
}

/**
 * コンフリクト差し戻し用の作業ペインを確保する。
 *
 * 生存している既存ペインがあればそれを使い、消えていれば通常起動と同じ初期化
 * （タイトル＝元 issue・PR URL）で作り直す。差し戻し専用の初期化を書くと通常起動と
 * ずれるため、新規作成は openInitializedTaskPane に一本化している（#258）。
 *
 * 「生存している」の判定は在否だけでは足りない。state の termId はペインを閉じても残る
 * ことがあり、実行面が同じ termId を別タスクの新しいペインへ再採番すると、差し戻しプロンプト
 * （＝別ブランチでの作業指示）が無関係なペインへ届く（#263）。そのため再利用の前に素性を
 * 照合し、別タスクのペインだと分かったら再利用せず新規に作り直す（見送りにはしない。
 * コンフリクトの差し戻し自体は必要なため）。
 *
 * @param {object} issue メタ issue
 * @param {object} saved state のタスクレコード
 * @param {string|null} prUrl 担当 PR の HTML URL（PR ボタン表示用に登録し直す）
 * @param {string} tag ログプレフィクス
 * @returns {Promise<string|number|null>} 確保できた termId（確保できなければ null）
 */
async function ensureConflictHandbackPane(issue, saved, prUrl, tag) {
  if (saved.termId != null) {
    let states;
    try {
      states = await getStates(VK_PORT);
    } catch (err) {
      console.warn(`  ${tag}: 既存ペインを生存確認できないため今回は見送り: ${err.message}`);
      return null;
    }
    const term = findPaneByTermId(states?.terminals, saved.termId);
    // 別タスクのペインを掴んでいたら再利用しない。ここで再利用すると、そのペインの担当者が
    // 進めている作業へ「別ブランチのコンフリクトを解消せよ」という指示が割り込む。
    const reuseCheck = term
      ? resolvePaneOwnership({
        pane: term,
        expectedPrUrl: prUrl,
        // この変更より前に起動したタスクには控えが無い。その場合は照合材料なしとして
        // 従来どおり再利用する（後方互換）。
        expectedTitleUrl: saved.paneTitleUrl ?? null,
      })
      : null;
    if (reuseCheck?.ownership === PANE_OWNERSHIP.OTHER_TASK) {
      // ペイン由来の値は外部入力なので、ログへ出す前に制御文字・ANSI を落とす（#253 と同じ経路）。
      console.warn(`  ${tag}: termId が別タスクのペインに再利用されているため新規ペインを作成します (termId=${saved.termId}, 不一致=${reuseCheck.mismatch}, pane=${stripAnsiAndControlChars(reuseCheck.paneValue)}, 期待=${reuseCheck.expectedValue})`);
    } else if (term) {
      // 既存ペイン再利用時も PR URL を送り直す。PR 検知時の recordPRAcrossSurfaces が
      // 失敗していたり、VK Terminals の再起動で apiPrUrl が空のまま残っていることがあり、
      // その場合は差し戻し作業中ずっと PR ボタンが出ない。この関数は差し戻し判定
      // （head SHA が変わったとき、通算上限まで）を通った時のみ呼ばれ、毎ループ叩く
      // 経路ではないため、送り直しのコストは無視できる。
      await attachPrUrlToPane({
        setTerminalPrUrl,
        port: VK_PORT,
        termId: saved.termId,
        prUrl,
        logTag: `${tag}: 既存ペインへの`,
      });
      return saved.termId;
    }
  }

  const resolved = resolveTarget(issue);
  let cwd;
  if (saved.worktreePath && existsSync(saved.worktreePath)) {
    cwd = saved.worktreePath;
  } else {
    if (saved.worktreePath) {
      console.log(`  ${tag}: 記録済み worktree が存在しないため通常の作業ディレクトリへフォールバック: ${saved.worktreePath}`);
    }
    cwd = resolveTaskPaneCwd(issue, resolved);
  }

  try {
    const { termId, titleUrl } = await openInitializedTaskPane({
      issue,
      resolved,
      cwd,
      prUrl,
      createInitializedTaskPane,
      getIssueState: (...args) => github.getIssueState(...args),
      setTerminalPrUrl,
      port: VK_PORT,
      createdLogTag: `${tag}: 差し戻しペインを作成`,
      titleLogTag: `${tag}: 差し戻しペインの`,
      readyLogTag: `${tag}: 差し戻しペインの`,
      prUrlLogTag: `${tag}: 差し戻しペインへの`,
    });
    // paneTitleUrl は必ず上書きする（設定できなかった場合の null も含む）。古いペインの控えを
    // 残すと、作り直した後のペインを「別タスク」と誤判定してしまう。
    await updateTask(issue.number, { termId, paneTitleUrl: titleUrl, paneMissingTicks: 0 });
    return termId;
  } catch (err) {
    console.warn(`  ${tag}: コンフリクト差し戻し用ペインを確保できないため見送り: ${err.message}`);
    return null;
  }
}

/**
 * コンフリクト解消時に配達状態をリセットし、通算差し戻し回数は保持する。
 *
 * headSha=null にすることで、次回のコンフリクトは現 head SHA と必ず不一致になり、
 * decideConflictHandback() の head 変化経路で attempts + 1 として数えられる。
 * exhaustedNotified も戻し、次に通算上限へ達した際は改めて打ち切りを通知する。
 */
async function resetResolvedConflictHandbackState(issueNumber) {
  try {
    const saved = await getTask(issueNumber);
    if (saved?.conflictHandback) {
      const reset = buildResolvedConflictHandbackState(saved);
      const previous = saved.conflictHandback;
      if (
        previous.headSha !== reset.headSha ||
        previous.attempts !== reset.attempts ||
        previous.sendFailures !== reset.sendFailures ||
        previous.delivered !== reset.delivered ||
        previous.exhaustedNotified !== reset.exhaustedNotified
      ) {
        await updateTask(issueNumber, { conflictHandback: reset });
      }
    }
  } catch (err) {
    console.warn(`  [automerge] issue #${issueNumber}: 解消済みコンフリクト差し戻し状態のリセットに失敗（処理は継続）: ${err.message}`);
  }
}

/**
 * コンフリクトした automerge タスクを、担当エージェントのペインへ差し戻す。
 *
 * VK Terminals の疎通確認後に state レコードを upsert し、送信前は未達として失敗回数を
 * 記録、本文到達確認後に配達済みへ更新する。各副作用の失敗はマージ監視へ伝播させず、
 * 未達レコードを使って次ループの有限リトライへ委ねる。
 */
async function handbackConflictedPR(issue, prRef, prState, prUrl, tag) {
  if (!(CONFLICT_HANDBACK_MAX > 0)) {
    await syncConflictBlockedLabel(issue, prState, true, tag);
    console.log(`  ${tag}: コンフリクト差し戻しは設定で無効（CONFLICT_HANDBACK_MAX=0）`);
    return;
  }

  let healthy = false;
  try {
    healthy = await checkHealth(VK_PORT);
  } catch (err) {
    console.warn(`  ${tag}: VK Terminals の疎通確認に失敗: ${err.message}`);
  }
  if (!healthy) {
    console.log(`  ${tag}: VK Terminals へ接続できないため差し戻しを次ループへ見送り（試行は消費しない）`);
    return;
  }

  let saved;
  try {
    await ensureTaskRecord(issue.number);
    saved = await getTask(issue.number);
    if (!saved) throw new Error('upsert 後のタスクレコードを読み直せませんでした');
  } catch (err) {
    console.warn(`  ${tag}: state のタスクレコードを確保できないため差し戻しを見送り: ${err.message}`);
    return;
  }

  const decision = decideConflictHandback({
    headSha: prState.headSha,
    saved,
    maxAttempts: CONFLICT_HANDBACK_MAX,
  });
  if (decision.type === 'skip-unknown-head') {
    console.warn(`  ${tag}: head SHA を取得できず冪等判定ができないため差し戻しを見送り（次ループで再判定）`);
    return;
  }
  if (decision.type === 'skip-duplicate') {
    console.log(`  ${tag}: 同じ head SHA への差し戻しは配達済み（解消 push 待ち）`);
    return;
  }
  if (decision.type === 'skip-exhausted' || decision.type === 'skip-send-failed') {
    await notifyConflictHandbackExhausted({ issue, prState, prUrl, saved, decision, tag });
    return;
  }

  try {
    await updateTask(issue.number, {
      conflictHandback: {
        headSha: prState.headSha,
        attempts: decision.attempt,
        sendFailures: decision.sendFailures,
        delivered: false,
        exhaustedNotified: false,
      },
    });
    const recorded = await getTask(issue.number);
    if (
      recorded?.conflictHandback?.headSha !== prState.headSha ||
      recorded?.conflictHandback?.attempts !== decision.attempt ||
      recorded?.conflictHandback?.sendFailures !== decision.sendFailures ||
      recorded?.conflictHandback?.delivered !== false
    ) {
      throw new Error('送信前レコードを確認できませんでした');
    }
  } catch (err) {
    console.warn(`  ${tag}: コンフリクト差し戻しの送信前記録に失敗したため見送り: ${err.message}`);
    return;
  }

  const termId = await ensureConflictHandbackPane(issue, saved, prUrl, tag);
  if (termId == null) return;

  const prompt = buildConflictHandbackPrompt({
    prRef,
    prUrl,
    headRefName: prState.headRefName,
    attempt: decision.attempt,
    maxAttempts: CONFLICT_HANDBACK_MAX,
  });
  try {
    const sent = await submitToClaude(
      VK_PORT,
      termId,
      prompt,
      CLAUDE_SUBMIT_DELAY_MS,
      { maxRetries: CLAUDE_SUBMIT_MAX_RETRIES }
    );
    if (
      sent?.bodyConfirmed === false &&
      !(await reconfirmBodyEcho(VK_PORT, termId, prompt))
    ) {
      console.warn(`  ${tag}: コンフリクト解消依頼の本文到達を再確認できないため in-progress 遷移を見送り`);
      return;
    }
  } catch (err) {
    console.warn(`  ${tag}: コンフリクト解消依頼のペイン送信に失敗: ${err.message}`);
    return;
  }

  try {
    await updateTask(issue.number, {
      conflictHandback: {
        headSha: prState.headSha,
        attempts: decision.attempt,
        sendFailures: 0,
        delivered: true,
        exhaustedNotified: false,
      },
    });
    const delivered = await getTask(issue.number);
    if (
      delivered?.conflictHandback?.headSha !== prState.headSha ||
      delivered?.conflictHandback?.attempts !== decision.attempt ||
      delivered?.conflictHandback?.sendFailures !== 0 ||
      delivered?.conflictHandback?.delivered !== true
    ) {
      throw new Error('配達済みレコードを確認できませんでした');
    }
  } catch (err) {
    console.warn(`  ${tag}: 配達済み記録に失敗したため状態遷移を見送り: ${err.message}`);
    return;
  }

  try {
    await github.setStatus(issue.number, 'status:in-progress');
  } catch (err) {
    console.warn(`  ${tag}: コンフリクト差し戻し後の in-progress 遷移に失敗: ${err.message}`);
    return;
  }
  try {
    await github.addComment(
      issue.number,
      [
        `🔁 コンフリクト差し戻し（${decision.attempt}/${CONFLICT_HANDBACK_MAX} 回目）`,
        '',
        `PR: ${prUrl}`,
        '',
        'この PR が他の変更と衝突してマージできなくなったため、メタ issue を `status:waiting-merge` から `status:in-progress`（作業中）へ戻し、担当エージェントへ次の対応を依頼しました。',
        '',
        '1. コンフリクトを解消する',
        '2. 解消内容を push し、CI の通過を確認する',
        '3. 新しい head SHA（PR ブランチの最新コミット ID）の内容を再レビューする',
        '4. 現 head SHA で `agent-review-passed-sha: <SHA>` コメント（レビュー完了マーカー）を付け直す',
        '',
        '運用者側の操作は不要です。レビュー完了マーカーが現 head SHA と一致すると、自動マージが再開します。',
        `自動差し戻しはタスク 1 件あたり通算 ${CONFLICT_HANDBACK_MAX} 回まで行い、上限に達した場合は改めてこの issue へ通知します。`,
      ].join('\n')
    );
  } catch (err) {
    console.warn(`  ${tag}: コンフリクト差し戻しコメントの投稿失敗（処理は継続）: ${err.message}`);
  }
  console.log(`  ${tag}: PR #${prRef.number} を担当ペインへ差し戻し（${decision.attempt}/${CONFLICT_HANDBACK_MAX} 回目、termId=${termId}）`);
}

async function tryAutoMerge(issue, prRef, prState, prUrl, source) {
  const tag = `[automerge] issue #${issue.number}`;

  if (prState.draft) {
    console.log(`  ${tag}: PR #${prRef.number} は Draft のためスキップ`);
    return;
  }

  // mergeable は GitHub 側で非同期計算され null（計算中）になりうる。
  // 計算中は次ループで再判定する（保守的に止める）。
  if (prState.mergeable === null) {
    console.log(`  ${tag}: PR #${prRef.number} の mergeable 判定が計算中（null）→ 次ループで再判定`);
    return;
  }
  if (isPRConflicted(prState)) {
    console.log(`  ${tag}: PR #${prRef.number} はコンフリクト等で mergeable=false（state=${prState.mergeableState}）→ スキップ`);
    if (source === 'waiting-input') {
      console.log(`  ${tag}: waiting-input は質問待ちの可能性があるためコンフリクト差し戻しを見送り`);
      return;
    }
    try {
      await handbackConflictedPR(issue, prRef, prState, prUrl, tag);
    } catch (err) {
      console.warn(`  ${tag}: コンフリクト差し戻し処理に失敗（自動マージ監視は継続）: ${err.message}`);
    }
    return;
  }

  // コンフリクトが解消された PR では配達状態だけをリセットし、通算試行回数は保持する
  // （記録が無ければ何もしない）。
  await resetResolvedConflictHandbackState(issue.number);

  // CI + CodeRabbit のコメント待ちを再検証する。
  // waiting-merge 到達後に CodeRabbit が再コメントしたケースで誤マージを防ぐ。
  // レビューが来ない設定（監視無効 features.coderabbit=false / レビュー抑止 features.coderabbit_ignore=true）
  // では待機 0 分（即時）になる（prCompletionOptions）。
  // 設定はこのマージ判断 1 回につき 1 度だけ解決し、下のマージ完了コメントの文言にも同じ値を使う。
  const coderabbitCfg = loadCoderabbitFeatureConfig();
  let completion;
  try {
    completion = await github.checkPRCompletion(prRef.owner, prRef.repo, prRef.number, prCompletionOptions(coderabbitCfg));
  } catch (err) {
    console.warn(`  ${tag}: PR完了条件の再検証に失敗（次ループで再試行）: ${err.message}`);
    return;
  }
  if (!completion.ready) {
    console.log(`  ${tag}: 再検証で未充足（CI=${completion.ciPassing} / CodeRabbit=${completion.coderabbitOk}）→ 待機継続`);
    return;
  }

  // エージェントレビュー完了ゲート: レビュー完了マーカーが現 head SHA に対して存在するときだけ進める。
  // 必ず completion.headSha（検証時点の head）で照合する（prState 側の古い sha を使わない＝TOCTOU 回避）。
  // ゲート未充足は「保留（次ループで再判定）」であり失敗ではない。マーカーが付けば次ループでマージされる。
  // マーカー確認の API 失敗も checkPRCompletion と対称に「次ループ再試行（return）」へ丸める。
  // fail-closed: 確認できない間はマージへ進まず保留する（過去の PR 監視 tick クラッシュ対策とも整合）。
  let reviewPassed;
  try {
    reviewPassed = await github.hasReviewGateMarker(prRef.owner, prRef.repo, prRef.number, completion.headSha);
  } catch (err) {
    // マーカーの有無を判定できていないので、停止理由ラベルは付けも外しもしない（fail-closed）。
    // mergeable=null を保留する扱いと同じ思想（誤ったバッジ・通知を出さない）。
    console.warn(`  ${tag}: agent-review-passed マーカー確認に失敗（次ループで再試行）: ${err.message}`);
    return;
  }
  // マーカーが無ければ「要対応: レビュー未完了」バッジを付けて 1 回だけ通知し、
  // マーカーが付いたらバッジを外す（次に同じ状態になれば再通知できる）。
  // source（この issue を拾った status。waiting-merge / waiting-input）がバッジ表示対象の
  // ステータスのときだけラベルを付ける。表示対象外に付けると取り残し掃除が毎ループ外し、
  // 付与→掃除→再付与でコメントが毎ループ増えてしまうため。
  await syncReviewIncompleteBlockedLabel({
    issue,
    prState,
    reviewPassed: reviewPassed === true,
    statusAllowsBlockedLabel: shouldDisplayBlockedReason({
      status: source,
      blockedReason: BLOCKED_REASON_REVIEW_INCOMPLETE,
    }),
    prUrl,
    prRef,
    headSha: completion.headSha,
    tag,
  });
  if (!reviewPassed) {
    console.log(`  ${tag}: PR #${prRef.number} は agent-review-passed マーカー（現 head SHA 一致）が無いため自動マージ保留`);
    return;
  }

  try {
    // 検証時点の head SHA を渡して、検証後・マージ前に push されたコミットを GitHub 側でブロックさせる。
    await github.mergePR(prRef.owner, prRef.repo, prRef.number, {
      method: 'squash',
      sha: completion.headSha,
    });
    // 待機 0 分になる条件（監視無効・レビュー抑止）と文言を食い違わせないため、
    // マージ待ち遷移コメントと同じ coderabbitGateLine() に、ゲート判定と同じ設定を渡す（#215）。
    const coderabbitLine = coderabbitGateLine(coderabbitCfg);
    await github.addComment(
      issue.number,
      `🤖 automerge ラベルに基づき PR を自動マージしました: ${prUrl}\n\n- CI 全通過\n${coderabbitLine}\n- mergeable=true`
    );
    console.log(`  ${tag}: PR #${prRef.number} を squash merge しました`);
  } catch (err) {
    // 405（mergeable=false）, 409（head SHA mismatch / base SHA mismatch）等は次ループで再試行する。
    console.warn(`  ${tag}: PR #${prRef.number} の自動マージ失敗（次ループで再試行）: ${err.message}`);
    return;
  }

  // 自分でマージした直後の経路なので、ペインへは「オーケストレーターがマージしました。」と伝える。
  // 他の呼び出し元（merge-watch / scan-in-progress / reconcile-orphaned）は既定の
  // 「外部マージの可能性あり」文面のまま（マージ主体を断定できないため）。
  await notifyPaneMerged(issue.number, prUrl, tag, { mergedByOrchestrator: true });

  // run-once モードでは次回 checkWaitingMergeIssues() が来ないため、その場で close + done まで進める。
  // 通常ループでも次回の merged 判定が冪等に走るので二重処理にはならないが、こちらで先に閉じることで
  // ユーザーから見た「マージ→close」の体感遅延を短縮する。
  // 対象 issue（個別リポ側）が open のままの場合は部分対応の可能性があるため waiting-merge を維持する。
  await closeSourceIssueBeforeGate(issue, '[automerge]');
  if (!(await canTransitionToDone(issue, '[automerge]'))) {
    return;
  }
  try {
    await github.closeIssue(issue.number);
    await github.setStatus(issue.number, 'status:done');
    console.log(`  ${tag}: issue #${issue.number} を close + status:done に遷移`);
  } catch (err) {
    // ここで失敗してもラベルは waiting-merge のままなので、次ループの merge-watch が拾って再試行する。
    console.warn(`  ${tag}: issue #${issue.number} の完了処理失敗（次ループで再試行）: ${err.message}`);
  }

  // automerge は司ではなく orchestrator がマージするため、司の手動マージ時に vk-kore が
  // 呼ぶ vk-clean-repo（マージ後 cleanup）が走らない。ここで同等の掃除を肩代わりする。
  await runPostMergeCleanup(issue, prRef, prState, tag);
}

// -------------------------------------------------------
// マージ済み issue の作業環境クリーンアップ（automerge / 外部マージ共通）
// state.json に残った wpPort から wp-env コンテナ・worktree を destroy し、
// PR head ブランチも削除する（司の手動マージ時に vk-clean-repo が担う掃除の自動版）。
// 掃除後に state レコードを消すためべき等（二度目は getTask が null で即 return）。
// 失敗しても致命扱いせず done 遷移を優先する（クラッシュ時の cleanupForIssue と同思想）。
// -------------------------------------------------------
// -------------------------------------------------------
// wp-env コンテナが生存しているうちに worktree パスを state.json へ記録する。
// cleanupForIssue は worktree パスを基本的にコンテナのラベルから取るが、
// automerge / 外部マージ検知時にはコンテナが既に destroy 済みのことがある。
// 生存中に snapshot しておけば、コンテナ消滅後でも worktree・ブランチを掃除できる。
// 既に記録済み（同値）なら何もしない。失敗しても致命扱いしない。
// -------------------------------------------------------
async function snapshotWorktreePath(issueNumber) {
  let saved;
  try {
    saved = await getTask(issueNumber);
  } catch {
    saved = null;
  }
  if (!saved || !saved.wpPort) return; // task-queue 管理外 or ポート未記録

  try {
    const info = await inspectWorktreeByPort(saved.wpPort);
    if (info?.worktreePath && info.worktreePath !== saved.worktreePath) {
      await updateTask(issueNumber, { worktreePath: info.worktreePath });
    }
  } catch {
    // docker 未起動・コンテナ消滅などは無視（次ティックで再試行 or 既存記録を使う）
  }
}

async function runPostMergeCleanup(issue, prRef, prState, tag) {
  let saved;
  try {
    saved = await getTask(issue.number);
  } catch {
    saved = null;
  }
  if (!saved) return; // 記録なし＝既に掃除済み or task-queue 管理外のマージ

  try {
    const sourceRepo = prRef?.owner && prRef?.repo ? { owner: prRef.owner, repo: prRef.repo } : null;
    const summary = await cleanupForIssue({
      issueNumber: issue.number,
      wpPort: saved.wpPort ?? null,
      branch: prState?.headRefName ?? null,
      worktreePath: saved.worktreePath ?? null,
      deleteRemoteBranch: sourceRepo
        ? async (branch) => github.deleteRemoteBranch(sourceRepo.owner, sourceRepo.repo, branch)
        : null,
    });
    await github.addComment(
      issue.number,
      `🧹 マージ後クリーンアップを実行しました。\n\n${formatCleanupSummary(summary)}`
    );
    console.log(`  ${tag}: issue #${issue.number} のマージ後クリーンアップ完了`);
  } catch (err) {
    console.warn(`  ${tag}: issue #${issue.number} のマージ後クリーンアップ失敗（致命ではない）: ${err.message}`);
  } finally {
    try { await removeTask(issue.number); } catch {}
  }
}

// -------------------------------------------------------
// 失敗扱いissueの事後復旧
// status:failed の issue について、対象 issue が close 済みになっていれば
// マージ済み PR を timeline 経由で再特定し、見つかれば status:done + close する。
// timeline から close した PR を特定できない場合も、対象 issue が close 済みなら
// 既存の `no_pr_found_target_closed` ルート（「PRなし完了」）と同じ扱いで done にする。
// -------------------------------------------------------
async function recheckFailedIssues() {
  // failed の事後復旧は対象 issue/PR の GitHub 状態照会が前提。無効時はスキップ。
  if (!GITHUB_INTEGRATION) return;
  let issues;
  try {
    issues = await github.fetchFailedIssues();
  } catch (err) {
    console.warn(`[failed-recheck] status:failed issue 取得失敗: ${err.message}`);
    return;
  }

  if (issues.length === 0) return;

  console.log(`[failed-recheck] failed ${issues.length} 件を再チェック`);

  for (const issue of issues) {
    const targetIssue = extractGitHubIssueUrl(
      [issue.title, issue.body].filter(Boolean).join('\n')
    );

    if (!targetIssue) {
      // 汎用タスク（GitHub issue URL を持たない）は対象外
      continue;
    }

    const { owner, repo, number } = targetIssue;

    let targetState;
    try {
      targetState = await github.getIssueState(owner, repo, number);
    } catch (err) {
      console.warn(
        `  [failed-recheck] issue #${issue.number}: 対象 ${owner}/${repo}#${number} 状態取得失敗: ${err.message}`
      );
      continue;
    }

    if (targetState.state !== 'closed') {
      // 対象が open のままでも、PR が既に出ているなら waiting-merge / done に持ち上げる。
      // 30分タイムアウトで failed になった後にPRが立ったケース（ターミナルのidle判定が早すぎたケース等）の救済。
      let openSidePR = null;
      try {
        openSidePR = await github.findPRForIssue(owner, repo, number);
      } catch (err) {
        console.warn(
          `  [failed-recheck] issue #${issue.number}: 対象open側のPR検索失敗: ${err.message}`
        );
        continue;
      }
      if (!openSidePR) {
        // 対象 open + PR 無し: 復旧条件未充足。次ループに送る
        continue;
      }

      let prState;
      try {
        prState = await github.getPRState(owner, repo, openSidePR.number);
      } catch (err) {
        console.warn(
          `  [failed-recheck] issue #${issue.number}: PR状態取得失敗（次ループで再試行）: ${err.message}`
        );
        continue;
      }

      // 本文への PR URL 追記は必ず先に通しておく（後続のマージ検知で参照されるため）。
      // 失敗時は status:failed のまま据え置き、次ループで再試行する。
      // ここで失敗を握りつぶして status:waiting-merge に進めると、本文にPR URLが無いまま
      // 状態だけ進んでしまい、checkWaitingMergeIssues が PR を見失う。
      try {
        await github.appendPRUrlToIssue(issue.number, openSidePR.html_url);
      } catch (err) {
        console.warn(
          `  [failed-recheck] issue #${issue.number}: PR URL 追記失敗（次ループで再試行）: ${err.message}`
        );
        continue;
      }

      if (prState.merged) {
        // 対象 issue が open のままだが PR がマージ済みのルート。
        // PR マージ済みなら gate の直前で対象 issue を明示 close し、次の状態確認で done 化できるようにする。
        await closeSourceIssueBeforeGate(issue, '[failed-recheck]');
        if (!(await canTransitionToDone(issue, '[failed-recheck]'))) {
          continue;
        }
        console.log(
          `  [failed-recheck] issue #${issue.number}: 対象 ${owner}/${repo}#${number} は open のままだがPR #${openSidePR.number} がマージ済み → 完了`
        );
        try {
          await github.addComment(
            issue.number,
            `✅ 完了（事後検知）\n\nPR: ${openSidePR.html_url} がマージ済みのため復旧しました。対象 issue は open のままなので必要に応じて手動で close してください。`
          );
          await github.closeIssue(issue.number);
          await github.setStatus(issue.number, 'status:done');
        } catch (err) {
          console.warn(
            `  [failed-recheck] issue #${issue.number}: 完了処理失敗（次ループで再試行）: ${err.message}`
          );
        }
      } else if (prState.state === 'open') {
        console.log(
          `  [failed-recheck] issue #${issue.number}: 対象 ${owner}/${repo}#${number} に open PR #${openSidePR.number} → status:waiting-merge に復旧`
        );
        try {
          await github.setStatus(issue.number, 'status:waiting-merge');
          await github.addComment(
            issue.number,
            `🟢 マージ待ちに復旧（事後検知）\n\nPR: ${openSidePR.html_url}\n\nマージされたら自動で close されます。`
          );
        } catch (err) {
          console.warn(
            `  [failed-recheck] issue #${issue.number}: 状態遷移失敗（次ループで再試行）: ${err.message}`
          );
        }
      } else {
        // closed_unmerged: 人手レビューが必要なので failed のまま据え置く（無限ループ防止のため再コメントもしない）
        console.log(
          `  [failed-recheck] issue #${issue.number}: PR #${openSidePR.number} が未マージのまま closed → failed 継続`
        );
      }
      continue;
    }

    // ここから先は対象 issue が closed のケース（従来通り）
    // close した PR を timeline から特定（マージ済みでなければ「PRなし完了」扱い）
    let closedPR = null;
    try {
      closedPR = await github.findPRThatClosedIssue(owner, repo, number);
    } catch (err) {
      console.warn(
        `  [failed-recheck] issue #${issue.number}: close PR 探索失敗: ${err.message}`
      );
      continue;
    }

    if (closedPR && closedPR.merged_at) {
      // この経路に来ているのは対象が closed と確認できた後だが、
      // 全 done 遷移箇所で同じゲートを通す方針に合わせて改めて再確認する。
      // 万一 reopen 等で open に変わっていたら見送り、次ループで再評価する。
      if (!(await canTransitionToDone(issue, '[failed-recheck]'))) {
        continue;
      }
      console.log(
        `  [failed-recheck] issue #${issue.number}: 対象 ${owner}/${repo}#${number} がマージ済み PR #${closedPR.number} で close 済み → 完了`
      );
      try {
        await github.appendPRUrlToIssue(issue.number, closedPR.html_url);
      } catch (err) {
        console.warn(
          `  [failed-recheck] issue #${issue.number}: PR URL 追記失敗（処理は継続）: ${err.message}`
        );
      }
      try {
        await github.addComment(
          issue.number,
          `✅ 完了（事後検知）\n\nPR: ${closedPR.html_url} がマージ済みのため復旧しました。`
        );
        await github.closeIssue(issue.number);
        await github.setStatus(issue.number, 'status:done');
      } catch (err) {
        console.warn(
          `  [failed-recheck] issue #${issue.number}: 完了処理失敗（次ループで再試行）: ${err.message}`
        );
      }
    } else {
      // 対象は closed だが merged PR を特定できない（手動 close 等）。
      // 既存の `no_pr_found_target_closed` ルートに揃えて「PRなし完了」とみなす。
      // ただし対象 issue が open に変わっていれば見送り、次ループで再評価する。
      if (!(await canTransitionToDone(issue, '[failed-recheck]'))) {
        continue;
      }
      console.log(
        `  [failed-recheck] issue #${issue.number}: 対象 ${owner}/${repo}#${number} は close 済みだが merged PR を特定できず → PRなし完了として処理`
      );
      try {
        await github.addComment(
          issue.number,
          `✅ 完了（事後検知 / PRなし）\n\n対象 issue ${owner}/${repo}#${number} が close 済みのため復旧しました。`
        );
        await github.closeIssue(issue.number);
        await github.setStatus(issue.number, 'status:done');
      } catch (err) {
        console.warn(
          `  [failed-recheck] issue #${issue.number}: 完了処理失敗（次ループで再試行）: ${err.message}`
        );
      }
    }
  }
}

// -------------------------------------------------------
// 作業対象リポジトリからのタスク取り込み（polling 方式）
// SOURCE_ORG 内で `task-queue` ラベルが付いた open issue を組織横断検索し、
// 未取り込みのものをタスク登録リポジトリに status:awaiting-approval で複製する。
// 承認（status:ready への切り替え）と sequential / priority の付与は人手で行う。
// -------------------------------------------------------

// importNewTasks の単一実行ガード（同一プロセス内の再入防止のみ）。
// watch モードでは setInterval が前回 loop の完了を待たずに次の loop を発火させうるため、
// 同一プロセスで search → create が二重に走るのを防ぐ。
// 別プロセス／別端末との二重取り込みはこのフラグでは防げないため、
// ループ本体で removeLabel（強整合）を所有権ロックに使って防いでいる。
let isImportingTasks = false;

async function importNewTasks() {
  // GitHub 連携無効（トークン無しローカルモード）では作業対象リポジトリの取り込みは行わない。
  if (!GITHUB_INTEGRATION) return;
  if (isImportingTasks) {
    console.log('[import] 前回の取り込み処理が継続中のためスキップ');
    return;
  }
  isImportingTasks = true;

  try {
    let sourceIssues;
    try {
      sourceIssues = await github.searchSourceIssuesByLabel(SOURCE_ORG, QUEUE_LABEL);
    } catch (err) {
      console.warn(`[import] 作業対象リポジトリの Issue 検索失敗: ${err.message}`);
      return;
    }

    if (sourceIssues.length === 0) return;

    console.log(`[import] task-queue ラベル付き作業対象リポジトリの Issue ${sourceIssues.length} 件を検出`);

    for (const src of sourceIssues) {
      let existing;
      try {
        existing = await github.findTaskQueueIssueBySourceUrl(src.html_url);
      } catch (err) {
        console.warn(`  [import] 既存チェック失敗 (${src.html_url}): ${err.message}`);
        continue;
      }
      if (existing) {
        // open / closed どちらでも取り込み済みなのでスキップ
        continue;
      }

      // 所有権の確保: source 側の `task-queue` ラベルを「先に」外す。
      // REST の removeLabel は強整合なので、複数端末が同時に取り込みを試みても
      // ここを成功させた1台だけが create に進む（他端末は 404 → false でスキップ）。
      // dedup（findTaskQueueIssueBySourceUrl）は Search API 経由でインデックス遅延が
      // あり単独では二重取り込みを防げないため、この removeLabel がクレームの要。
      let claimed;
      try {
        claimed = await github.claimSourceIssueByLabelRemoval(src);
      } catch (err) {
        console.warn(`  [import] 所有権確保（ラベル剥がし）失敗 (${src.html_url}): ${err.message}`);
        continue;
      }
      if (!claimed) {
        // 他端末が先に確保済み（ラベルは既に無い）。スキップ。
        continue;
      }

      let created;
      try {
        created = await github.createTaskQueueIssueFromSource(src);
        console.log(`  [import] ${src.html_url} → ${created.html_url}`);
      } catch (err) {
        // 所有権は確保した（ラベルを外した）が create に失敗した。
        // このままだと source がどのラベルも無い orphan になり二度と拾われないため、
        // `task-queue` ラベルを再付与してロールバックし、次ループでリトライ可能にする。
        console.warn(`  [import] 作成失敗 (${src.html_url}): ${err.message} → ラベル再付与でロールバック`);
        try {
          await github.restoreSourceTaskQueueLabel(src);
        } catch (rollbackErr) {
          console.warn(`  [import] ロールバック（ラベル再付与）失敗 (${src.html_url}): ${rollbackErr.message}`);
        }
        continue;
      }

      // 取り込み成功後は source 側 issue に「作業中」ラベルを付ける。
      // vk-kore の実行開始時点まで待つと awaiting-approval 〜 ready の間
      // source 側にマーカーが無く進行状況が分かりにくいため、取り込み時点で付与する
      // （vk-kore 実行開始時の付与は冪等なのでそのまま共存できる）。
      // 失敗しても取り込み自体は成功しているので warn のみ。
      try {
        await github.addSourceWorkingLabel(src);
      } catch (err) {
        console.warn(`  [import] source 作業中ラベル付与失敗 (${src.html_url}): ${err.message}`);
      }

      // 作業対象リポジトリ側 issue に「オーケストレーターが取り込みました」通知コメントを投稿する。
      // 取り込み後はラベルが外れて一覧でも見分けが付かなくなるため、
      // 作業対象リポジトリ側を見る人がメタ issue へ辿れるようコメントで補完する。
      // dedup は二重作成防止だけを担保しており、コメント投稿に失敗しても次ループで
      // 再投稿はしない（同じ issue に何度もコメントが付くのを避ける）。warn ログのみ。
      try {
        await github.postSourceImportComment(src, created.html_url);
      } catch (err) {
        console.warn(`  [import] source 取り込みコメント投稿失敗 (${src.html_url}): ${err.message}`);
      }
    }
  } finally {
    isImportingTasks = false;
  }
}

// -------------------------------------------------------
// メインループ
// -------------------------------------------------------
async function loopBody() {
  try {
    writeAgentRulesHandoff();
  } catch (err) {
    console.warn(`[warn] agent rules handoff file の書き出しに失敗しました: ${err.message}`);
  }

  // 1. 作業対象リポジトリから新規タスクを取り込む（VK Terminals 不要）
  //    assignee 未設定時は安全側として何も拾わず、"all" 明示時のみすべての作業対象リポジトリの Issue を取り込む。
  //    ログイン名指定時は「自分にアサインされた作業対象リポジトリの Issue だけ」を取り込み、
  //    取り込んだメタ issue にも取り込んだユーザーをアサインする（担当がタスク登録リポジトリ側でも分かる）。
  //    それでも複数端末が同時に取り込みを試みる可能性はあるため、importNewTasks 内で
  //    REST の removeLabel（強整合）を所有権ロックに使い、ラベルを実際に外せた1台だけが
  //    create するため二重取り込みにはならない。
  //    pickupEnabled=false の場合は fetch 系が空配列を返すため、取り込み・実行とも何もしない。
  await importNewTasks();

  // 2. VK Terminals からのステータス変更コマンドを消化する（VK Terminals 不要）
  const cmdSummary = await commandsFileProcessor.consumeOnce();
  if (cmdSummary && cmdSummary.applied > 0) {
    await refreshTasksSnapshots(github, { logger: console, viewer: ASSIGNEE_FILTER });
  }

  // 3. in-progress スキャン: 指示待ち検知 → waiting-input / PR 完了 → waiting-merge /
  //    PR マージ → done / PR 未マージ closed → failed（VK Terminals 不要。PR アイコンのみ任意）
  await scanInProgressIssues();

  // 4. マージ待ち issue のマージ検知 + automerge（VK Terminals 不要）
  await checkWaitingMergeIssues();

  // 5. 失敗扱いになった issue の事後復旧チェック（VK Terminals 不要）
  await recheckFailedIssues();

  // 6. answered 復帰スキャン: `Status: answered` の waiting-input を in-progress へ戻す。
  //    返信転送不要なので VK Terminals に依存せず、健全性ゲートより前で回す（VK Terminals 不要）。
  await scanAnsweredRecovery();

  // 7. ここから先（返信転送・後始末・dispatch）は VK Terminals が必要
  const healthy = await checkHealth(VK_PORT);
  if (!healthy) {
    console.log(`[warn] VK Terminals (port ${VK_PORT}) に接続できません。返信転送・後始末・起動をスキップします。`);
    return;
  }

  // 8. 新しい版があるかを一定間隔で確認し直す（常駐中は当てず、知らせるだけ）。
  //    確認はループを待たせずに走らせ、結果は次のループのサイドバー再投稿で反映される。
  scheduleUpdateStatusRefresh();

  // 9. VK Terminals の再起動で消える注入メニューを、接続確立後に毎回冪等に再投稿する
  await syncOrchestratorMenu();

  // 10. 指示待ちスキャン: ユーザー返信を pane に転送して in-progress に戻す
  await scanWaitingInputIssues();

  // 11. issue 連動ペインの入力待ちマーカーを push（waiting-input ラベルへの完全鏡写し）。
  //    VK Terminals states の生存ペインへ反映するため checkHealth 後ろ
  await scanWaitingMarkers();

  // 12. ウォッチドッグ（安全網）: 無言で死んだ/ハングした in-progress タスクを failed に倒す
  //    （VK Terminals states で pane の生死・無反応を見るため checkHealth 後ろ）
  await scanWatchdog();

  // 13. 先回りクローズ済み + PR マージ済みの state 残骸を後始末
  //     VK Terminals が到達不能な間は prMerged 通知を送れないため、
  //     health 確認済みのループでのみ通知してから state を消し込む。
  //     PR マージ検知が前提のため GitHub 連携無効時はスキップ。
  if (GITHUB_INTEGRATION) {
    await reconcileOrphanedMergedTasks();
  }

  // 14. ready をディスパッチ
  const issues = await github.fetchPendingIssues();
  if (issues.length === 0) {
    console.log('[poll] 実行待ちタスクなし');
    return;
  }

  console.log(`[poll] ${issues.length} 件のタスクを検出`);

  // sequential 判定: 現在「作業中」の作業対象リポジトリ集合を GitHub の状態から集める
  // （in-memory のカウンタではなくラベル状態を真実の源にする）。
  const occupiedRepos = await getOccupiedRepoKeys();

  await dispatchReadyIssues(
    issues,
    {
      inFlightIssues,
      occupiedRepos,
      getTargetRepoKey,
      isSequential: (issue) => github.isSequential(issue),
      startTask,
      getTask,
      getStates,
      setStatus: (issueNumber, label) => github.setStatus(issueNumber, label),
      formatErrorSummary,
    },
    { port: VK_PORT, logger: console }
  );
}

async function loop() {
  try {
    await loopBody();
  } finally {
    const snapshots = await refreshTasksSnapshots(github, {
      logger: console,
      viewer: ASSIGNEE_FILTER,
    });
    if (snapshots?.issues) {
      await reconcileStaleBlockedLabels(snapshots.issues);
    }
  }
}

// -------------------------------------------------------
// エントリポイント
// -------------------------------------------------------
async function main() {
  // watch だけでなく --once も state.json を読み書きするため、同時起動すると
  // termId 取得や cleanup の state 更新が競合しうる。短命の run-once でも同じ
  // ロックを取得し、常駐 watch と同時に走らないようにする。
  const startLock = createStartLock({ logger: console });
  await startLock.acquire();
  process.on('exit', () => startLock.releaseSync());

  // VK Terminals 上で実行されている場合、自分のペインタイトルを「オーケストレーター」に
  // 設定して、どのペインが orchestrator か一目で分かるようにする（issue #157）。
  // TTY でない場合（ログへのリダイレクト等）は setOwnPaneTitle 側で何もしない。
  try {
    setOwnPaneTitle('オーケストレーター');

    console.log(`=== task-queue orchestrator ===`);
    console.log(`  repo         : ${GITHUB_OWNER}/${GITHUB_REPO}`);
    console.log(`  source org   : ${SOURCE_ORG}`);
    console.log(`  queue backend: ${queueBackend}`);
    console.log(`  github 連携  : ${GITHUB_INTEGRATION ? '有効' : `無効（純ローカルタスク専用: ${disabledGitHubFeatures().join(' / ')} をスキップ）`}`);
    console.log(`  assignee     : ${formatAssigneeMode(github)}`);
    console.log(`  terminal     : http://127.0.0.1:${VK_PORT}`);
    console.log(`  interval     : ${POLL_INTERVAL / 1000}s`);
    console.log(`  watchdog idle: ${WATCHDOG_IDLE / 60000}min`);
    console.log(`  pane resume  : 最大 ${PANE_RESUME_MAX} 回（pane 消失・PR 未生成時の自動再開）`);
    console.log(`  conflict戻し: 最大 ${CONFLICT_HANDBACK_MAX} 回（automerge PR のコンフリクト差し戻し）`);
    console.log(`  mode         : ${RUN_ONCE ? 'run-once' : 'watch'}`);
    console.log('');

    // 起動時リカバリーは廃止（新方針 案B）。orchestrator を再起動しても VK Terminals 側の
    // pane は生き残っているため、in-progress / waiting-input の issue はラベルのまま残し、
    // 通常ループのスキャナに委ねる（古い pane が生きていれば作業継続、死んでいれば
    // scanWatchdog が wp-env クリーンアップのうえ failed に倒す）。これにより、既存 PR が
    // あるのに ready へ戻して重複 PR を作る #40 の事故も構造的に起きない。

    if (RUN_ONCE) {
      // 案B（ステートレス・スキャナ方式）では起動は撃ちっぱなしで、状態は GitHub の
      // ラベルに永続する。run-once は 1 周だけ走って終了する（進行中タスクは次回起動の
      // スキャナが拾う）。
      await loop();
      await startLock.release();
      return;
    }

    // watch 中は OS がアイドルスリープに入るとポーリングごと止まってしまうため、
    // OS ごとの方法でシステムスリープを抑止する（run-once は短命なので不要）。
    // macOS は caffeinate、Windows は SetThreadExecutionState。未対応 OS は警告のみ。
    const keepAwake = startKeepAwake();
    const commandsWatcher = startCommandsFileWatcher(commandsFileProcessor, {
      logger: console,
      afterConsume: async (summary) => {
        if (summary && summary.applied > 0) {
          await refreshTasksSnapshots(github, { logger: console, viewer: ASSIGNEE_FILTER });
        }
      },
    });
    // graceful shutdown 時にスリープ抑止と起動ロックを即時解除する。
    // Ctrl-C / kill 時に待たず解放する。SIGINT / SIGTERM は解除後に自前で終了する。
    process.on('exit', () => {
      commandsWatcher.close();
      keepAwake.stop();
    });
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => {
        commandsWatcher.close();
        keepAwake.stop();
        startLock.releaseSync();
        process.exit(0);
      });
    }

    // watch モード: 初回 loop を起動し、setInterval で定期実行する。
    // setInterval 経由の呼び出しは safe wrapper を通して unhandled rejection を防ぐ。
    const runLoopSafely = () => loop().catch(err => console.error('[Loop]', formatErrorSummary(err)));
    runLoopSafely();
    setInterval(runLoopSafely, POLL_INTERVAL);
  } catch (err) {
    await startLock.release();
    throw err;
  }
}

main().catch(err => {
  console.error('[Fatal]', formatErrorSummary(err));
  process.exit(1);
});
