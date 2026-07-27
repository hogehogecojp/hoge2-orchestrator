import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { GitHubClient } from '../src/github/index.js';

function makeClient(labels) {
  const calls = [];
  const client = new GitHubClient({ token: 'dummy', owner: 'vektor-inc', repo: 'task-queue' });
  client.octokit = {
    issues: {
      get: async (params) => {
        calls.push(['get', params]);
        return { data: { labels } };
      },
      setLabels: async (params) => {
        calls.push(['setLabels', params]);
        return { data: {} };
      },
    },
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
