import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCKED_REASON_CONFLICT,
  blockedReasonFromLabels,
  collectStaleBlockedIssues,
  createStaleBlockedLabelReconciler,
  decideBlockedLabelForConflict,
  isConflictResolved,
  isPRFinished,
  requiresConflictBlockedLabel,
  shouldDisplayBlockedReason,
} from '../src/engine/blocked-reason.js';

const open = { state: 'open', merged: false };

test('blocked reason 定数', () => {
  assert.equal(BLOCKED_REASON_CONFLICT, 'conflict');
});

test('isConflictResolved: mergeable=true かつ dirty 以外だけを解消済みとする', () => {
  const cases = [
    [{ mergeable: true, mergeableState: 'clean' }, true],
    [{ mergeable: true, mergeableState: 'dirty' }, false],
    [{ mergeable: false, mergeableState: 'dirty' }, false],
    [{ mergeable: false, mergeableState: 'behind' }, false],
    [{ mergeable: null, mergeableState: 'unknown' }, false],
    [{ mergeable: undefined, mergeableState: 'blocked' }, false],
    [{ mergeable: undefined, mergeableState: 'unstable' }, false],
    [null, false],
  ];
  for (const [prState, expected] of cases) {
    assert.equal(isConflictResolved(prState), expected, JSON.stringify(prState));
  }
});

test('isPRFinished: merged=true または state!==open', () => {
  assert.equal(isPRFinished(null), false);
  assert.equal(isPRFinished(undefined), false);
  assert.equal(isPRFinished({ state: 'open', merged: false }), false);
  assert.equal(isPRFinished({ state: 'open', merged: true }), true);
  assert.equal(isPRFinished({ state: 'closed', merged: false }), true);
});

test('decideBlockedLabelForConflict: 判定表を網羅する', () => {
  const cases = [
    ['merged + label', { prState: { ...open, merged: true }, hasBlockedLabel: true }, 'remove'],
    ['merged + no label', { prState: { ...open, merged: true }, hasBlockedLabel: false }, 'none'],
    ['closed + label', { prState: { state: 'closed', merged: false }, hasBlockedLabel: true }, 'remove'],
    ['closed + no label', { prState: { state: 'closed', merged: false }, hasBlockedLabel: false }, 'none'],
    ['resolved + label', { prState: { ...open, mergeable: true, mergeableState: 'clean' }, hasBlockedLabel: true }, 'remove'],
    ['resolved + no label', { prState: { ...open, mergeable: true, mergeableState: 'clean' }, hasBlockedLabel: false }, 'none'],
    ['unknown state without mergeable=true + label', { prState: { ...open, mergeable: null, mergeableState: 'unknown' }, hasBlockedLabel: true }, 'none'],
    ['behind state without mergeable=true + label', { prState: { ...open, mergeable: false, mergeableState: 'behind' }, hasBlockedLabel: true }, 'none'],
    ['conflict + human + no label', { prState: { ...open, mergeable: false, mergeableState: 'dirty' }, humanActionRequired: true }, 'add'],
    ['conflict + human + label', { prState: { ...open, mergeable: false, mergeableState: 'dirty' }, hasBlockedLabel: true, humanActionRequired: true }, 'none'],
    ['conflict + automatic', { prState: { ...open, mergeable: false, mergeableState: 'dirty' }, humanActionRequired: false }, 'none'],
    ['unknown null + human + no label', { prState: { ...open, mergeable: null, mergeableState: 'unknown' }, humanActionRequired: true }, 'none'],
    ['unknown null + human + label', { prState: { ...open, mergeable: null, mergeableState: 'dirty' }, hasBlockedLabel: true, humanActionRequired: true }, 'none'],
    ['mergeable=true でも dirty ならコンフリクト扱い', { prState: { ...open, mergeable: true, mergeableState: 'dirty' }, humanActionRequired: true }, 'add'],
    ['ordinary pending', { prState: { ...open, mergeable: false, mergeableState: 'blocked' }, humanActionRequired: false }, 'none'],
  ];
  for (const [name, input, expected] of cases) {
    assert.deepEqual(decideBlockedLabelForConflict(input), { action: expected }, name);
  }
});

test('requiresConflictBlockedLabel: automerge ラベル付きはコンフリクトでも対象外', () => {
  const humanActionRequired = requiresConflictBlockedLabel({
    prState: { ...open, mergeable: false, mergeableState: 'dirty' },
    hasAutomergeLabel: true,
  });
  assert.equal(humanActionRequired, false);
  assert.deepEqual(decideBlockedLabelForConflict({
    prState: { ...open, mergeable: false, mergeableState: 'dirty' },
    humanActionRequired,
  }), { action: 'none' });
});

test('requiresConflictBlockedLabel: コンフリクト状態と automerge の有無で判定する', () => {
  assert.equal(requiresConflictBlockedLabel({
    prState: { ...open, mergeable: false, mergeableState: 'dirty' },
    hasAutomergeLabel: false,
  }), true);
  assert.equal(requiresConflictBlockedLabel({
    prState: { ...open, mergeable: true, mergeableState: 'clean' },
    hasAutomergeLabel: false,
  }), false);
  assert.equal(requiresConflictBlockedLabel(), false);
});

test('decideBlockedLabelForConflict: false → null → false でも付与は一度だけで除去しない', () => {
  let hasBlockedLabel = false;
  const actions = [];
  for (const mergeable of [false, null, false]) {
    const { action } = decideBlockedLabelForConflict({
      prState: { ...open, mergeable, mergeableState: mergeable === null ? 'unknown' : 'dirty' },
      hasBlockedLabel,
      humanActionRequired: true,
    });
    actions.push(action);
    if (action === 'add') hasBlockedLabel = true;
    if (action === 'remove') hasBlockedLabel = false;
  }
  assert.deepEqual(actions, ['add', 'none', 'none']);
});

