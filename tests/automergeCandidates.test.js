import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { selectAutomergeCandidates } from '../src/engine/automerge-candidates.js';

// automerge の「マージ判定スキャン」対象 issue 集合を決める純粋関数のテスト。
// issue #207: automerge ラベルを PR 作成後に付けても、waiting-input で滞留した issue が
// automerge 判定に乗らず永久にマージされない不具合の red → green を担保する。
describe('selectAutomergeCandidates', () => {
  const withLabel = { number: 1, labels: [{ name: 'automerge' }] };
  const withoutLabel = { number: 2, labels: [] };
  const hasAutomergeLabel = (issue) =>
    (issue.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === 'automerge');

  it('automerge ラベル付きの waiting-input issue を候補に含める（#207 の穴）', () => {
    const candidates = selectAutomergeCandidates({
      waitingMergeIssues: [],
      waitingInputIssues: [withLabel],
      hasAutomergeLabel,
    });

    assert.deepEqual(candidates, [{ issue: withLabel, source: 'waiting-input' }]);
  });

  it('automerge ラベル無しの waiting-input issue は候補に含めない（本物の質問待ちを保留）', () => {
    const candidates = selectAutomergeCandidates({
      waitingMergeIssues: [],
      waitingInputIssues: [withoutLabel],
      hasAutomergeLabel,
    });

    assert.deepEqual(candidates, []);
  });

  it('waiting-merge issue はラベル有無に関わらず全件候補に含める（既存動作の維持）', () => {
    const candidates = selectAutomergeCandidates({
      waitingMergeIssues: [withLabel, withoutLabel],
      waitingInputIssues: [],
      hasAutomergeLabel,
    });

    assert.deepEqual(candidates, [
      { issue: withLabel, source: 'waiting-merge' },
      { issue: withoutLabel, source: 'waiting-merge' },
    ]);
  });

  it('waiting-merge を先に、その後 automerge ラベル付き waiting-input を並べる', () => {
    const wm = { number: 10, labels: [] };
    const wiLabeled = { number: 11, labels: [{ name: 'automerge' }] };
    const wiPlain = { number: 12, labels: [] };

    const candidates = selectAutomergeCandidates({
      waitingMergeIssues: [wm],
      waitingInputIssues: [wiLabeled, wiPlain],
      hasAutomergeLabel,
    });

    assert.deepEqual(candidates, [
      { issue: wm, source: 'waiting-merge' },
      { issue: wiLabeled, source: 'waiting-input' },
    ]);
  });

  it('入力が空なら空配列を返す', () => {
    assert.deepEqual(selectAutomergeCandidates({}), []);
    assert.deepEqual(
      selectAutomergeCandidates({ waitingMergeIssues: [], waitingInputIssues: [], hasAutomergeLabel }),
      []
    );
  });
});
