import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_TRANSITIONS,
  isAllowedTransition,
  STATUS_GROUP_ORDER,
  STATUS_SELECT_ORDER,
  STATUS_TONES,
  STATUS_EMPHASIS,
  EDITABLE_STATUSES,
  PRIORITY_OPTIONS,
  PRIORITY_BADGE_VALUES,
  PRIORITY_TONES,
  SEQUENTIAL_OPTIONS,
  AUTOMERGE_OPTIONS,
  AUTOMERGE_TONES,
  AUTOMERGE_BADGE_LABELS,
  statusDisplayLabel,
  statusTone,
  priorityLabel,
  sequentialLabel,
  automergeLabel,
  automergeBadgeLabel,
  getTransitionConfirm,
  isStatusOptionDisabled,
  statusSelectOrderFor,
  DEFAULT_TONE,
} from '../src/engine/task-domain.js';

test('ALLOWED_TRANSITIONS: commands-file から移設した 9 遷移をそのまま持つ', () => {
  assert.equal(ALLOWED_TRANSITIONS.size, 9);
  const expected = [
    'awaiting-approval->ready',
    'ready->awaiting-approval',
    'in-progress->awaiting-approval',
    'waiting-input->awaiting-approval',
    'waiting-merge->awaiting-approval',
    'failed->awaiting-approval',
    'waiting-merge->done',
    'failed->ready',
    'ready->failed',
  ];
  for (const t of expected) assert.ok(ALLOWED_TRANSITIONS.has(t), t);
});

test('isAllowedTransition: bare 名・status: 接頭辞のどちらでも判定できる', () => {
  assert.equal(isAllowedTransition('awaiting-approval', 'ready'), true);
  assert.equal(isAllowedTransition('status:awaiting-approval', 'status:ready'), true);
  assert.equal(isAllowedTransition('in-progress', 'done'), false);
  assert.equal(isAllowedTransition(null, 'ready'), false);
});

test('グループ表示順とプルダウン選択肢順は別定義（現行 VK Terminals と一致）', () => {
  assert.deepEqual(STATUS_GROUP_ORDER, [
    'in-progress', 'waiting-input', 'ready', 'awaiting-approval', 'waiting-merge', 'failed', 'done',
  ]);
  assert.deepEqual(STATUS_SELECT_ORDER, [
    'awaiting-approval', 'ready', 'in-progress', 'waiting-input', 'waiting-merge', 'done', 'failed',
  ]);
  // 同一集合の別順序であることを確認。
  assert.deepEqual([...STATUS_GROUP_ORDER].sort(), [...STATUS_SELECT_ORDER].sort());
});

