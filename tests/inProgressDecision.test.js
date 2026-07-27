/**
 * decideInProgressAction（orchestrator/in-progress-decision.js）のユニットテスト。
 *
 * 対象 issue/PR のコメント・PR 状態・PR 完了可否の組合せから、
 * in-progress issue の次状態遷移が期待どおりかを検証する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decideInProgressAction, needsReviewGate } from '../src/engine/in-progress-decision.js';

const agentWaitingInput = ['Comment by vk-agents', 'Status: waiting-input', '', '確認お願いします'].join('\n');
const agentAnswered = ['Comment by vk-agents', 'Status: answered', '', 'ペイン経由で解決済みです'].join('\n');
const userReply = 'A 案で進めてください';

describe('decideInProgressAction', () => {
  it('未応答の waiting-input があれば waiting-input（PR 状態より優先）', () => {
    const r = decideInProgressAction({
      comments: [{ body: agentWaitingInput }],
      pr: { state: 'open', merged: false },
      prCompletionReady: true,
    });
    assert.equal(r.type, 'waiting-input');
  });

  it('PR マージ済みなら merged', () => {
    const r = decideInProgressAction({
      comments: [{ body: agentWaitingInput }, { body: userReply }],
      pr: { state: 'closed', merged: true },
    });
    assert.equal(r.type, 'merged');
  });

  it('PR が未マージ closed なら pr-closed-unmerged', () => {
    const r = decideInProgressAction({
      comments: [],
      pr: { state: 'closed', merged: false },
    });
    assert.equal(r.type, 'pr-closed-unmerged');
  });

  it('open PR で完了条件を満たせば waiting-merge', () => {
    const r = decideInProgressAction({
      comments: [],
      pr: { state: 'open', merged: false },
      prCompletionReady: true,
    });
    assert.equal(r.type, 'waiting-merge');
  });

  it('open PR で完了条件を満たさなければ none（作業継続）', () => {
    const r = decideInProgressAction({
      comments: [],
      pr: { state: 'open', merged: false },
      prCompletionReady: false,
    });
    assert.equal(r.type, 'none');
  });

  it('PR がまだ無ければ none', () => {
    const r = decideInProgressAction({ comments: [], pr: null });
    assert.equal(r.type, 'none');
  });

  it('応答済みの waiting-input は waiting-input にしない（PR 評価に進む）', () => {
    const r = decideInProgressAction({
      comments: [{ body: agentWaitingInput }, { body: userReply }],
      pr: { state: 'open', merged: false },
      prCompletionReady: true,
    });
    assert.equal(r.type, 'waiting-merge');
  });

  it('エージェント発 answered で pending 解除済み（PR 無し）なら none（waiting-input に戻さない）', () => {
    // 司がペイン経由で解決して Status: answered を出した後、scanWaitingInputIssues が
    // in-progress に復帰させる。その直後の scanInProgress が即 waiting-input に戻さないこと。
    const r = decideInProgressAction({
      comments: [{ body: agentWaitingInput }, { body: agentAnswered }],
      pr: null,
    });
    assert.equal(r.type, 'none');
  });

  it('引数なしでも安全に none', () => {
    assert.equal(decideInProgressAction().type, 'none');
  });

  describe('automerge ラベルとの相互作用', () => {
    // #213 以降、automerge タスクの override / waiting-merge には
    // reviewGateReady: true（agent-review-passed マーカーが現 head SHA に存在）が必要。
    // orchestrator 自身がマーカー無しではマージしないため、遷移条件をそれに揃えた。
    // 「マージ判断依頼の waiting-input を override する」というテストの意図を保つため、
    // 前提としてマーカーありを明示する。
    it('automerge + 完了条件充足の open PR では、未応答 waiting-input を override して waiting-merge', () => {
      // 司の「マージ判断お願いします」waiting-input で自動マージが止まらないこと。
      const r = decideInProgressAction({
        comments: [{ body: agentWaitingInput }],
        pr: { state: 'open', merged: false },
        prCompletionReady: true,
        automerge: true,
        reviewGateReady: true,
      });
      assert.equal(r.type, 'waiting-merge');
    });

    it('automerge + マージ済み PR では、未応答 waiting-input を override して merged', () => {
      // 司が手動マージ済みでも、マージ判断依頼コメントで done 化が止まらないこと。
      const r = decideInProgressAction({
        comments: [{ body: agentWaitingInput }],
        pr: { state: 'closed', merged: true },
        automerge: true,
      });
      assert.equal(r.type, 'merged');
    });

    it('automerge でも PR が未完了なら waiting-input は override せず waiting-input（本物の判断待ち）', () => {
      // automerge が事前承認するのはマージ手順だけ。実装途中の仕様確認は従来どおり止める。
      const r = decideInProgressAction({
        comments: [{ body: agentWaitingInput }],
        pr: { state: 'open', merged: false },
        prCompletionReady: false,
        automerge: true,
      });
      assert.equal(r.type, 'waiting-input');
    });

    it('automerge でも PR がまだ無ければ waiting-input は override せず waiting-input', () => {
      const r = decideInProgressAction({
        comments: [{ body: agentWaitingInput }],
        pr: null,
        automerge: true,
      });
      assert.equal(r.type, 'waiting-input');
    });

    it('automerge なし（既定）では完了条件充足でも waiting-input が優先され waiting-input（従来挙動を維持）', () => {
      const r = decideInProgressAction({
        comments: [{ body: agentWaitingInput }],
        pr: { state: 'open', merged: false },
        prCompletionReady: true,
        // automerge 未指定
      });
      assert.equal(r.type, 'waiting-input');
    });

    it('automerge + 完了条件充足でも、waiting-input が応答済みなら通常どおり waiting-merge', () => {
      const r = decideInProgressAction({
        comments: [{ body: agentWaitingInput }, { body: userReply }],
        pr: { state: 'open', merged: false },
        prCompletionReady: true,
        automerge: true,
        // #213: automerge の waiting-merge にはレビュー完了マーカーが必要。
        reviewGateReady: true,
      });
      assert.equal(r.type, 'waiting-merge');
    });

    it('automerge + 完了条件充足でもマーカーが無ければ override せず waiting-input（本物の判断待ち扱い）', () => {
      // マーカーが無い＝orchestrator はまだマージしない。この waiting-input は
      // 「事前承認済みのマージ判断依頼」ではなく本物の判断待ちとして残す（#213）。
      const r = decideInProgressAction({
        comments: [{ body: agentWaitingInput }],
        pr: { state: 'open', merged: false },
        prCompletionReady: true,
        automerge: true,
        reviewGateReady: false,
      });
      assert.equal(r.type, 'waiting-input');
    });
  });

  describe('マージ待ち遷移ゲート（issue #213）', () => {
    it('automerge タスクでレビュー完了マーカーが無ければ waiting-merge にしない（none）', () => {
      const r = decideInProgressAction({
        comments: [],
        pr: { state: 'open', merged: false },
        prCompletionReady: true,
        automerge: true,
        // reviewGateReady 未指定（= agent-review-passed マーカー無し）
      });
      assert.equal(r.type, 'none');
    });

    it('automerge タスクでレビュー完了マーカーがあれば waiting-merge', () => {
      const r = decideInProgressAction({
        comments: [],
        pr: { state: 'open', merged: false, draft: false },
        prCompletionReady: true,
        automerge: true,
        reviewGateReady: true,
      });
      assert.equal(r.type, 'waiting-merge');
    });

    it('Draft PR は完了条件を満たしても waiting-merge にしない（none）', () => {
      const r = decideInProgressAction({
        comments: [],
        pr: { state: 'open', merged: false, draft: true },
        prCompletionReady: true,
      });
      assert.equal(r.type, 'none');
    });

    it('Draft PR は automerge + マーカーありでも waiting-merge にしない（none）', () => {
      // 修正対応が残っている間は PR を draft にしておく運用（docs/agent-rules.md）。
      // tryAutoMerge も Draft はスキップするため、マージ待ち表示にもしない。
      const r = decideInProgressAction({
        comments: [],
        pr: { state: 'open', merged: false, draft: true },
        prCompletionReady: true,
        automerge: true,
        reviewGateReady: true,
      });
      assert.equal(r.type, 'none');
    });

    it('automerge でないタスクはマーカー無しでも従来どおり waiting-merge（後方互換）', () => {
      // agent-review-passed マーカーは automerge ルートの運用でしか付かない。ここで
      // マーカーを必須にすると automerge ラベルの無いタスクが永久に in-progress で滞留する。
      const r = decideInProgressAction({
        comments: [],
        pr: { state: 'open', merged: false, draft: false },
        prCompletionReady: true,
        automerge: false,
        reviewGateReady: false,
      });
      assert.equal(r.type, 'waiting-merge');
    });

    it('draft 未指定（undefined）は Draft でない扱い（既存呼び出しの後方互換）', () => {
      const r = decideInProgressAction({
        comments: [],
        pr: { state: 'open', merged: false },
        prCompletionReady: true,
      });
      assert.equal(r.type, 'waiting-merge');
    });

    it('Draft の automerge PR がマージ済みなら merged（Draft ゲートはマージ判定を邪魔しない）', () => {
      // draft フラグは「マージ待ちに出すか」のゲートであって、merged 検知を止めてはいけない。
      const r = decideInProgressAction({
        comments: [{ body: agentWaitingInput }],
        pr: { state: 'closed', merged: true, draft: true },
        automerge: true,
      });
      assert.equal(r.type, 'merged');
    });

    it('automerge + マーカーありでも Draft なら未応答 waiting-input を override しない', () => {
      // #213 の挙動変更点。変更前はこの組合せが waiting-merge になっていた。
      // Draft = まだマージできない＝「事前承認済みのマージ判断依頼」ではないので、
      // waiting-input を本物の判断待ちとして残す（override の条件も prReadyForMerge に揃える）。
      const r = decideInProgressAction({
        comments: [{ body: agentWaitingInput }],
        pr: { state: 'open', merged: false, draft: true },
        prCompletionReady: true,
        automerge: true,
        reviewGateReady: true,
      });
      assert.equal(r.type, 'waiting-input');
    });
  });
});

describe('needsReviewGate', () => {
  // 取得ガード（gatherTargetState）と判定（prReadyForMerge）がズレないよう、
  // 「マーカーが判定に効く条件」はこの述語 1 つに寄せている。
  it('automerge かつ完了条件充足かつ非 Draft のときだけ true', () => {
    assert.equal(needsReviewGate({ automerge: true, prCompletionReady: true }), true);
    assert.equal(needsReviewGate({ automerge: true, prCompletionReady: true, draft: false }), true);
  });

  it('automerge でなければ false（マーカーは要求されないので取得も不要）', () => {
    assert.equal(needsReviewGate({ automerge: false, prCompletionReady: true }), false);
  });

  it('完了条件未充足なら false（手前の項で waiting-merge にならないため結果を変えない）', () => {
    assert.equal(needsReviewGate({ automerge: true, prCompletionReady: false }), false);
  });

  it('Draft なら false（Draft は無条件で waiting-merge にならないため結果を変えない）', () => {
    assert.equal(needsReviewGate({ automerge: true, prCompletionReady: true, draft: true }), false);
  });

  it('引数なしでも安全に false', () => {
    assert.equal(needsReviewGate(), false);
  });

  it('needsReviewGate が false の状態では reviewGateReady の値が判定を変えない', () => {
    // 述語の意味（= 取得を省いても結果が同じ）を decideInProgressAction 側で実証する。
    const cases = [
      { pr: { state: 'open', merged: false }, prCompletionReady: true, automerge: false },
      { pr: { state: 'open', merged: false }, prCompletionReady: false, automerge: true },
      { pr: { state: 'open', merged: false, draft: true }, prCompletionReady: true, automerge: true },
    ];
    for (const base of cases) {
      assert.equal(needsReviewGate({ ...base, draft: base.pr.draft }), false);
      const withGate = decideInProgressAction({ comments: [], ...base, reviewGateReady: true });
      const withoutGate = decideInProgressAction({ comments: [], ...base, reviewGateReady: false });
      assert.equal(withGate.type, withoutGate.type);
    }
  });
});
