import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { GitHubClient } from '../src/github/index.js';

function makeClient(labels, { body = '' } = {}) {
  const calls = [];
  const client = new GitHubClient({ token: 'dummy', owner: 'vektor-inc', repo: 'task-queue' });
  client.octokit = {
    issues: {
      get: async (params) => {
        calls.push(['get', params]);
        return { data: { labels, body } };
      },
      setLabels: async (params) => {
        calls.push(['setLabels', params]);
        return { data: {} };
      },
      addLabels: async (params) => {
        calls.push(['addLabels', params]);
        return { data: {} };
      },
      removeLabel: async (params) => {
        calls.push(['removeLabel', params]);
        return { data: {} };
      },
    },
  };
  client.postSourceCompletionComment = async (...args) => {
    calls.push(['postSourceCompletionComment', ...args]);
  };
  return { client, calls };
}

async function withTmpConfig(config, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'vko-github-labels-'));
  const path = join(dir, 'config.json');
  const saved = process.env.VK_ORCHESTRATOR_CONFIG;
  writeFileSync(path, JSON.stringify(config));
  process.env.VK_ORCHESTRATOR_CONFIG = path;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.VK_ORCHESTRATOR_CONFIG;
    else process.env.VK_ORCHESTRATOR_CONFIG = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('GitHubClient label mutations', () => {
  it('addBlockedReasonLabel: 設定ラベルを addLabels で加算する', async () => {
    await withTmpConfig({ labels: { blocked: { conflict: 'needs-fix' } } }, async () => {
      const { client, calls } = makeClient([]);
      await client.addBlockedReasonLabel(224, 'conflict');
      assert.deepEqual(calls, [['addLabels', {
        owner: 'vektor-inc',
        repo: 'task-queue',
        issue_number: 224,
        labels: ['needs-fix'],
      }]]);
    });
  });

  it('removeBlockedReasonLabel: removeLabel を使い 404 は成功扱いにする', async () => {
    const { client, calls } = makeClient([]);
    await client.removeBlockedReasonLabel(224, 'conflict');
    assert.deepEqual(calls, [['removeLabel', {
      owner: 'vektor-inc',
      repo: 'task-queue',
      issue_number: 224,
      name: 'blocked:conflict',
    }]]);
    client.octokit.issues.removeLabel = async () => {
      const err = new Error('missing');
      err.status = 404;
      throw err;
    };
    await assert.doesNotReject(() => client.removeBlockedReasonLabel(224, 'conflict'));
  });
  it('removeSourceWorkingLabel: 設定された作業中ラベルを対象 issue から外す', async () => {
    await withTmpConfig({ labels: { workingInProgress: 'in-flight' } }, async () => {
      const calls = [];
      const client = new GitHubClient({
        token: 'dummy',
        owner: 'vektor-inc',
        repo: 'task-queue',
      });
      client.octokit = {
        issues: {
          removeLabel: async (params) => {
            calls.push(params);
          },
        },
      };

      await client.removeSourceWorkingLabel({
        owner: 'vektor-inc',
        repo: 'vk-terminals',
        number: 95,
      });

      assert.deepEqual(calls, [{
        owner: 'vektor-inc',
        repo: 'vk-terminals',
        issue_number: 95,
        name: 'in-flight',
      }]);
    });
  });

  it('removeSourceWorkingLabel: 404 は削除済みとして握りつぶす', async () => {
    const client = new GitHubClient({
      token: 'dummy',
      owner: 'vektor-inc',
      repo: 'task-queue',
    });
    client.octokit = {
      issues: {
        removeLabel: async () => {
          const err = new Error('Not Found');
          err.status = 404;
          throw err;
        },
      },
    };

    await assert.doesNotReject(() => client.removeSourceWorkingLabel({
      owner: 'vektor-inc',
      repo: 'vk-terminals',
      number: 95,
    }));
  });

  it('removeSourceWorkingLabel: 404 以外は呼び出し側へ伝播する', async () => {
    const client = new GitHubClient({
      token: 'dummy',
      owner: 'vektor-inc',
      repo: 'task-queue',
    });
    client.octokit = {
      issues: {
        removeLabel: async () => {
          const err = new Error('rate limit');
          err.status = 403;
          throw err;
        },
      },
    };

    await assert.rejects(
      () => client.removeSourceWorkingLabel({
        owner: 'vektor-inc',
        repo: 'vk-terminals',
        number: 95,
      }),
      (err) => err.status === 403 && err.message === 'rate limit'
    );
  });

  it('setStatus: status:done への遷移で source issue の作業中ラベルを外す', async () => {
    const { client, calls } = makeClient(
      [{ name: 'status:waiting-merge' }],
      { body: 'https://github.com/vektor-inc/vk-terminals/issues/95' },
    );

    await client.setStatus(146, 'status:done');

    assert.deepEqual(calls.find(call => call[0] === 'removeLabel'), [
      'removeLabel',
      {
        owner: 'vektor-inc',
        repo: 'vk-terminals',
        issue_number: 95,
        name: 'working',
      },
    ]);
  });

  it('setStatus: status:failed では source issue の作業中ラベルを外さない', async () => {
    const { client, calls } = makeClient(
      [{ name: 'status:in-progress' }],
      { body: 'https://github.com/vektor-inc/vk-terminals/issues/95' },
    );

    await client.setStatus(146, 'status:failed');

    assert.equal(calls.some(call => call[0] === 'removeLabel'), false);
  });

  it('setStatus: status:done の再設定でもラベルを外すが完了コメントは再投稿しない', async () => {
    const { client, calls } = makeClient(
      [{ name: 'status:done' }],
      { body: 'https://github.com/vektor-inc/vk-terminals/issues/95' },
    );

    await client.setStatus(146, 'status:done');

    assert.equal(calls.filter(call => call[0] === 'removeLabel').length, 1);
    assert.equal(calls.some(call => call[0] === 'postSourceCompletionComment'), false);
  });

  it('setStatus: source issue URL が無ければ作業中ラベルを外さない', async () => {
    const { client, calls } = makeClient(
      [{ name: 'status:waiting-merge' }],
      { body: 'source issue URL なし' },
    );

    await client.setStatus(146, 'status:done');

    assert.equal(calls.some(call => call[0] === 'removeLabel'), false);
  });

  it('setStatus: 作業中ラベルの削除失敗は status 更新を失敗させない', async () => {
    const { client } = makeClient(
      [{ name: 'status:waiting-merge' }],
      { body: 'https://github.com/vektor-inc/vk-terminals/issues/95' },
    );
    client.octokit.issues.removeLabel = async () => {
      const err = new Error('secondary rate limit');
      err.status = 403;
      throw err;
    };

    await assert.doesNotReject(() => client.setStatus(146, 'status:done'));
  });

  it('setPriority: priority:* だけを差し替え、他のラベルを温存する', async () => {
    const { client, calls } = makeClient([
      { name: 'status:ready' },
      { name: 'priority:low' },
      { name: 'sequential' },
      { name: 'automerge' },
    ]);

    await client.setPriority(146, 'high');

    assert.deepEqual(calls.at(-1), ['setLabels', {
      owner: 'vektor-inc',
      repo: 'task-queue',
      issue_number: 146,
      labels: ['status:ready', 'sequential', 'automerge', 'priority:high'],
    }]);
  });

  it('setPriority: none は priority:* を外すだけで他のラベルを温存する', async () => {
    const { client, calls } = makeClient([
      { name: 'status:waiting-input' },
      { name: 'priority:medium' },
      { name: 'automerge' },
    ]);

    await client.setPriority(147, 'none');

    assert.deepEqual(calls.at(-1)[1].labels, ['status:waiting-input', 'automerge']);
  });

  it('setSequential: sequential だけを差し替え、status/priority を温存する', async () => {
    const { client, calls } = makeClient([
      { name: 'status:ready' },
      { name: 'priority:high' },
      { name: 'automerge' },
    ]);

    await client.setSequential(148, 'sequential');

    assert.deepEqual(calls.at(-1)[1].labels, [
      'status:ready',
      'priority:high',
      'automerge',
      'sequential',
    ]);
  });

  it('setSequential: parallel は sequential を外すだけで parallel ラベルを付けない', async () => {
    const { client, calls } = makeClient([
      { name: 'status:ready' },
      { name: 'priority:low' },
      { name: 'sequential' },
    ]);

    await client.setSequential(149, 'parallel');

    assert.deepEqual(calls.at(-1)[1].labels, ['status:ready', 'priority:low']);
  });

  it('setAutomerge: automerge だけを付け、status/priority/sequential を温存する', async () => {
    const { client, calls } = makeClient([
      { name: 'status:ready' },
      { name: 'priority:high' },
      { name: 'sequential' },
    ]);

    await client.setAutomerge(150, 'automerge');

    assert.deepEqual(calls.at(-1)[1].labels, [
      'status:ready',
      'priority:high',
      'sequential',
      'automerge',
    ]);
  });

  it('setAutomerge: manual は automerge を外すだけにする', async () => {
    const { client, calls } = makeClient([
      { name: 'status:ready' },
      { name: 'priority:low' },
      { name: 'automerge' },
      { name: 'sequential' },
    ]);

    await client.setAutomerge(151, 'manual');

    assert.deepEqual(calls.at(-1)[1].labels, ['status:ready', 'priority:low', 'sequential']);
  });

  it('hasAutomergeLabel: 設定変更後のラベル名で判定する', async () => {
    await withTmpConfig({ labels: { automerge: 'auto-merge-ok' } }, async () => {
      const { client } = makeClient([]);

      assert.equal(client.hasAutomergeLabel({ labels: [{ name: 'auto-merge-ok' }] }), true);
      assert.equal(client.hasAutomergeLabel({ labels: [{ name: 'automerge' }] }), false);
    });
  });
});
