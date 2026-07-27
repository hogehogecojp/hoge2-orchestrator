// PR を持たない親調整 issue の完了判定。
//
// PR 起点の scan-in-progress 経路とは別に、GitHub ネイティブ sub-issue を持つ
// 親 issue は「直下 sub-issue が全て closed」になった時点で done 化できる。
// ただし sub-issue 0 件の通常タスクを誤 close しないよう、1 件以上あることを
// このヘルパー側で必ず確認してから既存の done 化処理へ渡す。

/**
 * @param {object} deps
 * @param {function} deps.getSubIssueStates (owner, repo, number) => Promise<Array<{ owner, repo, number, state }>>
 * @param {function} deps.completeIssue     (issue) => Promise<boolean>
 * @param {object}   [deps.logger=console]  console 互換オブジェクト
 * @returns {function}
 */
export function createPrLessParentDoneHandler({
  getSubIssueStates,
  completeIssue,
  logger = console,
}) {
  return async function handlePrLessParentDone(issue, state = {}, action = { type: 'none' }) {
    if (action.type !== 'none') return false;
    if (state.pr != null) return false;
    if (state.prLookupFailed) return false;

    const target = state.target;
    if (!target) return false;

    let subIssues;
    try {
      subIssues = await getSubIssueStates(target.owner, target.repo, target.number);
    } catch (err) {
      logger.warn?.(
        `  [scan-in-progress] issue #${issue.number}: 対象 ${target.owner}/${target.repo}#${target.number} の sub-issue 状態取得失敗（PR なし親調整 issue の done 化を見送り、次ループ再試行）: ${err.message}`
      );
      return false;
    }

    if (subIssues.length === 0) {
      logger.log?.(
        `  [scan-in-progress] issue #${issue.number}: 対象 ${target.owner}/${target.repo}#${target.number} に sub-issue が無いため PR なし親調整 issue の done 化を見送り`
      );
      return false;
    }

    const incompleteSubIssues = subIssues.filter(subIssue => subIssue.state !== 'closed');
    if (incompleteSubIssues.length > 0) {
      const refs = incompleteSubIssues
        .map(subIssue => `${subIssue.owner}/${subIssue.repo}#${subIssue.number}(${subIssue.state})`)
        .join(', ');
      logger.log?.(
        `  [scan-in-progress] issue #${issue.number}: 対象 ${target.owner}/${target.repo}#${target.number} の sub-issue が未完了のため PR なし親調整 issue の done 化を見送り: ${refs}`
      );
      return false;
    }

    try {
      return await completeIssue(issue);
    } catch (err) {
      logger.warn?.(
        `  [scan-in-progress] issue #${issue.number}: PR なし親調整 issue の done 化失敗（次ループ再試行）: ${err.message}`
      );
      return false;
    }
  };
}
