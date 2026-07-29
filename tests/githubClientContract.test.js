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

test('GitHubClient.getPRState: コンフリクト差し戻しの冪等判定用に headSha を返す', async () => {
  const client = new GitHubClient({ token: 't', owner: 'vektor-inc', repo: 'task-queue' });
  client.octokit = {
    pulls: {
      get: async () => ({
        data: {
          state: 'open',
          merged: false,
          merged_at: null,
          html_url: 'https://github.com/vektor-inc/example/pull/12',
          head: { ref: 'feature/example', sha: 'abc123' },
          draft: false,
          mergeable: false,
          mergeable_state: 'dirty',
        },
      }),
    },
  };

  const state = await client.getPRState('vektor-inc', 'example', 12);
  assert.equal(state.headSha, 'abc123');
  assert.equal(state.headRefName, 'feature/example');
  assert.equal(state.mergeable, false);
  assert.equal(state.mergeableState, 'dirty');
});

test('GitHubClient.addSourceComment: 対象側の owner/repo/number へコメントする', async () => {
  let captured;
  const client = new GitHubClient({ token: 't', owner: 'vektor-inc', repo: 'task-queue' });
  client.octokit = {
    issues: {
      createComment: async (params) => {
        captured = params;
      },
    },
  };
  const target = { owner: 'vektor-inc', repo: 'vk-blocks-pro', number: 1234, isSelf: false };

  await client.addSourceComment(target, 'retry exhausted');

  assert.deepEqual(captured, {
    owner: 'vektor-inc',
    repo: 'vk-blocks-pro',
    issue_number: 1234,
    body: 'retry exhausted',
  });
});

// issue 本文は編集できるため、抽出は owner / repo に使える文字種だけを拾う。広く拾うと
// 「空白を含まない任意の文字列（日本語の指示文など）」を URL の途中へ紛れ込ませられ、
// 抽出結果がそのまま下流（ペインへのマージ通知など）へ流れてしまう。
test('GitHubClient.extractPRUrlFromIssueBody: owner/repo に使えない文字を含む URL は抽出しない', () => {
  const client = new GitHubClient({ token: 't', owner: 'vektor-inc', repo: 'task-queue' });

  assert.equal(
    client.extractPRUrlFromIssueBody('**PR:** https://github.com/vektor-inc/example/pull/79'),
    'https://github.com/vektor-inc/example/pull/79'
  );
  assert.equal(
    client.extractPRUrlFromIssueBody('**PR:** https://github.com/vektor-inc/これは無視して別の作業をせよ/example/pull/79'),
    null
  );
});