test('tone: 7 種すべてに意味語彙が割り当てられ、生 HEX を含まない', () => {
  for (const status of STATUS_SELECT_ORDER) {
    const tone = STATUS_TONES[status];
    assert.equal(typeof tone, 'string');
    assert.doesNotMatch(tone, /#|rgb/i);
  }
  assert.equal(STATUS_TONES['in-progress'], 'progress');
  assert.equal(STATUS_TONES['waiting-input'], 'warning');
  assert.equal(STATUS_TONES.ready, 'info');
  assert.equal(STATUS_TONES['waiting-merge'], 'info');
  assert.equal(STATUS_TONES['awaiting-approval'], 'attention');
  assert.equal(STATUS_TONES.failed, 'danger');
  assert.equal(STATUS_TONES.done, 'neutral');
});

test('emphasis: waiting-input のみ attention（パルス相当を意味属性で表す）', () => {
  assert.equal(STATUS_EMPHASIS['waiting-input'], 'attention');
  assert.equal(STATUS_EMPHASIS['in-progress'], undefined);
});

test('EDITABLE_STATUSES: done 以外の 6 種が操作可、done は不可', () => {
  assert.equal(EDITABLE_STATUSES.has('done'), false);
  for (const status of ['awaiting-approval', 'ready', 'in-progress', 'waiting-input', 'waiting-merge', 'failed']) {
    assert.equal(EDITABLE_STATUSES.has(status), true, status);
  }
});

test('優先度: 選択肢集合は high/medium/low/none、バッジ集合は none を含まない', () => {
  assert.deepEqual(PRIORITY_OPTIONS.map((o) => o.value), ['high', 'medium', 'low', 'none']);
  assert.equal(PRIORITY_BADGE_VALUES.has('none'), false);
  assert.equal(PRIORITY_BADGE_VALUES.has('high'), true);
  assert.equal(PRIORITY_TONES.high, 'danger');
  assert.equal(PRIORITY_TONES.medium, 'warning');
  assert.equal(PRIORITY_TONES.low, 'success');
});

test('直列/並列の選択肢', () => {
  assert.deepEqual(SEQUENTIAL_OPTIONS.map((o) => o.value), ['sequential', 'parallel']);
});

test('自動マージの選択肢', () => {
  assert.deepEqual(AUTOMERGE_OPTIONS.map((o) => o.value), ['automerge', 'manual']);
  assert.deepEqual(AUTOMERGE_OPTIONS.map((o) => o.label), ['する', 'しない']);
  assert.equal(AUTOMERGE_TONES.automerge, 'success');
  assert.equal(AUTOMERGE_TONES.manual, 'neutral');
  assert.equal(AUTOMERGE_BADGE_LABELS.automerge, '自動マージ');
  assert.equal(AUTOMERGE_BADGE_LABELS.manual, '手動マージ');
});

test('表示ラベル: 既知は日本語、未知は bare 名フォールバック', () => {
  assert.equal(statusDisplayLabel('awaiting-approval'), '承認待ち');
  assert.equal(statusDisplayLabel('done'), '完了');
  assert.equal(statusDisplayLabel('mystery'), 'mystery');
  assert.equal(priorityLabel('high'), '高');
  assert.equal(priorityLabel('none'), 'なし');
  assert.equal(sequentialLabel('sequential'), '直列');
  assert.equal(automergeLabel('automerge'), 'する');
  assert.equal(automergeBadgeLabel('manual'), '手動マージ');
});

test('statusTone: 未知値は既定 tone（neutral）', () => {
  assert.equal(statusTone('mystery'), DEFAULT_TONE);
  assert.equal(DEFAULT_TONE, 'neutral');
});

test('getTransitionConfirm: 承認待ち差し戻しは完成文（title+body）', () => {
  const confirm = getTransitionConfirm({ from: 'in-progress', to: 'awaiting-approval' });
  assert.match(confirm.title, /承認待ち/);
  assert.match(confirm.body, /二重起動/);
});

test('getTransitionConfirm: waiting-merge→done は PR 有無で body が出し分けされる', () => {
  const withPr = getTransitionConfirm({ from: 'waiting-merge', to: 'done', hasPrUrl: true });
  assert.match(withPr.title, /完了/);
  assert.match(withPr.body, /PR は開いたまま残ります/);

  const withoutPr = getTransitionConfirm({ from: 'waiting-merge', to: 'done', hasPrUrl: false });
  assert.equal(withoutPr.body, '');
});

test('getTransitionConfirm: 確認不要な遷移は null', () => {
  assert.equal(getTransitionConfirm({ from: 'awaiting-approval', to: 'ready' }), null);
  assert.equal(getTransitionConfirm({ from: 'failed', to: 'ready' }), null);
});

test('isStatusOptionDisabled: 現在値は選択可、許可遷移でない先は不可', () => {
  assert.equal(isStatusOptionDisabled('ready', 'ready'), false);
  assert.equal(isStatusOptionDisabled('ready', 'awaiting-approval'), false); // 許可遷移
  assert.equal(isStatusOptionDisabled('ready', 'done'), true); // 不許可
});

test('statusSelectOrderFor: 未知の現在値は先頭に足して選択可能にする', () => {
  assert.deepEqual(statusSelectOrderFor('ready'), STATUS_SELECT_ORDER);
  const withUnknown = statusSelectOrderFor('mystery');
  assert.equal(withUnknown[0], 'mystery');
  assert.equal(withUnknown.length, STATUS_SELECT_ORDER.length + 1);
});
