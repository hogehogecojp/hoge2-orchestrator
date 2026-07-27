import { DEFAULT_LABELS, getLabelsConfig, resolveTasksViewPath, writeJsonAtomic } from '../config.js';
import { buildTasksWidget, writeTasksWidgetFile } from './tasks-widget.js';

const ISSUE_URL_RE = /https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/issues\/\d+/;
const PR_URL_RE = /\*\*PR:\*\*\s*(https:\/\/github\.com\/[^\s]+\/pull\/\d+)/g;
const PRIORITY_PREFIX = 'priority:';
const PRIORITY_VALUES = new Set(['high', 'medium', 'low']);

function labelName(label) {
  return typeof label === 'string' ? label : label?.name;
}

function assigneeLogin(assignee) {
  if (typeof assignee === 'string') return assignee;
  return assignee?.login ?? null;
}

export function extractTargetIssueUrl(body) {
  if (!body) return null;
  return body.match(ISSUE_URL_RE)?.[0] ?? null;
}

export function extractPRUrl(body) {
  if (!body) return null;
  const matches = [...body.matchAll(PR_URL_RE)];
  return matches.length > 0 ? matches.at(-1)[1] : null;
}

export function normalizeTaskIssue(issue, options = {}) {
  const labelsConfig = options.labelsConfig ?? getLabelsConfig();
  const automergeLabel = labelsConfig.automerge ?? DEFAULT_LABELS.automerge;
  const labels = (issue.labels ?? [])
    .map(labelName)
    .filter((name) => typeof name === 'string' && name !== '');
  const statusLabel = labels.find((name) => name.startsWith('status:')) ?? null;
  const priorityLabel = labels.find((name) => name.startsWith(PRIORITY_PREFIX)) ?? null;
  const priority = priorityLabel?.slice(PRIORITY_PREFIX.length) ?? null;
  const assignees = (issue.assignees ?? [])
    .map(assigneeLogin)
    .filter((login) => typeof login === 'string' && login !== '');

  return {
    id: String(issue.number),
    number: issue.number,
    title: issue.title ?? '',
    status: statusLabel ? statusLabel.slice('status:'.length) : null,
    statusLabel,
    priority: PRIORITY_VALUES.has(priority) ? priority : null,
    sequential: labels.includes('sequential'),
    automerge: labels.includes(automergeLabel),
    assignee: assignees[0] ?? null,
    assignees,
    targetIssueUrl: extractTargetIssueUrl(issue.body),
    prUrl: extractPRUrl(issue.body),
    queueIssueUrl: issue.html_url ?? issue.htmlUrl ?? null,
    updatedAt: issue.updated_at ?? issue.updatedAt ?? null,
  };
}

// assignee フィルタ値から「自分（viewer）」のログイン名を解決する。
// 具体的なログイン名（非空・`all` 以外）ならその値（前後空白は trim、大小文字は保持）、
// `all`（大小文字問わず）/ 空文字 / null / undefined など単一の自分を特定できない場合は null。
function resolveViewer(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'all') return null;
  return trimmed;
}

export function buildTasksView(issues, options = {}) {
  const now = options.now ?? new Date();
  const updatedAt = now instanceof Date ? now.toISOString() : String(now);
  const labelsConfig = options.labelsConfig ?? getLabelsConfig();
  return {
    updatedAt,
    viewer: resolveViewer(options.viewer),
    tasks: issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => normalizeTaskIssue(issue, { labelsConfig })),
  };
}

// タスクキュー上の全タスク（open issue）を取得する。
// クライアント抽象のインターフェースメソッド経由でのみ取得し、GitHub API を直叩きしない
// （キューの保存先を GitHub 以外に差し替え可能にするため）。
export async function fetchAllTaskQueueIssues(github) {
  return github.listAllQueueIssues();
}

export async function writeTasksViewFile(view, options = {}) {
  const filePath = options.filePath ?? resolveTasksViewPath();
  writeJsonAtomic(filePath, view);
  return filePath;
}

