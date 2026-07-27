// 宣言的タスク一覧ウィジェット（tasks-widget.json）の生成。
//
// buildTasksView() が作る純データ（tasks-view）を入力に、VK Terminals が
// 語彙・色・遷移・操作を自前に持たずに描画できる「宣言」へ変換する。
// 表示に関わる定義（tone・表示ラベル・遷移・確認文言・選択肢）は task-domain.js を正本に
// この宣言へ焼き込む。ビューアは tone → 色のマッピングと、updatedAt/staleThresholdMs による
// staleness のライブ再計算だけを担う（boolean は焼き込まない）。
//
// スキーマ契約の詳細は docs/tasks-widget-schema.md を参照。

import { resolveTasksWidgetPath, writeJsonAtomic } from '../config.js';
import { TASK_DOMAIN } from './task-domain.js';

// 宣言のスキーマバージョン。互換を壊す変更のたびに増やす（ビューアは値で分岐可能）。
export const TASKS_WIDGET_SCHEMA_VERSION = 1;

// staleness の既定閾値（ms）。VK Terminals 側の既定（120000）に合わせる。
// ビューアは updatedAt と staleThresholdMs から stale を都度再計算する。
export const DEFAULT_STALE_THRESHOLD_MS = 120_000;

const HTTP_URL_RE = /^https?:\/\//i;

// http(s) の実 URL だけを外部リンクとして採用する（local:// 等は採用しない）。
function httpUrlOrNull(url) {
  return typeof url === 'string' && HTTP_URL_RE.test(url.trim()) ? url.trim() : null;
}

// タスクの外部リンク（キュー Issue / PR / 対象 Issue）を宣言用に組み立てる。
function buildLinks(task) {
  const links = [];
  const queueUrl = httpUrlOrNull(task.queueIssueUrl);
  if (queueUrl) {
    links.push({ rel: 'queue', url: queueUrl, label: 'Issue' });
  }
  const prUrl = httpUrlOrNull(task.prUrl);
  if (prUrl) {
    links.push({ rel: 'pr', url: prUrl, label: 'PR' });
  }
  const targetUrl = httpUrlOrNull(task.targetIssueUrl);
  if (targetUrl) {
    links.push({ rel: 'target', url: targetUrl, label: 'Target' });
  }
  return links;
}

// 優先度・直列/並列・自動マージのバッジを組み立てる。優先度は high/medium/low のみ
// バッジ化し、none はバッジにしない（選択肢集合とバッジ集合は別）。
// 直列/並列と自動マージは常に表示。
function buildBadges(task, domain) {
  const badges = [];
  const priority = task.priority;
  if (domain.priorityBadgeValues.has(priority)) {
    badges.push({ label: domain.priorityLabel(priority), tone: domain.priorityTones[priority] });
  }
  const sequential = task.sequential === true ? 'sequential' : 'parallel';
  badges.push({ label: domain.sequentialLabel(sequential), tone: domain.sequentialTones[sequential] });
  const automerge = task.automerge === true ? 'automerge' : 'manual';
  badges.push({ label: domain.automergeBadgeLabel(automerge), tone: domain.automergeTones[automerge] });
  return badges;
}

// ステータス変更の select コントロールを組み立てる。
// 遷移不可の選択肢は disabled:true + disabledReason（スクリーンリーダ向け理由）を付ける。
// 選択可能な遷移には command（commands.jsonl 1 行にそのまま書ける形）と、
// 必要なら confirm（完成文）を付ける。
function buildStatusControl(task, domain) {
  const current = task.status;
  const hasPrUrl = Boolean(task.prUrl);
  const options = domain.statusSelectOrderFor(current).map((value) => {
    const disabled = domain.isStatusOptionDisabled(current, value);
    const option = {
      value,
      label: domain.statusDisplayLabel(value),
      disabled,
    };
    if (disabled) {
      option.disabledReason =
        `現在の状態「${domain.statusDisplayLabel(current)}」から「${domain.statusDisplayLabel(value)}」へは変更できません。`;
    } else if (value !== current) {
      // 発行時に id / requestedAt をビューアが付与する前提の command 断片。
      option.command = { action: 'set-status', taskId: task.id, to: value, expected: current };
      const confirm = domain.getTransitionConfirm({ from: current, to: value, hasPrUrl });
      if (confirm) option.confirm = confirm;
    }
    return option;
  });

  return {
    type: 'select',
    field: 'status',
    label: 'ステータス',
    ariaLabel: `${task.title} のステータスを変更`,
    current,
    options,
  };
}

// 優先度変更の select コントロールを組み立てる。優先度は自由に変更可（遷移制約なし）。
function buildPriorityControl(task, domain) {
  const current = domain.priorityBadgeValues.has(task.priority) ? task.priority : 'none';
  const options = domain.priorityOptions.map((option) => {
    const entry = { value: option.value, label: option.label, disabled: false };
    if (option.value !== current) {
      entry.command = { action: 'set-priority', taskId: task.id, to: option.value, expected: current };
    }
    return entry;
  });

  return {
    type: 'select',
    field: 'priority',
    label: '優先度',
    ariaLabel: `${task.title} の優先度を変更`,
    current,
    options,
  };
}

