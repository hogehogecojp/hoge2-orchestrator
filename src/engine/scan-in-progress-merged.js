export function createScanInProgressMergedHandler({
  closeSourceIssueBeforeGate,
  canTransitionToDone,
  addComment,
  closeIssue,
  setStatus,
  notifyPaneMerged,
  removeTask,
  logger = console,
}) {
  return async function handleScanInProgressMerged(issue, pr, options = {}) {
    await closeSourceIssueBeforeGate(issue, '[scan-in-progress]');
    if (!(await canTransitionToDone(issue, `[scan-in-progress #${issue.number}]`))) {
      return false;
    }

    try {
      const completionComment = options.completionComment ?? (pr?.html_url
        ? `✅ 完了\n\nPR: ${pr.html_url} がマージされました。`
        : `✅ 完了\n\nPR がマージされました。`);
      await addComment(issue.number, completionComment);
      await closeIssue(issue.number);
      await setStatus(issue.number, 'status:done');
      // removeTask は termId を含む state を消すので、必ず消込前に VK Terminals へ送る。
      if (typeof notifyPaneMerged === 'function' && pr?.html_url) {
        try {
          await notifyPaneMerged(issue.number, pr.html_url, '[scan-in-progress]');
        } catch (err) {
          logger.warn?.(`  [scan-in-progress] issue #${issue.number}: VK Terminals への prMerged 通知失敗（処理は継続）: ${err.message} (prUrl=${pr.html_url})`);
        }
      }
      await removeTask(issue.number);
      logger.log?.(options.logMessage ?? `  [scan-in-progress] issue #${issue.number}: PR マージ済み → done`);
      return true;
    } catch (err) {
      logger.warn?.(`  [scan-in-progress] issue #${issue.number}: done 化失敗（次ループ再試行）: ${err.message}`);
      return false;
    }
  };
}
