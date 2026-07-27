/**
 * `status:in-progress` の task-queue issue について、次に取るべき状態遷移を
 * 決める純粋関数（新方針 案B：ステートレス・スキャナ方式の中核ロジック）。
 *
 * orchestrator は秒数ではなく GitHub 上の客観状態で遷移する：
 *   - 対象 issue/PR の decision-record コメント（未応答の指示待ち）→ waiting-input
 *   - 対象 PR がマージ済み → merged（呼び出し側で done ゲートを通す）
 *   - 対象 PR が未マージ closed → pr-closed-unmerged（failed 相当）
 *   - 対象 PR が完了条件（CI + CodeRabbit 静観）を満たす → waiting-merge
 *   - いずれでもない → none（まだ作業中）
 *
 * PR URL の本文記録・PR アイコン表示は「状態遷移」とは独立の副作用として
 * 呼び出し側が（pr が存在し未記録なら）冪等に行う。この関数は遷移種別だけを返す。
 *
 * GitHub API 依存を持たない純粋関数として切り出し、ユニットテスト可能にしている。
 *
 * ## automerge ラベルと waiting-input の関係
 *
 * `automerge` ラベルは「マージ手順を事前承認する」ことを意味する。司（vk-kore）が
 * 完了報告で「マージ判断をお願いします」という `Status: waiting-input` コメントを
 * 出すと、本来 automerge で自動マージされるべき PR が waiting-input で止まってしまう
 * （automerge ラベルを対象リポ側 issue だけで探して見落とすなど、司側の判断ミスでも
 * 起きうる）。これを司の記憶やスキル運用に頼らず orchestrator 側で防ぐため、automerge
 * 指定時は **PR の客観状態が「実装完了」を示しているとき（マージ済み、または open かつ
 * 完了条件充足）に限り**、未応答の waiting-input を「マージ判断依頼（事前承認済み）」と
 * みなして waiting-input に倒さず PR 遷移（merged / waiting-merge）へ進める。
 *
 * 逆に automerge でも **PR がまだ完了条件を満たさない段階**（実装途中の仕様確認など、
 * 本物の判断待ち）では従来どおり waiting-input に倒す。automerge が事前承認するのは
 * あくまでマージ手順であって実装方針ではないこと、および waiting-input は
 * ユーザー返信を pane へ転送する経路でもある（ここを潰すと本物の質問に返信できない）
 * ことから、override は完了済み PR に限定する。判定材料はコメント本文の意図解析では
 * なく PR の客観状態のみに置く。
 *
 * ## waiting-merge に出してよい PR の条件（issue #213）
 *
 * 以前は `prCompletionReady`（CI 全通過 + CodeRabbit 静観）だけで waiting-merge に
 * 倒していたため、PR 直後に CI が緑・CodeRabbit が静かになった時点で、レビューの
 * 差し戻し対応がまだ進行中でも「マージ待ち」表示になっていた（サイドバーのタスク
 * カードのラベルはメタ issue の `status:*` をそのまま出すため、作業中なのに
 * 「マージ待ち」と見える）。
 *
 * そこで waiting-merge の条件を **「本当に誰かがマージできる状態か」** に揃え、
 * `prReadyForMerge` という単一の述語に集約した（判定を二重に持たない）。
 *
 *   - `pr.draft !== true` — docs/agent-rules.md の運用では「修正対応が残っている間は
 *     PR を draft にしておく」。Draft PR は誰もマージしないので「マージ待ち」ではない
 *     （`tryAutoMerge()` も Draft はスキップする）。`draft` 未指定（undefined）は
 *     「Draft でない」扱い＝従来挙動。
 *   - `!automerge || reviewGateReady` — automerge タスクでは orchestrator 自身が
 *     `agent-review-passed` マーカー（現 head SHA 一致）無しではマージしない
 *     （`tryAutoMerge()` のレビューゲート）。マージしないと分かっている PR を
 *     「マージ待ち」と表示しないよう、遷移条件を orchestrator のマージゲートと揃える。
 *
 * automerge でないタスクにマーカーを要求しないのは、`agent-review-passed` マーカーが
 * automerge ルートの運用でしか付与されないため。マーカー必須にすると automerge ラベルの
 * 無いタスクは永久に in-progress のまま滞留する（人がマージする経路が閉じる）。よって
 * automerge でないタスクは従来どおり「完了条件充足 + 非 Draft」で waiting-merge に進む。
 *
 * `reviewGateReady` の取得（GitHub API 呼び出し）が必要かどうかは `needsReviewGate()` を
 * export して呼び出し側に判定させる。取得ガードを呼び出し側で書き下すと、この
 * `prReadyForMerge` 側の条件だけを将来変えたときにガードが黙って古くなり（例: マーカーを
 * 取得しなくなったのに判定では要求し続ける）全タスクが in-progress で滞留するため、
 * 「マーカーが判定に効く条件」の定義はこのモジュールに 1 つだけ置く。
 *
 * なお `waiting-merge → in-progress` の逆遷移は今回のスコープ外（別途設計する）。ここで
 * 守るのは「早すぎる waiting-merge」＝ in-progress から出る側の条件だけで、いったん
 * waiting-merge に入った後の引き戻しは扱わない。
 */