test('blockedReasonFromLabels: 設定ラベル、既定 prefix、未知 reason を解決する', () => {
  assert.equal(blockedReasonFromLabels(['renamed-conflict'], {
    labelsConfig: { blocked: { conflict: 'renamed-conflict' } },
  }), 'conflict');
  assert.equal(blockedReasonFromLabels([{ name: 'blocked:dependency' }], {
    labelsConfig: { blocked: { conflict: 'blocked:conflict' } },
  }), 'dependency');
  assert.equal(blockedReasonFromLabels(['status:ready'], { labelsConfig: {} }), null);
});

test('shouldDisplayBlockedReason: waiting-merge だけ表示する', () => {
  assert.equal(shouldDisplayBlockedReason({ status: 'waiting-merge', blockedReason: 'conflict' }), true);
  assert.equal(shouldDisplayBlockedReason({ status: 'waiting-input', blockedReason: 'conflict' }), false);
  assert.equal(shouldDisplayBlockedReason({ status: 'ready', blockedReason: 'conflict' }), false);
  assert.equal(shouldDisplayBlockedReason({ status: 'waiting-merge', blockedReason: null }), false);
  assert.equal(shouldDisplayBlockedReason({ status: 'waiting-merge', blockedReason: 'dependency' }), false);
});

test('collectStaleBlockedIssues: 管理対象ラベルだけを waiting-merge 以外から抽出する', () => {
  const labelsConfig = {
    status: {
      waitingMerge: 'status:waiting-merge',
      waitingInput: 'status:waiting-input',
      ready: 'status:ready',
    },
    blocked: {
      conflict: 'blocked:conflict',
      review: 'blocked:review-pending',
    },
  };
  const issues = [
    { number: 1, labels: ['status:waiting-merge', 'blocked:conflict'] },
    { number: 2, labels: ['status:waiting-input', 'blocked:conflict'] },
    { number: 3, labels: ['status:ready', 'blocked:conflict'] },
    { number: 4, labels: ['status:done', 'blocked:dependency'] },
    { number: 5, labels: ['status:ready'] },
    { number: 6, labels: ['blocked:conflict'] },
    { number: 7, labels: ['status:waiting-merge', 'blocked:conflict', 'blocked:review-pending'] },
  ];
  assert.deepEqual(collectStaleBlockedIssues(issues, { labelsConfig }), [
    { number: 2, blockedLabels: ['blocked:conflict'] },
    { number: 3, blockedLabels: ['blocked:conflict'] },
    { number: 6, blockedLabels: ['blocked:conflict'] },
  ]);
});

test('stale blocked reconciler: 設定を毎回解決し管理対象だけを掃除する', async () => {
  const calls = [];
  let configuredConflict = 'custom-conflict';
  const reconcile = createStaleBlockedLabelReconciler({
    getLabelsConfig: () => ({
      status: { ready: 'status:ready' },
      blocked: { conflict: configuredConflict },
    }),
    removeBlockedLabel: async (number, label) => {
      calls.push([number, label]);
    },
    logger: { log: () => {}, warn: () => {} },
  });
  await reconcile([
    { number: 8, labels: ['status:ready', 'custom-conflict', 'blocked:dependency'] },
  ]);
  configuredConflict = 'renamed-conflict';
  await reconcile([
    { number: 9, labels: ['status:ready', 'renamed-conflict', 'blocked:dependency'] },
  ]);
  assert.deepEqual(calls, [[8, 'custom-conflict'], [9, 'renamed-conflict']]);
});

test('stale blocked reconciler: 不正なラベル値でも例外を外へ出さない', async () => {
  const warnings = [];
  const reconcile = createStaleBlockedLabelReconciler({
    getLabelsConfig: () => ({
      status: { ready: 'status:ready' },
      blocked: { conflict: 'blocked:conflict' },
    }),
    removeBlockedLabel: async () => {},
    logger: { log: () => {}, warn: (message) => warnings.push(message) },
  });
  await assert.doesNotReject(() => reconcile([
    { number: 10, labels: [{ name: 123 }, true, { name: 'blocked:conflict' }] },
  ]));
  assert.deepEqual(warnings, []);
});

test('stale blocked reconciler: waiting-input に取り残された管理対象ラベルを掃除する', async () => {
  const calls = [];
  const reconcile = createStaleBlockedLabelReconciler({
    getLabelsConfig: () => ({
      status: { waitingInput: 'status:waiting-input' },
      blocked: { conflict: 'blocked:conflict' },
    }),
    removeBlockedLabel: async (number, label) => calls.push([number, label]),
    logger: { log: () => {}, warn: () => {} },
  });
  await reconcile([
    { number: 11, labels: ['status:waiting-input', 'blocked:conflict'] },
  ]);
  assert.deepEqual(calls, [[11, 'blocked:conflict']]);
});

test('stale blocked reconciler: 照合処理の例外を finally の呼び出し元へ漏らさない', async () => {
  const warnings = [];
  const reconcile = createStaleBlockedLabelReconciler({
    getLabelsConfig: () => {
      throw new Error('broken config');
    },
    removeBlockedLabel: async () => {},
    logger: { log: () => {}, warn: (message) => warnings.push(message) },
  });
  await assert.doesNotReject(() => reconcile([]));
  assert.equal(warnings.length, 1);
});