export async function writeTasksViewSnapshot(github, options = {}) {
  const issues = options.issues ?? await fetchAllTaskQueueIssues(github);
  const view = buildTasksView(issues, { now: options.now, viewer: options.viewer });
  const filePath = await writeTasksViewFile(view, { filePath: options.filePath });
  return { filePath, view };
}

export async function refreshTasksViewSnapshot(github, options = {}) {
  const logger = options.logger ?? console;
  try {
    return await writeTasksViewSnapshot(github, options);
  } catch (err) {
    logger.warn?.(`[tasks-view] tasks-view.json 書き出し失敗（処理は継続）: ${err.message}`);
    return null;
  }
}

// -------------------------------------------------------
// dual-write（新旧併存）
//
// #182 で導入した宣言的ウィジェット（tasks-widget.json）へ移行する過渡期は、旧
// tasks-view.json（従来の純データ）と新 tasks-widget.json の両方を同じ issue 取得
// 結果から書き出す。旧形式の廃止は #229 リリース後の後続 PR で行う。
// どちらの書き出しも独立して警告握りつぶしにし、片方が失敗しても他方とポーリング処理を止めない。
// -------------------------------------------------------

/**
 * issue 群から tasks-view と tasks-widget を組み立て、両ファイルへ dual-write する。
 * issue の取得は 1 回だけ行い、同じ view を両形式の元データに使う。
 * @param {object} github キュークライアント
 * @param {{ issues?: Array<object>, now?: Date, viewer?: string, staleThresholdMs?: number,
 *   tasksViewPath?: string, tasksWidgetPath?: string, domain?: object }} [options]
 * @returns {Promise<{ view: object, widget: object, tasksViewPath: string, tasksWidgetPath: string }>}
 */
export async function writeTasksSnapshots(github, options = {}) {
  const issues = options.issues ?? await fetchAllTaskQueueIssues(github);
  const view = buildTasksView(issues, { now: options.now, viewer: options.viewer });
  const tasksViewPath = await writeTasksViewFile(view, { filePath: options.tasksViewPath });

  const widget = buildTasksWidget(view, {
    domain: options.domain,
    now: options.now,
    staleThresholdMs: options.staleThresholdMs,
  });
  const tasksWidgetPath = await writeTasksWidgetFile(widget, { filePath: options.tasksWidgetPath });

  return { view, widget, tasksViewPath, tasksWidgetPath };
}

/**
 * writeTasksSnapshots の失敗握りつぶし版。issue 取得と各書き出しを可能な限り進め、
 * 失敗は warn で記録してポーリング処理を止めない。
 * @param {object} github キュークライアント
 * @param {object} [options] writeTasksSnapshots と同じ options（logger を追加で受ける）
 * @returns {Promise<{ view: object|null, widget: object|null }|null>}
 */
export async function refreshTasksSnapshots(github, options = {}) {
  const logger = options.logger ?? console;
  let view = null;
  try {
    const issues = options.issues ?? await fetchAllTaskQueueIssues(github);
    view = buildTasksView(issues, { now: options.now, viewer: options.viewer });
  } catch (err) {
    logger.warn?.(`[tasks-view] タスク一覧の取得に失敗（処理は継続）: ${err.message}`);
    return null;
  }

  // 旧 tasks-view.json の書き出し（#229 リリース後の後続 PR で廃止予定）。
  try {
    await writeTasksViewFile(view, { filePath: options.tasksViewPath });
  } catch (err) {
    logger.warn?.(`[tasks-view] tasks-view.json 書き出し失敗（処理は継続）: ${err.message}`);
  }

  // 新 tasks-widget.json の書き出し。
  let widget = null;
  try {
    widget = buildTasksWidget(view, {
      domain: options.domain,
      now: options.now,
      staleThresholdMs: options.staleThresholdMs,
    });
    await writeTasksWidgetFile(widget, { filePath: options.tasksWidgetPath });
  } catch (err) {
    widget = null;
    logger.warn?.(`[tasks-view] tasks-widget.json 書き出し失敗（処理は継続）: ${err.message}`);
  }

  return { view, widget };
}
