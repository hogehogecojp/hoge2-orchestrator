import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GitHubClient } from '../src/github/index.js';
import { runQueueClientContract } from './contract/queueClientContract.js';

// seed を listForRepo が返す mock octokit を持つ GitHubClient を作るファクトリ。
// paginate 経由でも単発 listForRepo 経由でも同じ seed を返すようにして契約を満たす。
function createGitHubClient(seedIssues) {
  const client = new GitHubClient({ token: 'test-token', owner: 'vektor-inc', repo: 'task-queue' });
  const listForRepo = async () => ({ data: seedIssues });
  client.octokit = {
    issues: { listForRepo },
    paginate: async (endpoint, params) => {
      assert.equal(endpoint, listForRepo);
      // paginate は data 配列を直接返す（octokit の実挙動に合わせる）
      const { data } = await endpoint(params);
      return data;
    },
  };
  return client;
}

// 共有契約を GitHubClient で流す
runQueueClientContract({ label: 'GitHubClient', createClient: createGitHubClient });

// --- GitHub 固有の検証 ---

test('GitHubClient.listAllQueueIssues: assignee で絞らず state:open / sort:updated / desc / per_page:100 で取得する', async () => {
  let captured;
  const client = new GitHubClient({ token: 't', owner: 'vektor-inc', repo: 'task-queue' });
  const listForRepo = async () => ({ data: [] });
  client.octokit = {
    issues: { listForRepo },
    paginate: async (endpoint, params) => {
      captured = params;
      return [];
    },
  };

  await client.listAllQueueIssues();
  assert.equal(captured.owner, 'vektor-inc');
  assert.equal(captured.repo, 'task-queue');
  assert.equal(captured.state, 'open');
  assert.equal(captured.sort, 'updated');
  assert.equal(captured.direction, 'desc');
  assert.equal(captured.per_page, 100);
  assert.equal(Object.hasOwn(captured, 'assignee'), false);
});

test('GitHubClient.listAllQueueIssues: paginate が無い octokit では単発 listForRepo にフォールバックする', async () => {
  const seed = [{ number: 9, title: 'fallback' }];
  const client = new GitHubClient({ token: 't', owner: 'vektor-inc', repo: 'task-queue' });
  client.octokit = {
    issues: { listForRepo: async () => ({ data: seed }) },
    // paginate を敢えて持たせない
  };

  assert.deepEqual(await client.listAllQueueIssues(), seed);
});
