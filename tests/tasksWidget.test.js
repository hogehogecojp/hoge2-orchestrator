import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { buildTasksView } from '../src/engine/tasks-view.js';
import {
  buildTasksWidget,
  writeTasksWidgetFile,
  TASKS_WIDGET_SCHEMA_VERSION,
  DEFAULT_STALE_THRESHOLD_MS,
} from '../src/engine/tasks-widget.js';

async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'vko-tasks-widget-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// buildTasksView を通した現実的な view を作るヘルパ。
function viewFrom(issues, options = {}) {
  return buildTasksView(issues, { now: new Date('2026-07-21T00:00:00Z'), ...options });
}

function findGroup(widget, id) {
  return widget.groups.find((g) => g.id === id);
}

function findControl(item, field) {
  return item.controls.find((c) => c.field === field);
}

test('buildTasksWidget: トップレベルの契約フィールドを持つ', () => {
  const widget = buildTasksWidget(viewFrom([]), { staleThresholdMs: 5000 });
  assert.equal(widget.schemaVersion, TASKS_WIDGET_SCHEMA_VERSION);
  assert.equal(widget.kind, 'task-list');
  assert.equal(widget.lang, 'ja');
  assert.equal(widget.updatedAt, '2026-07-21T00:00:00.000Z');
  assert.equal(widget.viewer, null);
  assert.equal(widget.staleThresholdMs, 5000);
  assert.equal(typeof widget.emptyText, 'string');
  assert.deepEqual(widget.groups, []);
});

test('buildTasksWidget: staleThresholdMs 未指定時は既定値、boolean は焼き込まない', () => {
  const widget = buildTasksWidget(viewFrom([]));
  assert.equal(widget.staleThresholdMs, DEFAULT_STALE_THRESHOLD_MS);
  assert.equal(Object.hasOwn(widget, 'stale'), false);
});

test('buildTasksWidget: viewer は view から引き継ぐ', () => {
  const widget = buildTasksWidget(viewFrom([], { viewer: 'wada' }));
  assert.equal(widget.viewer, 'wada');
});

test('buildTasksWidget: グループはグループ表示順に並び、空グループは含めない', () => {
  const widget = buildTasksWidget(viewFrom([
    { number: 1, title: 'a', labels: [{ name: 'status:done' }], assignees: [] },
    { number: 2, title: 'b', labels: [{ name: 'status:in-progress' }], assignees: [] },
    { number: 3, title: 'c', labels: [{ name: 'status:ready' }], assignees: [] },
  ]));
  // 表示順: in-progress → ready → done（waiting-input 等の空グループは無し）
  assert.deepEqual(widget.groups.map((g) => g.id), ['in-progress', 'ready', 'done']);
  assert.deepEqual(widget.groups.map((g) => g.order), [0, 1, 2]);
  assert.equal(findGroup(widget, 'in-progress').tone, 'progress');
  assert.equal(findGroup(widget, 'in-progress').label, '実行中');
});

test('buildTasksWidget: 未知ステータスは末尾・tone neutral・ラベルは bare 名', () => {
  const widget = buildTasksWidget(viewFrom([
    { number: 1, title: 'known', labels: [{ name: 'status:ready' }], assignees: [] },
    { number: 2, title: 'weird', labels: [{ name: 'status:mystery' }], assignees: [] },
  ]));
  const last = widget.groups.at(-1);
  assert.equal(last.id, 'mystery');
  assert.equal(last.tone, 'neutral');
  assert.equal(last.label, 'mystery');
});

test('buildTasksWidget: item に links / badges / editable / emphasis を焼き込む', () => {
  const widget = buildTasksWidget(viewFrom([
    {
      number: 139,
      title: 'waiting input task',
      body: [
        'https://github.com/vektor-inc/vk-orchestrator/issues/138',
        '**PR:** https://github.com/vektor-inc/vk-orchestrator/pull/140',
      ].join('\n'),
      labels: [{ name: 'status:waiting-input' }, { name: 'priority:high' }, { name: 'sequential' }, { name: 'automerge' }],
      assignees: [{ login: 'wada' }],
      html_url: 'https://github.com/vektor-inc/task-queue/issues/139',
      updated_at: '2026-07-17T01:02:03Z',
    },
  ]));
  const item = findGroup(widget, 'waiting-input').items[0];
  assert.equal(item.id, '139');
  assert.equal(item.editable, true);
  assert.equal(item.emphasis, 'attention'); // waiting-input のパルス相当
  assert.equal(item.updatedAt, '2026-07-17T01:02:03Z');
  assert.equal(item.assignee, 'wada');

  // links: queue（実 http URL）と pr と target
  assert.deepEqual(item.links, [
    { rel: 'queue', url: 'https://github.com/vektor-inc/task-queue/issues/139', label: 'Issue' },
    { rel: 'pr', url: 'https://github.com/vektor-inc/vk-orchestrator/pull/140', label: 'PR' },
    { rel: 'target', url: 'https://github.com/vektor-inc/vk-orchestrator/issues/138', label: 'Target' },
  ]);

  // badges: priority(high=danger) + sequential(直列=info) + automerge(自動マージ=success)
  assert.deepEqual(item.badges, [
    { label: '高', tone: 'danger' },
    { label: '直列', tone: 'info' },
    { label: '自動マージ', tone: 'success' },
  ]);
});

