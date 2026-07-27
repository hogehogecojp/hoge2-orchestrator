import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createScanInProgressMergedHandler } from '../src/engine/scan-in-progress-merged.js';

describe('scan-in-progress merged handler', () => {
  it('完了コメントにマージ済み PR の URL を含める', async () => {
    const comments = [];
    const issue = { number: 84 };
    const pr = { html_url: 'https://github.com/vektor-inc/vk-orchestrator/pull/84' };
    const handleMerged = createScanInProgressMergedHandler({
      closeSourceIssueBeforeGate: async () => {},
      canTransitionToDone: async () => true,
      addComment: async (issueNumber, body) => comments.push({ issueNumber, body }),
      closeIssue: async () => {},
      setStatus: async () => {},
      notifyPaneMerged: async () => {},
      removeTask: async () => {},
      logger: { log: () => {}, warn: () => {} },
    });

    const result = await handleMerged(issue, pr);

    assert.equal(result, true);
    assert.deepEqual(comments, [
      {
        issueNumber: issue.number,
        body: `✅ 完了\n\nPR: ${pr.html_url} がマージされました。`,
      },
    ]);
    assert.match(comments[0].body, new RegExp(pr.html_url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('notifyPaneMerged を removeTask による termId 消込前に呼ぶ', async () => {
    const calls = [];
    const issue = { number: 85 };
    const pr = { html_url: 'https://github.com/vektor-inc/vk-orchestrator/pull/85' };
    const handleMerged = createScanInProgressMergedHandler({
      closeSourceIssueBeforeGate: async () => calls.push('closeSourceIssueBeforeGate'),
      canTransitionToDone: async () => {
        calls.push('canTransitionToDone');
        return true;
      },
      addComment: async () => calls.push('addComment'),
      closeIssue: async () => calls.push('closeIssue'),
      setStatus: async () => calls.push('setStatus'),
      notifyPaneMerged: async (...args) => calls.push(['notifyPaneMerged', ...args]),
      removeTask: async () => calls.push('removeTask'),
      logger: { log: () => {}, warn: () => {} },
    });

    const result = await handleMerged(issue, pr);

    assert.equal(result, true);
    assert.deepEqual(calls, [
      'closeSourceIssueBeforeGate',
      'canTransitionToDone',
      'addComment',
      'closeIssue',
      'setStatus',
      ['notifyPaneMerged', 85, pr.html_url, '[scan-in-progress]'],
      'removeTask',
    ]);
  });

  it('notifyPaneMerged の失敗は warn のみで握り、done 化を継続する', async () => {
    const calls = [];
    const warnings = [];
    const issue = { number: 86 };
    const pr = { html_url: 'https://github.com/vektor-inc/vk-orchestrator/pull/86' };
    const handleMerged = createScanInProgressMergedHandler({
      closeSourceIssueBeforeGate: async () => calls.push('closeSourceIssueBeforeGate'),
      canTransitionToDone: async () => {
        calls.push('canTransitionToDone');
        return true;
      },
      addComment: async () => calls.push('addComment'),
      closeIssue: async () => calls.push('closeIssue'),
      setStatus: async () => calls.push('setStatus'),
      notifyPaneMerged: async () => {
        calls.push('notifyPaneMerged');
        throw new Error('terminal unavailable');
      },
      removeTask: async () => calls.push('removeTask'),
      logger: { log: () => {}, warn: (message) => warnings.push(message) },
    });

    const result = await handleMerged(issue, pr);

    assert.equal(result, true);
    assert.deepEqual(calls, [
      'closeSourceIssueBeforeGate',
      'canTransitionToDone',
      'addComment',
      'closeIssue',
      'setStatus',
      'notifyPaneMerged',
      'removeTask',
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /issue #86/);
    assert.match(warnings[0], /terminal unavailable/);
  });

  it('PR なし親調整 issue 用の完了コメントを指定できる', async () => {
    const comments = [];
    const notifications = [];
    const issue = { number: 148 };
    const handleMerged = createScanInProgressMergedHandler({
      closeSourceIssueBeforeGate: async () => {},
      canTransitionToDone: async () => true,
      addComment: async (issueNumber, body) => comments.push({ issueNumber, body }),
      closeIssue: async () => {},
      setStatus: async () => {},
      notifyPaneMerged: async (...args) => notifications.push(args),
      removeTask: async () => {},
      logger: { log: () => {}, warn: () => {} },
    });

    const result = await handleMerged(issue, null, {
      completionComment: '✅ 完了\n\n全サブ issue が完了しました。',
    });

    assert.equal(result, true);
    assert.deepEqual(comments, [
      {
        issueNumber: 148,
        body: '✅ 完了\n\n全サブ issue が完了しました。',
      },
    ]);
    assert.deepEqual(notifications, []);
  });
});
