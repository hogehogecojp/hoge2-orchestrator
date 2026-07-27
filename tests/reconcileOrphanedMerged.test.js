import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createReconcileOrphanedMergedTasks } from '../src/engine/reconcile-orphaned-merged.js';

describe('reconcile orphaned merged tasks', () => {
  function createSubject(overrides = {}) {
    const calls = [];
    const warnings = [];
    const logs = [];
    const deps = {
      getAllTasks: async () => ({ 134: { termId: 7 } }),
      getMetaIssue: async () => ({
        state: 'closed',
        body: '**PR:** https://github.com/vektor-inc/vk-orchestrator/pull/134',
      }),
      extractPRUrlFromIssueBody: (body) => {
        const match = body?.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
        return match?.[0] ?? null;
      },
      parsePRUrl: (url) => {
        const match = url.match(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
        return match
          ? { owner: match[1], repo: match[2], number: Number(match[3]) }
          : null;
      },
      getPRState: async () => ({ merged: true }),
      notifyPaneMerged: async (...args) => calls.push(['notifyPaneMerged', ...args]),
      removeTask: async (...args) => calls.push(['removeTask', ...args]),
      logger: {
        log: (message) => logs.push(message),
        warn: (message) => warnings.push(message),
      },
      ...overrides,
    };
    return {
      calls,
      logs,
      warnings,
      reconcile: createReconcileOrphanedMergedTasks(deps),
    };
  }

  it('closed かつ merged の残存エントリは notifyPaneMerged の後に removeTask する', async () => {
    const prUrl = 'https://github.com/vektor-inc/vk-orchestrator/pull/134';
    const { calls, logs, reconcile } = createSubject();

    await reconcile();

    assert.deepEqual(calls, [
      ['notifyPaneMerged', 134, prUrl, '[reconcile-orphaned]'],
      ['removeTask', 134],
    ]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /issue #134/);
  });

  it('メタ issue が open のエントリは通常スキャナ担当としてスキップする', async () => {
    const { calls, reconcile } = createSubject({
      getMetaIssue: async () => ({ state: 'open', body: '**PR:** https://github.com/example/repo/pull/1' }),
    });

    await reconcile();

    assert.deepEqual(calls, []);
  });

  it('メタ issue が closed でも PR が未マージならスキップする', async () => {
    const { calls, reconcile } = createSubject({
      getPRState: async () => ({ merged: false }),
    });

    await reconcile();

    assert.deepEqual(calls, []);
  });

  it('メタ issue が closed でも本文から PR URL を抽出できないならスキップする', async () => {
    const { calls, reconcile } = createSubject({
      getMetaIssue: async () => ({ state: 'closed', body: 'PR URL なし' }),
      extractPRUrlFromIssueBody: () => null,
    });

    await reconcile();

    assert.deepEqual(calls, []);
  });

  it('getAllTasks が空オブジェクトなら何もしない', async () => {
    const { calls, reconcile } = createSubject({
      getAllTasks: async () => ({}),
    });

    await reconcile();

    assert.deepEqual(calls, []);
  });

  it('notifyPaneMerged が throw しても warn で握り removeTask して処理継続する', async () => {
    const calls = [];
    const { warnings, reconcile } = createSubject({
      getAllTasks: async () => ({
        134: { termId: 7 },
        135: { termId: 8 },
      }),
      getMetaIssue: async (issueNumber) => ({
        state: 'closed',
        body: `**PR:** https://github.com/vektor-inc/vk-orchestrator/pull/${issueNumber}`,
      }),
      getPRState: async () => ({ merged: true }),
      notifyPaneMerged: async (...args) => {
        calls.push(['notifyPaneMerged', ...args]);
        if (args[0] === 134) {
          throw new Error('terminal unavailable');
        }
      },
      removeTask: async (...args) => calls.push(['removeTask', ...args]),
    });

    await reconcile();

    assert.deepEqual(calls, [
      ['notifyPaneMerged', 134, 'https://github.com/vektor-inc/vk-orchestrator/pull/134', '[reconcile-orphaned]'],
      ['removeTask', 134],
      ['notifyPaneMerged', 135, 'https://github.com/vektor-inc/vk-orchestrator/pull/135', '[reconcile-orphaned]'],
      ['removeTask', 135],
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /issue #134/);
    assert.match(warnings[0], /terminal unavailable/);
  });
});
