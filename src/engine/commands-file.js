import { promises as fsPromises, watch as fsWatch } from 'fs';
import { basename, dirname, join } from 'path';
import { DEFAULT_LABELS, getLabelsConfig, resolveCommandsPath, writeJsonAtomic } from '../config.js';
import { ALLOWED_TRANSITIONS, isAllowedTransition } from './task-domain.js';

// 遷移マトリクスは task-domain.js を正本とし、ここからは import して使う（挙動不変のリファクタ）。
// 従来 commands-file.js から import していた呼び出し元（テスト等）との後方互換のため再エクスポートする。
export { ALLOWED_TRANSITIONS, isAllowedTransition };

const STATUS_PREFIX = 'status:';
const PRIORITY_PREFIX = 'priority:';
const STATE_VERSION = 1;
const DEFAULT_RECENT_ID_LIMIT = 1000;
const DEFAULT_TRANSIENT_RETRY_LIMIT = 3;
const SEQUENTIAL_VALUES = new Set(['sequential', 'parallel']);
const AUTOMERGE_VALUES = new Set(['automerge', 'manual']);
const SINGLE_COMMAND_ACTIONS = new Set(['set-status', 'set-priority', 'set-sequential', 'set-automerge']);
const BATCH_OPERATION_ORDER = ['set-priority', 'set-sequential', 'set-automerge', 'set-status'];
const BATCH_FIELD_BY_ACTION = {
  'set-status': 'status',
  'set-priority': 'priority',
  'set-sequential': 'sequential',
  'set-automerge': 'automerge',
};

function labelName(label) {
  return typeof label === 'string' ? label : label?.name;
}

function statusLabelsFromConfig(labelsConfig = getLabelsConfig()) {
  return labelsConfig?.status ?? DEFAULT_LABELS.status;
}

export function buildStatusLabelMaps(labelsConfig = getLabelsConfig()) {
  const statusLabels = statusLabelsFromConfig(labelsConfig);
  const bareToLabel = new Map();
  const labelToBare = new Map();

  for (const label of Object.values(statusLabels)) {
    if (typeof label !== 'string' || !label.startsWith(STATUS_PREFIX)) continue;
    const bare = label.slice(STATUS_PREFIX.length);
    bareToLabel.set(bare, label);
    labelToBare.set(label, bare);
  }

  return { bareToLabel, labelToBare };
}

export function normalizeStatusName(value, labelsConfig = getLabelsConfig()) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const { bareToLabel, labelToBare } = buildStatusLabelMaps(labelsConfig);
  if (labelToBare.has(raw)) return labelToBare.get(raw);

  const bare = raw.startsWith(STATUS_PREFIX) ? raw.slice(STATUS_PREFIX.length) : raw;
  return bareToLabel.has(bare) ? bare : null;
}

export function statusLabelFor(value, labelsConfig = getLabelsConfig()) {
  const bare = normalizeStatusName(value, labelsConfig);
  if (!bare) return null;
  return buildStatusLabelMaps(labelsConfig).bareToLabel.get(bare) ?? null;
}

function priorityLabelsFromConfig(labelsConfig = getLabelsConfig()) {
  return labelsConfig?.priority ?? DEFAULT_LABELS.priority;
}

export function buildPriorityLabelMaps(labelsConfig = getLabelsConfig()) {
  const priorityLabels = priorityLabelsFromConfig(labelsConfig);
  const bareToLabel = new Map();
  const labelToBare = new Map();

  for (const [bare, label] of Object.entries(priorityLabels)) {
    if (!['high', 'medium', 'low'].includes(bare)) continue;
    if (typeof label !== 'string' || !label.startsWith(PRIORITY_PREFIX)) continue;
    bareToLabel.set(bare, label);
    labelToBare.set(label, bare);
  }

  return { bareToLabel, labelToBare };
}

export function normalizePriorityName(value, labelsConfig = getLabelsConfig()) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw === 'none') return 'none';

  const { bareToLabel, labelToBare } = buildPriorityLabelMaps(labelsConfig);
  if (labelToBare.has(raw)) return labelToBare.get(raw);

  const bare = raw.startsWith(PRIORITY_PREFIX) ? raw.slice(PRIORITY_PREFIX.length) : raw;
  return bareToLabel.has(bare) ? bare : null;
}

