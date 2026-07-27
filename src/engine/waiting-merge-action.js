/**
 * マージ判定スキャン（checkWaitingMergeIssues）の各候補に対し、取るべきアクションを
 * 決める純粋関数。
 *
 * ## 背景（issue #209）
 *
 * 後付け automerge（#207）で waiting-input の automerge ラベル付き issue も
 * マージ判定スキャンの対象に含めるようになったが、waiting-input 分岐は対象 PR が
 * `open` のときだけ tryAutoMerge を試み、**既に merged の場合は「automerge 試行なし」
 * とログを出してスキップ**していた。このため automerge ラベル付きで
 * `status:waiting-input` に滞留した issue の PR が GitHub UI 等で外部から手動マージ
 * されると、close + done + cleanup 経路に載らず `waiting-input` のまま残り続けた。
 *
 * そこで merged 判定を source 分岐より前に共通化し、`prState.merged` なら source
 * （waiting-merge / waiting-input）を問わず既存のマージ完了ルート（'complete-merge'）へ
 * 流す。waiting-input 分岐は「未マージ」ケース（open なら automerge 試行、それ以外は
 * スキップ）のみを担当する。完了ロジックの二重管理を避けるため、waiting-input 側に
 * merged 処理を複製はしない。
 *
 * 冪等性: 'complete-merge' の実処理は呼び出し側の `canTransitionToDone` ゲート +
 * close 成功時のみ done 化する実装をそのまま共有するため、次ループで close 済み・
 * done 済みの issue はそもそもスキャン対象から外れ、二重処理は起きない。
 *
 * GitHub API 依存を持たない純粋関数として切り出し、ユニットテスト可能にしている
 * （automerge-candidates.js / in-progress-decision.js / scan-in-progress-merged.js と
 * 同じ思想）。
 *
 * @param {object} input
 * @param {'waiting-merge'|'waiting-input'} input.source  候補の由来
 * @param {object} input.prState  github.getPRState() の結果（{ state, merged, ... }）
 * @param {boolean} [input.hasAutomergeLabel=false]  対象 issue の automerge ラベル有無
 * @returns {'complete-merge'|'try-automerge'|'skip'}
 *   - 'complete-merge': merged 済み。close + done + cleanup の完了ルートへ進む。
 *   - 'try-automerge': 未マージ・open。条件を再検証して自動マージを試みる。
 *   - 'skip': それ以外（未マージで closed、または open だが automerge 対象外）。待機継続。
 */
export function resolveWaitingMergeAction({
  source,
  prState,
  hasAutomergeLabel = false,
} = {}) {
  // マージ済みなら source を問わず完了ルートへ（#209 の修正の核心）。
  // state（open/closed）に依存せず merged を最優先で判定する。
  if (prState?.merged) {
    return 'complete-merge';
  }

  // 未マージ。open 以外（未マージで closed 等）は待機継続。
  if (prState?.state !== 'open') {
    return 'skip';
  }

  // 未マージ・open。
  // - waiting-input 候補は selectAutomergeCandidates 時点で automerge ラベル確定済み。
  // - waiting-merge は automerge ラベル付きのときだけ自動マージを試みる（既存動作）。
  if (source === 'waiting-input' || hasAutomergeLabel) {
    return 'try-automerge';
  }

  // waiting-merge かつ automerge ラベル無し → マージ検知待ちのまま待機継続。
  return 'skip';
}