import { hasPendingWaitingInput } from './decision-record.js';

/**
 * `decideInProgressAction()` の判定に `reviewGateReady` が効くかどうかを返す。
 *
 * 呼び出し側（gatherTargetState）が `agent-review-passed` マーカーを取得すべきかの
 * ガードに使う。マーカー確認は `pulls.get` + コメント全件 paginate を伴うため、
 * 判定に効かない場面では呼ばない（レート制限の節約）。
 *
 * 判定材料は `prReadyForMerge` が `reviewGateReady` を参照する条件そのもの：
 * automerge でなければマーカーは要求されず、完了条件未充足や Draft の段階では
 * 手前の項で false 確定するのでマーカーの値は結果を変えない。取得ガードと判定を
 * 別々に書き下さないため、この対応関係はこのモジュール内に閉じる。
 *
 * @param {object} input
 * @param {boolean} [input.automerge]  対象メタ issue に automerge ラベルが付いているか
 * @param {boolean} [input.prCompletionReady]  PR が完了条件を満たすか
 * @param {boolean} [input.draft]  対象 PR が Draft か（未指定は Draft でない扱い）
 * @returns {boolean}
 */
export function needsReviewGate({ automerge = false, prCompletionReady = false, draft = false } = {}) {
  return automerge === true && prCompletionReady === true && draft !== true;
}

/**
 * @param {object} input
 * @param {Array<{ body?: string }>} [input.comments]  対象 issue/PR のコメント（昇順）
 * @param {null|{ state: 'open'|'closed', merged: boolean, draft?: boolean }} [input.pr]  対象 PR の状態（無ければ null。draft 未指定は Draft でない扱い）
 * @param {boolean} [input.prCompletionReady]  PR が完了条件を満たすか（pr が null のときは無視）
 * @param {boolean} [input.automerge]  対象メタ issue に automerge ラベルが付いているか
 * @param {boolean} [input.reviewGateReady]  agent-review-passed マーカーが現 head SHA に対して存在するか（automerge ルートのマージゲート）
 * @returns {{ type: 'waiting-input'|'merged'|'pr-closed-unmerged'|'waiting-merge'|'none' }}
 */
export function decideInProgressAction({
  comments = [],
  pr = null,
  prCompletionReady = false,
  automerge = false,
  reviewGateReady = false,
} = {}) {
  // 「いま誰かがマージできる open PR か」の単一述語。waiting-merge 遷移と
  // automerge の waiting-input override の両方がこれを使う（判定を二重に持たない）。
  // 各条件の根拠はモジュール冒頭の docblock を参照。
  const prReadyForMerge =
    pr != null &&
    pr.state === 'open' &&
    !pr.merged &&
    prCompletionReady &&
    pr.draft !== true &&
    (!automerge || reviewGateReady);

  // automerge 指定時、PR の客観状態が「実装完了＝マージ可能」を示しているなら、未応答の
  // waiting-input は「マージ判断依頼（automerge で事前承認済み）」とみなし、
  // waiting-input に倒さず下の PR 遷移へ進める（マージ手順だけを事前承認する）。
  // PR が未完了の段階での waiting-input は本物の判断待ちなので override しない。
  // レビューマーカー未取得・Draft の段階も「まだマージできない」＝本物の判断待ちとして扱う。
  const automergeOverridesPending =
    automerge && pr != null && (pr.merged || prReadyForMerge);

  // 1. 未応答の waiting-input があれば原則として指示待ちに倒す（人の判断待ち）。
  //    ただし automerge の「完了済み PR に対するマージ判断依頼」は override する。
  if (hasPendingWaitingInput(comments) && !automergeOverridesPending) {
    return { type: 'waiting-input' };
  }

  // 2. PR の客観状態に応じた遷移。
  if (pr) {
    if (pr.merged) return { type: 'merged' };
    if (pr.state === 'closed') return { type: 'pr-closed-unmerged' };
    if (prReadyForMerge) return { type: 'waiting-merge' };
  }

  // 3. まだ作業中。
  return { type: 'none' };
}