export function priorityLabelFor(value, labelsConfig = getLabelsConfig()) {
  const bare = normalizePriorityName(value, labelsConfig);
  if (!bare || bare === 'none') return null;
  return buildPriorityLabelMaps(labelsConfig).bareToLabel.get(bare) ?? null;
}

export function normalizeSequentialName(value, labelsConfig = getLabelsConfig()) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (SEQUENTIAL_VALUES.has(raw)) return raw;
  return raw === labelsConfig?.sequential ? 'sequential' : null;
}

export function normalizeAutomergeName(value, labelsConfig = getLabelsConfig()) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (AUTOMERGE_VALUES.has(raw)) return raw;
  return raw === (labelsConfig?.automerge ?? DEFAULT_LABELS.automerge) ? 'automerge' : null;
}

export function extractIssueStatus(issue, labelsConfig = getLabelsConfig()) {
  const labels = (issue?.labels ?? [])
    .map(labelName)
    .filter((name) => typeof name === 'string' && name !== '');
  const statusLabel = labels.find((name) => name.startsWith(STATUS_PREFIX));
  return statusLabel ? normalizeStatusName(statusLabel, labelsConfig) : null;
}

export function extractIssuePriority(issue, labelsConfig = getLabelsConfig()) {
  const labels = (issue?.labels ?? [])
    .map(labelName)
    .filter((name) => typeof name === 'string' && name !== '');
  const priorityLabel = labels.find((name) => name.startsWith(PRIORITY_PREFIX));
  return priorityLabel ? normalizePriorityName(priorityLabel, labelsConfig) ?? 'none' : 'none';
}

export function extractIssueSequential(issue, labelsConfig = getLabelsConfig()) {
  const labels = (issue?.labels ?? [])
    .map(labelName)
    .filter((name) => typeof name === 'string' && name !== '');
  return labels.includes(labelsConfig?.sequential ?? DEFAULT_LABELS.sequential) ? 'sequential' : 'parallel';
}

export function extractIssueAutomerge(issue, labelsConfig = getLabelsConfig()) {
  const labels = (issue?.labels ?? [])
    .map(labelName)
    .filter((name) => typeof name === 'string' && name !== '');
  return labels.includes(labelsConfig?.automerge ?? DEFAULT_LABELS.automerge) ? 'automerge' : 'manual';
}

function normalizeTaskId(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

function sanitizeLogText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function logId(value) {
  return sanitizeLogText(value) || '(unknown)';
}

function formatTimestamp(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseCommandLine(line, lineNumber, logger) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn?.(`[commands-file] ${lineNumber} 行目は JSON object ではないため無視します`);
      return null;
    }
    return parsed;
  } catch {
    logger.warn?.(`[commands-file] ${lineNumber} 行目の JSON パースに失敗したため無視します`);
    return null;
  }
}

