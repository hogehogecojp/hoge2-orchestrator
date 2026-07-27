import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveWaitingMergeAction } from '../src/engine/waiting-merge-action.js';

// マージ判定スキャンの各候補（source, prState）に対して「取るべきアクション」を
// 決める純粋関数のテスト。
// issue #209: automerge ラベル付きで status:waiting-input に滞留した issue の PR が
// GitHub UI 等で外部から手動マージされたとき、waiting-input 分岐が merged を処理せず
// 「automerge 試行なし」でスキップしていたため close+done されず滞留し続けた。
// merged 判定を source より前に共通化し、source を問わず完了ルート（complete-merge）へ
// 流すことを担保する red → green テスト。
describe('resolveWaitingMergeAction', () => {
  // --- #209 の核心: waiting-input × merged は完了ルートに乗るべき ---
  it('source=waiting-input かつ merged なら complete-merge（#209 の穴）', () => {
    assert.equal(
      resolveWaitingMergeAction({
        source: 'waiting-input',
        prState: { state: 'closed', merged: true },
        hasAutomergeLabel: true,
      }),
      'complete-merge'
    );
  });

  // --- waiting-merge × merged（既存の完了ルート維持） ---
  it('source=waiting-merge かつ merged なら complete-merge（既存動作の維持）', () => {
    assert.equal(
      resolveWaitingMergeAction({
        source: 'waiting-merge',
        prState: { state: 'closed', merged: true },
        hasAutomergeLabel: false,
      }),
      'complete-merge'
    );
  });

  // --- waiting-input × open（後付け automerge 試行） ---
  it('source=waiting-input かつ open なら try-automerge', () => {
    assert.equal(
      resolveWaitingMergeAction({
        source: 'waiting-input',
        prState: { state: 'open', merged: false },
        hasAutomergeLabel: true,
      }),
      'try-automerge'
    );
  });

  // --- waiting-input × closed 未マージ（本物の質問待ち等はスキップ） ---
  it('source=waiting-input かつ closed 未マージなら skip', () => {
    assert.equal(
      resolveWaitingMergeAction({
        source: 'waiting-input',
        prState: { state: 'closed', merged: false },
        hasAutomergeLabel: true,
      }),
      'skip'
    );
  });

  // --- waiting-merge × open + automerge ラベル（automerge 試行） ---
  it('source=waiting-merge かつ open + automerge ラベルなら try-automerge', () => {
    assert.equal(
      resolveWaitingMergeAction({
        source: 'waiting-merge',
        prState: { state: 'open', merged: false },
        hasAutomergeLabel: true,
      }),
      'try-automerge'
    );
  });

  // --- waiting-merge × open + ラベル無し（待機継続＝skip） ---
  it('source=waiting-merge かつ open + automerge ラベル無しなら skip（待機継続）', () => {
    assert.equal(
      resolveWaitingMergeAction({
        source: 'waiting-merge',
        prState: { state: 'open', merged: false },
        hasAutomergeLabel: false,
      }),
      'skip'
    );
  });

  // --- waiting-merge × closed 未マージ（待機継続＝skip） ---
  it('source=waiting-merge かつ closed 未マージなら skip（待機継続）', () => {
    assert.equal(
      resolveWaitingMergeAction({
        source: 'waiting-merge',
        prState: { state: 'closed', merged: false },
        hasAutomergeLabel: false,
      }),
      'skip'
    );
  });

  // --- merged は state に依存せず最優先（防御的） ---
  it('merged=true なら state が open でも complete-merge を最優先する', () => {
    assert.equal(
      resolveWaitingMergeAction({
        source: 'waiting-input',
        prState: { state: 'open', merged: true },
        hasAutomergeLabel: true,
      }),
      'complete-merge'
    );
  });
});