test('buildTasksWidget: priority none はバッジ化しない、parallel/manual は neutral バッジ', () => {
  const widget = buildTasksWidget(viewFrom([
    { number: 1, title: 'plain', labels: [{ name: 'status:ready' }], assignees: [] },
  ]));
  const item = findGroup(widget, 'ready').items[0];
  // priority バッジ無し、sequential(並列=neutral) + automerge(手動マージ=neutral)
  assert.deepEqual(item.badges, [
    { label: '並列', tone: 'neutral' },
    { label: '手動マージ', tone: 'neutral' },
  ]);
});

test('buildTasksWidget: local:// のキュー URL は queue リンクにしない', () => {
  const widget = buildTasksWidget(viewFrom([
    { number: 1, title: 'local', labels: [{ name: 'status:ready' }], assignees: [], html_url: 'local://1' },
  ]));
  const item = findGroup(widget, 'ready').items[0];
  assert.equal(item.links.length, 0);
});

test('buildTasksWidget: done は editable=false・controls 空', () => {
  const widget = buildTasksWidget(viewFrom([
    { number: 1, title: 'done task', labels: [{ name: 'status:done' }], assignees: [] },
  ]));
  const item = findGroup(widget, 'done').items[0];
  assert.equal(item.editable, false);
  assert.deepEqual(item.controls, []);
});

test('status control: 遷移不可の選択肢は disabled+disabledReason、可の選択肢は command 付き', () => {
  const widget = buildTasksWidget(viewFrom([
    { number: 5, title: 'ready task', labels: [{ name: 'status:ready' }], assignees: [] },
  ]));
  const control = findControl(findGroup(widget, 'ready').items[0], 'status');
  assert.equal(control.type, 'select');
  assert.equal(control.current, 'ready');
  assert.equal(typeof control.ariaLabel, 'string');

  const current = control.options.find((o) => o.value === 'ready');
  assert.equal(current.disabled, false);
  assert.equal(Object.hasOwn(current, 'command'), false); // 現在値には command 無し

  // ready→awaiting-approval は許可遷移（差し戻し）。command と confirm を持つ。
  const toApproval = control.options.find((o) => o.value === 'awaiting-approval');
  assert.equal(toApproval.disabled, false);
  assert.deepEqual(toApproval.command, {
    action: 'set-status', taskId: '5', to: 'awaiting-approval', expected: 'ready',
  });
  assert.match(toApproval.confirm.title, /承認待ち/);

  // ready→done は不許可。disabled + 理由テキスト、command 無し。
  const toDone = control.options.find((o) => o.value === 'done');
  assert.equal(toDone.disabled, true);
  assert.match(toDone.disabledReason, /変更できません/);
  assert.equal(Object.hasOwn(toDone, 'command'), false);
});

test('status control: waiting-merge→done の confirm は PR 有無で body が変わる', () => {
  const widgetWithPr = buildTasksWidget(viewFrom([
    {
      number: 7, title: 'merge task',
      body: '**PR:** https://github.com/vektor-inc/vk-orchestrator/pull/8',
      labels: [{ name: 'status:waiting-merge' }], assignees: [],
    },
  ]));
  const doneOpt = findControl(findGroup(widgetWithPr, 'waiting-merge').items[0], 'status')
    .options.find((o) => o.value === 'done');
  assert.match(doneOpt.confirm.body, /PR は開いたまま残ります/);

  const widgetNoPr = buildTasksWidget(viewFrom([
    { number: 9, title: 'merge task', labels: [{ name: 'status:waiting-merge' }], assignees: [] },
  ]));
  const doneOpt2 = findControl(findGroup(widgetNoPr, 'waiting-merge').items[0], 'status')
    .options.find((o) => o.value === 'done');
  assert.equal(doneOpt2.confirm.body, '');
});

test('priority / sequential / automerge control: 現在値以外の選択肢に CAS 付き command を持つ', () => {
  const widget = buildTasksWidget(viewFrom([
    { number: 3, title: 'task', labels: [{ name: 'status:ready' }, { name: 'priority:medium' }], assignees: [] },
  ]));
  const item = findGroup(widget, 'ready').items[0];
  assert.deepEqual(item.controls.map((control) => control.field), ['status', 'priority', 'sequential', 'automerge']);

  const priority = findControl(item, 'priority');
  assert.equal(priority.current, 'medium');
  const toHigh = priority.options.find((o) => o.value === 'high');
  assert.deepEqual(toHigh.command, { action: 'set-priority', taskId: '3', to: 'high', expected: 'medium' });
  const currentPriority = priority.options.find((o) => o.value === 'medium');
  assert.equal(Object.hasOwn(currentPriority, 'command'), false);

  const sequential = findControl(item, 'sequential');
  assert.equal(sequential.current, 'parallel');
  const toSeq = sequential.options.find((o) => o.value === 'sequential');
  assert.deepEqual(toSeq.command, { action: 'set-sequential', taskId: '3', to: 'sequential', expected: 'parallel' });

  const automerge = findControl(item, 'automerge');
  assert.equal(automerge.current, 'manual');
  assert.equal(automerge.label, '自動マージ');
  assert.deepEqual(automerge.options.map((option) => option.label), ['する', 'しない']);
  const toAutomerge = automerge.options.find((o) => o.value === 'automerge');
  assert.deepEqual(toAutomerge.command, { action: 'set-automerge', taskId: '3', to: 'automerge', expected: 'manual' });
});

test('writeTasksWidgetFile: 一時ファイル経由で JSON を書き出す', async () => {
  await withTmpDir(async (dir) => {
    const filePath = join(dir, 'tasks-widget.json');
    const widget = buildTasksWidget(viewFrom([]));
    await writeTasksWidgetFile(widget, { filePath });
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), widget);
    assert.deepEqual(readdirSync(dir).sort(), ['tasks-widget.json']);
  });
});