// 直列/並列切り替えの select コントロールを組み立てる。
function buildSequentialControl(task, domain) {
  const current = task.sequential === true ? 'sequential' : 'parallel';
  const options = domain.sequentialOptions.map((option) => {
    const entry = { value: option.value, label: option.label, disabled: false };
    if (option.value !== current) {
      entry.command = { action: 'set-sequential', taskId: task.id, to: option.value, expected: current };
    }
    return entry;
  });

  return {
    type: 'select',
    field: 'sequential',
    label: '実行方式',
    ariaLabel: `${task.title} の実行方式を変更`,
    current,
    options,
  };
}

// 自動マージ切り替えの select コントロールを組み立てる。
function buildAutomergeControl(task, domain) {
  const current = task.automerge === true ? 'automerge' : 'manual';
  const options = domain.automergeOptions.map((option) => {
    const entry = { value: option.value, label: option.label, disabled: false };
    if (option.value !== current) {
      entry.command = { action: 'set-automerge', taskId: task.id, to: option.value, expected: current };
    }
    return entry;
  });

  return {
    type: 'select',
    field: 'automerge',
    label: '自動マージ',
    ariaLabel: `${task.title} の自動マージを変更`,
    current,
    options,
  };
}

// 1 タスクを宣言アイテムへ変換する。
function buildItem(task, domain) {
  const editable = domain.editableStatuses.has(task.status);
  const item = {
    id: task.id,
    title: task.title,
    links: buildLinks(task),
    badges: buildBadges(task, domain),
    updatedAt: task.updatedAt ?? null,
    editable,
    controls: editable
      ? [
          buildStatusControl(task, domain),
          buildPriorityControl(task, domain),
          buildSequentialControl(task, domain),
          buildAutomergeControl(task, domain),
        ]
      : [],
  };
  // emphasis は意味属性（色ではない）。該当ステータスのときだけ付与する。
  const emphasis = domain.emphasis[task.status];
  if (emphasis) item.emphasis = emphasis;
  if (task.assignee) item.assignee = task.assignee;
  return item;
}

/**
 * tasks-view（buildTasksView の出力）を宣言的ウィジェットへ変換する。
 *
 * グループは status ごとにまとめ、既知ステータスは domain.groupOrder の順、
 * 未知ステータスはその後ろ（tone は既定 neutral・ラベルは bare 名）へ並べる。
 * タスクが 1 件も無いグループは含めない（現行 VK Terminals の挙動に合わせる）。
 * staleness は boolean を焼き込まず、updatedAt と staleThresholdMs をビューアへ渡す。
 * @param {{ updatedAt?: string, viewer?: string|null, tasks?: Array<object> }} view
 * @param {{ domain?: object, now?: Date, staleThresholdMs?: number }} [options]
 * @returns {object} tasks-widget 宣言
 */
export function buildTasksWidget(view = {}, options = {}) {
  const domain = options.domain ?? TASK_DOMAIN;
  const staleThresholdMs = Number.isFinite(options.staleThresholdMs)
    ? options.staleThresholdMs
    : DEFAULT_STALE_THRESHOLD_MS;
  const updatedAt = view.updatedAt
    ?? (options.now instanceof Date ? options.now.toISOString() : new Date().toISOString());
  const tasks = Array.isArray(view.tasks) ? view.tasks : [];

  // status ごとにタスクをまとめる（登場順を保持）。
  const byStatus = new Map();
  for (const task of tasks) {
    const status = task.status;
    if (!byStatus.has(status)) byStatus.set(status, []);
    byStatus.get(status).push(task);
  }

  // 既知ステータスを domain.groupOrder 順に、その後で未知ステータスを登場順に並べる。
  const orderedStatuses = [
    ...domain.groupOrder.filter((status) => byStatus.has(status)),
    ...[...byStatus.keys()].filter((status) => !domain.groupOrder.includes(status)),
  ];

  const groups = orderedStatuses.map((status, order) => ({
    id: status ?? 'unknown',
    label: domain.statusDisplayLabel(status),
    tone: domain.statusTone(status),
    order,
    items: byStatus.get(status).map((task) => buildItem(task, domain)),
  }));

  return {
    schemaVersion: TASKS_WIDGET_SCHEMA_VERSION,
    kind: 'task-list',
    lang: domain.lang,
    updatedAt,
    viewer: view.viewer ?? null,
    staleThresholdMs,
    emptyText: domain.emptyText,
    groups,
  };
}

/**
 * tasks-widget 宣言を JSON ファイルへ原子的に書き出す。
 * 書き込みは config.js の writeJsonAtomic を使い、原子的書き込み（temp→rename）を維持する。
 * @param {object} widget buildTasksWidget の出力
 * @param {{ filePath?: string }} [options]
 * @returns {Promise<string>} 書き出したファイルパス
 */
export async function writeTasksWidgetFile(widget, options = {}) {
  const filePath = options.filePath ?? resolveTasksWidgetPath();
  writeJsonAtomic(filePath, widget);
  return filePath;
}