function normalizeRecentIds(ids, limit = DEFAULT_RECENT_ID_LIMIT) {
  if (!Array.isArray(ids)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of ids) {
    const id = String(raw ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(-limit);
}

function createEmptyCommandState() {
  return {
    version: STATE_VERSION,
    consumedLines: 0,
    recentIds: [],
    retry: null,
  };
}

export async function readCommandsState(statePath, options = {}) {
  const recentIdLimit = options.recentIdLimit ?? DEFAULT_RECENT_ID_LIMIT;
  try {
    const text = await fsPromises.readFile(statePath, 'utf8');
    const parsed = JSON.parse(text);
    const legacyIds = Array.isArray(parsed) ? parsed : parsed?.ids;
    if (Array.isArray(legacyIds) && !Number.isInteger(parsed?.consumedLines)) {
      const ids = normalizeRecentIds(legacyIds, Number.POSITIVE_INFINITY);
      return {
        ...createEmptyCommandState(),
        legacyIds: ids,
        recentIds: normalizeRecentIds(ids, recentIdLimit),
      };
    }

    const consumedLines = Number.isInteger(parsed?.consumedLines) && parsed.consumedLines > 0
      ? parsed.consumedLines
      : 0;
    const retry = parsed?.retry && Number.isInteger(parsed.retry.lineNumber)
      ? {
          lineNumber: parsed.retry.lineNumber,
          attempts: Number.isInteger(parsed.retry.attempts) && parsed.retry.attempts > 0
            ? parsed.retry.attempts
            : 0,
          firstFailedAt: typeof parsed.retry.firstFailedAt === 'string' ? parsed.retry.firstFailedAt : null,
          lastFailedAt: typeof parsed.retry.lastFailedAt === 'string' ? parsed.retry.lastFailedAt : null,
        }
      : null;

    return {
      version: STATE_VERSION,
      consumedLines,
      recentIds: normalizeRecentIds(parsed?.recentIds, recentIdLimit),
      retry,
    };
  } catch (err) {
    if (err.code === 'ENOENT') return createEmptyCommandState();
    throw err;
  }
}

export async function writeCommandsState(statePath, state, now = new Date(), options = {}) {
  const recentIdLimit = options.recentIdLimit ?? DEFAULT_RECENT_ID_LIMIT;
  const payload = {
    version: STATE_VERSION,
    consumedLines: Math.max(0, Number.isInteger(state?.consumedLines) ? state.consumedLines : 0),
    recentIds: normalizeRecentIds(state?.recentIds, recentIdLimit),
    retry: state?.retry ?? null,
    updatedAt: now instanceof Date ? now.toISOString() : String(now),
  };
  writeJsonAtomic(statePath, payload);
}

export async function readProcessedCommandIds(processedPath) {
  try {
    const text = await fsPromises.readFile(processedPath, 'utf8');
    const parsed = JSON.parse(text);
    const ids = Array.isArray(parsed) ? parsed : parsed?.ids ?? parsed?.recentIds;
    if (!Array.isArray(ids)) return new Set();
    return new Set(ids.map((id) => String(id)).filter((id) => id !== ''));
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
}

export async function writeProcessedCommandIds(processedPath, ids, now = new Date()) {
  await writeCommandsState(processedPath, {
    ...createEmptyCommandState(),
    recentIds: [...ids].sort(),
  }, now);
}

function validateCommand(command, logger) {
  const id = command?.id == null ? '' : String(command.id).trim();
  if (!id) {
    logger.warn?.('[commands-file] id が無いコマンドを無視します');
    return null;
  }

  const taskId = normalizeTaskId(command.taskId);
  if (taskId == null) {
    logger.warn?.(`[commands-file] id=${logId(id)}: taskId が不正なため無視します`);
    return null;
  }

  if (command.action == null || command.requestedAt == null) {
    logger.warn?.(`[commands-file] id=${logId(id)}: 必須キーが不足しているため無視します`);
    return null;
  }

  if (SINGLE_COMMAND_ACTIONS.has(command.action) && (command.to == null || command.expected == null)) {
    logger.warn?.(`[commands-file] id=${logId(id)}: 必須キーが不足しているため無視します`);
    return null;
  }

  if (command.action === 'apply-batch') {
    if (!Array.isArray(command.ops) || command.ops.length === 0) {
      logger.warn?.(`[commands-file] id=${logId(id)}: ops が非空配列ではないため拒否します`);
      return null;
    }
  }

  return { id, taskId };
}

function normalizeBatchOperation(op, id, labelsConfig, logger) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    logger.warn?.(`[commands-file] id=${logId(id)}: ops に不正な項目があるため拒否します`);
    return { ok: false, reason: 'invalid-batch' };
  }

  if (op.action == null || op.to == null || op.expected == null) {
    logger.warn?.(`[commands-file] id=${logId(id)}: ops の必須キーが不足しているため拒否します`);
    return { ok: false, reason: 'invalid-batch' };
  }

  if (typeof op.action !== 'string' || !SINGLE_COMMAND_ACTIONS.has(op.action)) {
    logger.warn?.(`[commands-file] id=${logId(id)}: ops に未対応 action "${sanitizeLogText(op.action)}" があるため拒否します`);
    return { ok: false, reason: 'invalid-batch' };
  }
  const field = BATCH_FIELD_BY_ACTION[op.action];

  if (op.action === 'set-status') {
    const expected = normalizeStatusName(op.expected, labelsConfig);
    const to = normalizeStatusName(op.to, labelsConfig);
    if (!expected || !to) {
      logger.warn?.(`[commands-file] id=${logId(id)}: ops のステータス名が不正なため拒否します`);
      return { ok: false, reason: 'invalid-status' };
    }
    if (!isAllowedTransition(expected, to)) {
      logger.warn?.(`[commands-file] id=${logId(id)}: ops の許可されていない遷移 ${sanitizeLogText(expected)} → ${sanitizeLogText(to)} のため拒否します`);
      return { ok: false, reason: 'disallowed-transition' };
    }
    return { ok: true, op: { action: op.action, field, expected, to } };
  }

  if (op.action === 'set-priority') {
    const expected = normalizePriorityName(op.expected, labelsConfig);
    const to = normalizePriorityName(op.to, labelsConfig);
    if (!expected || !to) {
      logger.warn?.(`[commands-file] id=${logId(id)}: ops の優先度名が不正なため拒否します`);
      return { ok: false, reason: 'invalid-priority' };
    }
    return { ok: true, op: { action: op.action, field, expected, to } };
  }

  if (op.action === 'set-sequential') {
    const expected = normalizeSequentialName(op.expected, labelsConfig);
    const to = normalizeSequentialName(op.to, labelsConfig);
    if (!expected || !to) {
      logger.warn?.(`[commands-file] id=${logId(id)}: ops の直列指定が不正なため拒否します`);
      return { ok: false, reason: 'invalid-sequential' };
    }
    return { ok: true, op: { action: op.action, field, expected, to } };
  }

  if (op.action === 'set-automerge') {
    const expected = normalizeAutomergeName(op.expected, labelsConfig);
    const to = normalizeAutomergeName(op.to, labelsConfig);
    if (!expected || !to) {
      logger.warn?.(`[commands-file] id=${logId(id)}: ops の自動マージ指定が不正なため拒否します`);
      return { ok: false, reason: 'invalid-automerge' };
    }
    return { ok: true, op: { action: op.action, field, expected, to } };
  }

  logger.warn?.(`[commands-file] id=${logId(id)}: ops に想定外 action "${sanitizeLogText(op.action)}" があるため拒否します`);
  return { ok: false, reason: 'invalid-batch' };
}

function prepareBatchOperations(command, id, labelsConfig, logger) {
  if (command.ops.length > BATCH_OPERATION_ORDER.length) {
    logger.warn?.(`[commands-file] id=${logId(id)}: ops の件数が上限を超えているため拒否します`);
    return { ok: false, reason: 'invalid-batch' };
  }

  const fields = new Set();
  const operations = [];
  for (const rawOp of command.ops) {
    const normalized = normalizeBatchOperation(rawOp, id, labelsConfig, logger);
    if (!normalized.ok) return normalized;

    if (fields.has(normalized.op.field)) {
      logger.warn?.(`[commands-file] id=${logId(id)}: ops に同一項目の重複があるため拒否します`);
      return { ok: false, reason: 'invalid-batch' };
    }
    fields.add(normalized.op.field);
    operations.push(normalized.op);
  }

  operations.sort((a, b) => BATCH_OPERATION_ORDER.indexOf(a.action) - BATCH_OPERATION_ORDER.indexOf(b.action));
  return { ok: true, operations };
}

function extractActualForBatchOperation(issue, op, labelsConfig) {
  switch (op.action) {
    case 'set-status':
      return extractIssueStatus(issue, labelsConfig);
    case 'set-priority':
      return extractIssuePriority(issue, labelsConfig);
    case 'set-sequential':
      return extractIssueSequential(issue, labelsConfig);
    case 'set-automerge':
      return extractIssueAutomerge(issue, labelsConfig);
    default:
      return null;
  }
}

async function applyBatchOperation(taskId, op, github, labelsConfig) {
  switch (op.action) {
    case 'set-status':
      return github.setStatus(taskId, statusLabelFor(op.to, labelsConfig));
    case 'set-priority':
      return github.setPriority(taskId, op.to);
    case 'set-sequential':
      return github.setSequential(taskId, op.to);
    case 'set-automerge':
      return github.setAutomerge(taskId, op.to);
    default:
      return undefined;
  }
}

export async function processSetStatusCommand(command, dependencies = {}) {
  const logger = dependencies.logger ?? console;
  const labelsConfig = dependencies.labelsConfig ?? getLabelsConfig();
  const github = dependencies.github;
  const getMetaIssue = dependencies.getMetaIssue;

  const valid = validateCommand(command, logger);
  if (!valid) return { evaluated: false, applied: false, reason: 'invalid' };

  const { id, taskId } = valid;
  if (command.action !== 'set-status') {
    logger.warn?.(`[commands-file] id=${logId(id)}: 未対応 action "${sanitizeLogText(command.action)}" のため無視します`);
    return { evaluated: true, applied: false, reason: 'unsupported-action', id };
  }

  const expected = normalizeStatusName(command.expected, labelsConfig);
  const to = normalizeStatusName(command.to, labelsConfig);
  if (!expected || !to) {
    logger.warn?.(`[commands-file] id=${logId(id)}: expected/to のステータス名が不正なため拒否します`);
    return { evaluated: true, applied: false, reason: 'invalid-status', id };
  }

  if (!isAllowedTransition(expected, to)) {
    logger.warn?.(`[commands-file] id=${logId(id)}: 許可されていない遷移 ${sanitizeLogText(expected)} → ${sanitizeLogText(to)} のため拒否します`);
    return { evaluated: true, applied: false, reason: 'disallowed-transition', id };
  }

  const issue = await getMetaIssue(taskId);
  const actual = extractIssueStatus(issue, labelsConfig);
  if (actual !== expected) {
    logger.info?.(`[commands-file] id=${logId(id)}: CAS 不一致（expected=${sanitizeLogText(expected)}, actual=${sanitizeLogText(actual ?? 'none')}）のため破棄します`);
    return { evaluated: true, applied: false, reason: 'cas-mismatch', id };
  }

  const nextLabel = statusLabelFor(to, labelsConfig);
  // waiting-merge -> done を GUI から明示実行した場合も、setStatus の設計どおり
  // upstream source issue への完了コメント投稿まで進む。
  await github.setStatus(taskId, nextLabel);
  logger.info?.(`[commands-file] id=${logId(id)}: issue #${taskId} を ${sanitizeLogText(nextLabel)} へ変更しました`);
  return { evaluated: true, applied: true, reason: 'applied', id };
}

export async function processSetPriorityCommand(command, dependencies = {}) {
  const logger = dependencies.logger ?? console;
  const labelsConfig = dependencies.labelsConfig ?? getLabelsConfig();
  const github = dependencies.github;
  const getMetaIssue = dependencies.getMetaIssue;

  const valid = validateCommand(command, logger);
  if (!valid) return { evaluated: false, applied: false, reason: 'invalid' };

  const { id, taskId } = valid;
  const expected = normalizePriorityName(command.expected, labelsConfig);
  const to = normalizePriorityName(command.to, labelsConfig);
  if (!expected || !to) {
    logger.warn?.(`[commands-file] id=${logId(id)}: expected/to の優先度名が不正なため拒否します`);
    return { evaluated: true, applied: false, reason: 'invalid-priority', id };
  }

  const issue = await getMetaIssue(taskId);
  const actual = extractIssuePriority(issue, labelsConfig);
  if (actual !== expected) {
    logger.info?.(`[commands-file] id=${logId(id)}: CAS 不一致（expected=${sanitizeLogText(expected)}, actual=${sanitizeLogText(actual)}）のため破棄します`);
    return { evaluated: true, applied: false, reason: 'cas-mismatch', id };
  }

  await github.setPriority(taskId, to);
  logger.info?.(`[commands-file] id=${logId(id)}: issue #${taskId} の優先度を ${sanitizeLogText(to)} へ変更しました`);
  return { evaluated: true, applied: true, reason: 'applied', id };
}

export async function processSetSequentialCommand(command, dependencies = {}) {
  const logger = dependencies.logger ?? console;
  const labelsConfig = dependencies.labelsConfig ?? getLabelsConfig();
  const github = dependencies.github;
  const getMetaIssue = dependencies.getMetaIssue;

  const valid = validateCommand(command, logger);
  if (!valid) return { evaluated: false, applied: false, reason: 'invalid' };

  const { id, taskId } = valid;
  const expected = normalizeSequentialName(command.expected, labelsConfig);
  const to = normalizeSequentialName(command.to, labelsConfig);
  if (!expected || !to) {
    logger.warn?.(`[commands-file] id=${logId(id)}: expected/to の直列指定が不正なため拒否します`);
    return { evaluated: true, applied: false, reason: 'invalid-sequential', id };
  }

  const issue = await getMetaIssue(taskId);
  const actual = extractIssueSequential(issue, labelsConfig);
  if (actual !== expected) {
    logger.info?.(`[commands-file] id=${logId(id)}: CAS 不一致（expected=${sanitizeLogText(expected)}, actual=${sanitizeLogText(actual)}）のため破棄します`);
    return { evaluated: true, applied: false, reason: 'cas-mismatch', id };
  }

  await github.setSequential(taskId, to);
  logger.info?.(`[commands-file] id=${logId(id)}: issue #${taskId} の実行方式を ${sanitizeLogText(to)} へ変更しました`);
  return { evaluated: true, applied: true, reason: 'applied', id };
}

export async function processSetAutomergeCommand(command, dependencies = {}) {
  const logger = dependencies.logger ?? console;
  const labelsConfig = dependencies.labelsConfig ?? getLabelsConfig();
  const github = dependencies.github;
  const getMetaIssue = dependencies.getMetaIssue;

  const valid = validateCommand(command, logger);
  if (!valid) return { evaluated: false, applied: false, reason: 'invalid' };

  const { id, taskId } = valid;
  const expected = normalizeAutomergeName(command.expected, labelsConfig);
  const to = normalizeAutomergeName(command.to, labelsConfig);
  if (!expected || !to) {
    logger.warn?.(`[commands-file] id=${logId(id)}: expected/to の自動マージ指定が不正なため拒否します`);
    return { evaluated: true, applied: false, reason: 'invalid-automerge', id };
  }

  const issue = await getMetaIssue(taskId);
  const actual = extractIssueAutomerge(issue, labelsConfig);
  if (actual !== expected) {
    logger.info?.(`[commands-file] id=${logId(id)}: CAS 不一致（expected=${sanitizeLogText(expected)}, actual=${sanitizeLogText(actual)}）のため破棄します`);
    return { evaluated: true, applied: false, reason: 'cas-mismatch', id };
  }

  await github.setAutomerge(taskId, to);
  logger.info?.(`[commands-file] id=${logId(id)}: issue #${taskId} の自動マージを ${sanitizeLogText(to)} へ変更しました`);
  return { evaluated: true, applied: true, reason: 'applied', id };
}

export async function processApplyBatchCommand(command, dependencies = {}) {
  const logger = dependencies.logger ?? console;
  const labelsConfig = dependencies.labelsConfig ?? getLabelsConfig();
  const github = dependencies.github;
  const getMetaIssue = dependencies.getMetaIssue;

  const valid = validateCommand(command, logger);
  if (!valid) return { evaluated: false, applied: false, reason: 'invalid' };

  const { id, taskId } = valid;
  const prepared = prepareBatchOperations(command, id, labelsConfig, logger);
  if (!prepared.ok) return { evaluated: true, applied: false, reason: prepared.reason, id };

  const issue = await getMetaIssue(taskId);
  const operations = prepared.operations.map((op) => ({
    ...op,
    actual: extractActualForBatchOperation(issue, op, labelsConfig),
  }));

  const mismatch = operations.find((op) => op.actual !== op.expected && op.actual !== op.to);
  if (mismatch) {
    logger.info?.(`[commands-file] id=${logId(id)}: CAS 不一致（${sanitizeLogText(mismatch.field)} expected=${sanitizeLogText(mismatch.expected)}, to=${sanitizeLogText(mismatch.to)}, actual=${sanitizeLogText(mismatch.actual ?? 'none')}）のため一括破棄します`);
    return { evaluated: true, applied: false, reason: 'cas-mismatch', id };
  }

  let applied = false;
  for (const op of operations) {
    // 既に目標値の op は set を呼ばない（二重適用・set-status の完了コメント二重投稿を防ぐ）。
    if (op.actual === op.to) continue;
    await applyBatchOperation(taskId, op, github, labelsConfig);
    applied = true;
    logger.info?.(`[commands-file] id=${logId(id)}: issue #${taskId} の ${sanitizeLogText(op.field)} を ${sanitizeLogText(op.to)} へ変更しました`);
  }

  return { evaluated: true, applied, reason: applied ? 'applied' : 'already-applied', id };
}

export async function processCommand(command, dependencies = {}) {
  const logger = dependencies.logger ?? console;
  const valid = validateCommand(command, logger);
  if (!valid) return { evaluated: false, applied: false, reason: 'invalid' };

  switch (command.action) {
    case 'set-status':
      return processSetStatusCommand(command, dependencies);
    case 'set-priority':
      return processSetPriorityCommand(command, dependencies);
    case 'set-sequential':
      return processSetSequentialCommand(command, dependencies);
    case 'set-automerge':
      return processSetAutomergeCommand(command, dependencies);
    case 'apply-batch':
      return processApplyBatchCommand(command, dependencies);
    default:
      logger.warn?.(`[commands-file] id=${logId(valid.id)}: 未対応 action "${sanitizeLogText(command.action)}" のため無視します`);
      return { evaluated: true, applied: false, reason: 'unsupported-action', id: valid.id };
  }
}

function splitCompleteLines(text) {
  if (!text) return [];
  const chunks = text.split('\n');
  chunks.pop();
  return chunks.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
}

function getErrorStatus(err) {
  const status = err?.status ?? err?.response?.status ?? err?.statusCode;
  const numeric = Number(status);
  return Number.isInteger(numeric) ? numeric : null;
}

function isPermanentError(err) {
  const status = getErrorStatus(err);
  return status != null && status >= 400 && status < 500 && status !== 403 && status !== 429;
}

function appendRecentId(state, id, limit) {
  if (!id) return;
  state.recentIds = normalizeRecentIds([...state.recentIds, id], limit);
}

function clearRetryForLine(state, lineNumber) {
  if (state.retry?.lineNumber === lineNumber) state.retry = null;
}

export async function consumeCommandsFile(options = {}) {
  const commandsPath = options.commandsPath ?? resolveCommandsPath();
  const statePath = options.statePath ?? options.processedPath ?? join(dirname(commandsPath), 'commands-processed.json');
  const logger = options.logger ?? console;
  const now = options.now ?? (() => new Date());
  const recentIdLimit = options.recentIdLimit ?? DEFAULT_RECENT_ID_LIMIT;
  const transientRetryLimit = options.transientRetryLimit ?? DEFAULT_TRANSIENT_RETRY_LIMIT;
  const github = options.github;
  const getMetaIssue = options.getMetaIssue ?? ((issueNumber) =>
    github.getIssueState(github.owner, github.repo, issueNumber, { retryDelays: [] })
  );

  let text;
  try {
    text = await fsPromises.readFile(commandsPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { read: 0, evaluated: 0, applied: 0, skipped: 0 };
    throw err;
  }

  // commands.jsonl は追記専用契約。既存行の書き換えや同一以下の長さでの全書換は
  // 行カーソルの整合を壊すため行わないこと。
  const lines = splitCompleteLines(text);
  const state = await readCommandsState(statePath, { recentIdLimit });
  if (state.consumedLines > lines.length) {
    logger.warn?.('[commands-file] commands.jsonl が短くなっているため行カーソルを先頭へ戻します');
    state.consumedLines = 0;
    state.retry = null;
  }
  const processed = new Set([...(state.legacyIds ?? []), ...state.recentIds]);
  let changed = false;
  const summary = { read: 0, evaluated: 0, applied: 0, skipped: 0 };

  for (let index = state.consumedLines; index < lines.length; index++) {
    const line = lines[index];
    const lineNumber = index + 1;
    const command = parseCommandLine(line, index + 1, logger);
    if (!command) {
      state.consumedLines = lineNumber;
      clearRetryForLine(state, lineNumber);
      changed = true;
      continue;
    }

    summary.read += 1;
    const id = command.id == null ? '' : String(command.id).trim();
    if (id && processed.has(id)) {
      summary.skipped += 1;
      state.consumedLines = lineNumber;
      clearRetryForLine(state, lineNumber);
      appendRecentId(state, id, recentIdLimit);
      changed = true;
      continue;
    }

    let result;
    try {
      result = await processCommand(command, { ...options, github, getMetaIssue });
    } catch (err) {
      if (isPermanentError(err)) {
        const status = getErrorStatus(err);
        logger.warn?.(`[commands-file] id=${logId(id)}: 恒久失敗（HTTP ${status}）のため隔離します`);
        state.consumedLines = lineNumber;
        clearRetryForLine(state, lineNumber);
        appendRecentId(state, id, recentIdLimit);
        changed = true;
        continue;
      }

      const failedAt = formatTimestamp(now());
      const retry = state.retry?.lineNumber === lineNumber
        ? state.retry
        : { lineNumber, attempts: 0, firstFailedAt: failedAt, lastFailedAt: null };
      retry.attempts += 1;
      retry.lastFailedAt = failedAt;
      state.retry = retry;
      changed = true;

      if (retry.attempts > transientRetryLimit) {
        const status = getErrorStatus(err);
        const statusText = status == null ? 'network/unknown' : `HTTP ${status}`;
        logger.warn?.(`[commands-file] id=${logId(id)}: 一時失敗（${statusText}）がリトライ上限を超えたため隔離します`);
        state.consumedLines = lineNumber;
        clearRetryForLine(state, lineNumber);
        appendRecentId(state, id, recentIdLimit);
        continue;
      }

      const message = sanitizeLogText(err?.message);
      logger.warn?.(`[commands-file] id=${logId(id)}: 一時失敗のため次回再試行します（${retry.attempts}/${transientRetryLimit}）${message ? `: ${message}` : ''}`);
      break;
    }

    if (result.evaluated) {
      summary.evaluated += 1;
      if (result.applied) summary.applied += 1;
    }
    if (result.id) {
      processed.add(result.id);
      appendRecentId(state, result.id, recentIdLimit);
    }
    state.consumedLines = lineNumber;
    clearRetryForLine(state, lineNumber);
    changed = true;
  }

  if (changed) {
    await writeCommandsState(statePath, state, now(), { recentIdLimit });
  }

  return summary;
}

export function createCommandsFileProcessor(options = {}) {
  let chain = Promise.resolve();
  const consumeOnce = () => {
    const next = chain.then(() => consumeCommandsFile(options));
    chain = next.catch(() => {});
    return next;
  };
  return { consumeOnce };
}

export function startCommandsFileWatcher(processor, options = {}) {
  const commandsPath = options.commandsPath ?? resolveCommandsPath();
  const logger = options.logger ?? console;
  const debounceMs = options.debounceMs ?? 200;
  const afterConsume = options.afterConsume;
  let timer = null;
  let closed = false;
  let watcher = null;

  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      processor.consumeOnce()
        .then(async (summary) => {
          if (closed) return;
          if (typeof afterConsume === 'function') {
            await afterConsume(summary);
          }
        })
        .catch((err) => {
          logger.warn?.(`[commands-file] watch 起点の消化に失敗しました: ${sanitizeLogText(err.message)}`);
        });
    }, debounceMs);
  };

  fsPromises.mkdir(dirname(commandsPath), { recursive: true })
    .then(() => {
      if (closed) return;
      watcher = fsWatch(dirname(commandsPath), (eventType, filename) => {
        if (!filename || filename === basename(commandsPath)) schedule();
      });
      watcher.on('error', (err) => {
        logger.warn?.(`[commands-file] watch に失敗しました: ${sanitizeLogText(err.message)}`);
      });
    })
    .catch((err) => {
      logger.warn?.(`[commands-file] watch ディレクトリの作成に失敗しました: ${sanitizeLogText(err.message)}`);
    });

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      watcher?.close();
    },
  };
}
