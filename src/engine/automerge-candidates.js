/**
 * automerge の「マージ判定スキャン」対象となる issue 集合を決める純粋関数。
 *
 * ## 背景（issue #207）
 *
 * automerge ラベルを **最初から** 付けていれば、PR 完了後に issue が
 * `status:waiting-merge` へ進み、`checkWaitingMergeIssues()` の automerge 判定に乗る。
 * しかし automerge **無し** で作業が完了すると、司が「マージ判断をお願いします」の
 * `Status: waiting-input` を投稿し issue は `status:waiting-input` に落ちる。その後で
 * automerge ラベルを付与しても、従来のマージ判定は `status:waiting-merge` の issue しか
 * 走査しないため、後付け automerge が永久にマージ判定に乗らなかった。
 *
 * この関数は「automerge 試行対象の issue 集合を広げるだけ」の役割を担う。
 *   - `waiting-merge` の issue はラベル有無に関わらず全件対象（既存のマージ検知ルート）。
 *   - `waiting-input` の issue は `hasAutomergeLabel(issue)` が true のものだけを対象に加える。
 *
 * 返り値の各要素には `source`（'waiting-merge' | 'waiting-input'）を添える。呼び出し側は
 * source によって処理を分岐する（waiting-merge はマージ検知 + automerge、waiting-input は
 * automerge 試行のみ）。waiting-input を automerge 候補に含めても、実際のマージは
 * `tryAutoMerge()` 内の完了条件ゲート（Draft 除外・mergeable・CI + CodeRabbit 静観・
 * agent-review-passed マーカーの現 head SHA 一致）が再検証するため、実装途中の本物の
 * 質問待ち（マーカー未付与）は自然に保留される＝安全側に倒れる。
 *
 * GitHub API 依存を持たない純粋関数として切り出し、ユニットテスト可能にしている
 * （in-progress-decision.js / scan-in-progress-merged.js と同じ思想）。
 *
 * @param {object} input
 * @param {Array<object>} [input.waitingMergeIssues]  fetchWaitingMergeIssues() の結果
 * @param {Array<object>} [input.waitingInputIssues]  fetchWaitingInputIssues() の結果
 * @param {(issue: object) => boolean} [input.hasAutomergeLabel]  automerge ラベル判定
 * @returns {Array<{ issue: object, source: 'waiting-merge'|'waiting-input' }>}
 */
export function selectAutomergeCandidates({
  waitingMergeIssues = [],
  waitingInputIssues = [],
  hasAutomergeLabel = () => false,
} = {}) {
  const candidates = [];

  // waiting-merge は従来どおり全件（マージ検知ルートの対象）。
  for (const issue of waitingMergeIssues) {
    candidates.push({ issue, source: 'waiting-merge' });
  }

  // waiting-input は automerge ラベル付きのものだけを後付け automerge 候補に加える。
  for (const issue of waitingInputIssues) {
    if (hasAutomergeLabel(issue)) {
      candidates.push({ issue, source: 'waiting-input' });
    }
  }

  return candidates;
}
