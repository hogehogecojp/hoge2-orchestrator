// -------------------------------------------------------
// 先回りクローズ済みタスクの後始末スキャナ
//
// エージェントが手動マージ後にメタ issue を先に close すると、
// open issue だけを見る通常スキャナから外れて VK Terminals への
// マージ済み通知と state.json の消込機会が失われる。
// state.json に残るエントリを後始末未完了のシグナルとして使い、
// 「メタ issue は closed かつ対応 PR は merged」の残骸だけを冪等に掃除する。
// -------------------------------------------------------

export function createReconcileOrphanedMergedTasks({
  getAllTasks,
  getMetaIssue,
  extractPRUrlFromIssueBody,
  parsePRUrl,
  getPRState,
  notifyPaneMerged,
  removeTask,
  logger = console,
}) {
  return async function reconcileOrphanedMergedTasks() {
    let tasks;
    try {
      tasks = await getAllTasks();
    } catch (err) {
      logger.warn?.(`[reconcile-orphaned] state 取得失敗（次ループで再試行）: ${err.message}`);
      return;
    }

    if (!tasks || typeof tasks !== 'object' || Object.keys(tasks).length === 0) {
      return;
    }

    for (const issueNumberKey of Object.keys(tasks)) {
      const issueNumber = toIssueNumber(issueNumberKey);

      let metaIssue;
      try {
        metaIssue = await getMetaIssue(issueNumber);
      } catch (err) {
        logger.warn?.(`  [reconcile-orphaned] issue #${issueNumber}: メタ issue 取得失敗（次エントリへ継続）: ${err.message}`);
        continue;
      }

      if (metaIssue?.state !== 'closed') {
        continue;
      }

      const prUrl = extractPRUrlFromIssueBody(metaIssue.body);
      if (!prUrl) {
        continue;
      }

      const prRef = parsePRUrl(prUrl);
      if (!prRef) {
        continue;
      }

      let prState;
      try {
        prState = await getPRState(prRef.owner, prRef.repo, prRef.number);
      } catch (err) {
        logger.warn?.(`  [reconcile-orphaned] issue #${issueNumber}: PR 状態取得失敗（次ループで再試行）: ${err.message}`);
        continue;
      }

      if (prState?.merged !== true) {
        continue;
      }

      // removeTask は termId を含む state を消すので、必ず消込前に VK Terminals へ送る。
      if (typeof notifyPaneMerged === 'function') {
        try {
          await notifyPaneMerged(issueNumber, prUrl, '[reconcile-orphaned]');
        } catch (err) {
          logger.warn?.(`  [reconcile-orphaned] issue #${issueNumber}: VK Terminals への prMerged 通知失敗（処理は継続）: ${err.message} (prUrl=${prUrl})`);
        }
      }

      try {
        await removeTask(issueNumber);
      } catch (err) {
        logger.warn?.(`  [reconcile-orphaned] issue #${issueNumber}: state 消込失敗（次ループで再試行）: ${err.message}`);
        continue;
      }
      logger.log?.(`  [reconcile-orphaned] issue #${issueNumber}: 先回りクローズ済み + PR マージ済み → state 消込`);
    }
  };
}

function toIssueNumber(issueNumberKey) {
  const issueNumber = Number(issueNumberKey);
  return Number.isSafeInteger(issueNumber) ? issueNumber : issueNumberKey;
}
