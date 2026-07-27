import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { hasGitHubIntegration, disabledGitHubFeatures } from '../src/engine/github-capability.js';
import { LocalQueueClient } from '../src/local-queue/index.js';
import { GitHubClient } from '../src/github/index.js';

const tempDirs = [];
function makeQueuePath() {
  const dir = mkdtempSync(join(tmpdir(), 'vko-cap-'));
  tempDirs.push(dir);
  return join(dir, 'queue.json');
}
test.after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------
// hasGitHubIntegration の判定
// -------------------------------------------------------
test('hasGitHubIntegration: capabilities.githubIntegration が false のときだけ false', () => {
  assert.equal(hasGitHubIntegration({ capabilities: { githubIntegration: false } }), false);
  assert.equal(hasGitHubIntegration({ capabilities: { githubIntegration: true } }), true);
});

test('hasGitHubIntegration: 未宣言クライアントは後方互換で有効(true)扱い', () => {
  assert.equal(hasGitHubIntegration({}), true);
  assert.equal(hasGitHubIntegration({ capabilities: {} }), true);
  assert.equal(hasGitHubIntegration(null), true);
  assert.equal(hasGitHubIntegration(undefined), true);
});

test('disabledGitHubFeatures: 無効化される機能一覧を返す', () => {
  const features = disabledGitHubFeatures();
  assert.ok(Array.isArray(features));
  assert.ok(features.length >= 4);
  assert.ok(features.some(f => f.includes('source import')));
  assert.ok(features.some(f => f.includes('PR 監視')));
  assert.ok(features.some(f => f.includes('automerge')));
});

// -------------------------------------------------------
// GitHubClient は常に GitHub 連携を有効と宣言する
// -------------------------------------------------------
test('GitHubClient: capabilities.githubIntegration は常に true', () => {
  const client = new GitHubClient({ token: 'test-token', owner: 'vektor-inc', repo: 'task-queue' });
  assert.deepEqual(client.capabilities, { githubIntegration: true });
  assert.equal(hasGitHubIntegration(client), true);
});

// -------------------------------------------------------
// LocalQueueClient の capability 宣言（#157 の中核）
// -------------------------------------------------------
test('LocalQueueClient: トークン有りは GitHub 連携有効・内部 GitHubClient を生成する', () => {
  const client = new LocalQueueClient({
    token: 'test-token',
    owner: 'vektor-inc',
    repo: 'task-queue',
    queuePath: makeQueuePath(),
  });
  assert.equal(client.capabilities.githubIntegration, true);
  assert.equal(hasGitHubIntegration(client), true);
  assert.ok(client.github instanceof GitHubClient);
});

test('LocalQueueClient: githubClient 注入時はトークン無しでも GitHub 連携有効', () => {
  const injected = { owner: 'vektor-inc', repo: 'task-queue', queueLabel: 'task-queue' };
  const client = new LocalQueueClient({
    owner: 'vektor-inc',
    repo: 'task-queue',
    queuePath: makeQueuePath(),
    githubClient: injected,
  });
  assert.equal(client.capabilities.githubIntegration, true);
  assert.equal(client.github, injected);
});

test('LocalQueueClient: トークン無し(純ローカル)は GitHub 連携無効・内部 GitHubClient を生成しない', () => {
  const client = new LocalQueueClient({
    owner: 'vektor-inc',
    repo: 'task-queue',
    queuePath: makeQueuePath(),
  });
  assert.equal(client.capabilities.githubIntegration, false);
  assert.equal(hasGitHubIntegration(client), false);
  assert.equal(client.github, null);
  // owner / repo / queueLabel は github に依存せず引数から解決される
  assert.equal(client.owner, 'vektor-inc');
  assert.equal(client.repo, 'task-queue');
  assert.equal(client.queueLabel, 'task-queue');
});

test('LocalQueueClient: 空白のみトークンも「無し」とみなす', () => {
  const client = new LocalQueueClient({
    token: '   ',
    owner: 'vektor-inc',
    repo: 'task-queue',
    queuePath: makeQueuePath(),
  });
  assert.equal(client.capabilities.githubIntegration, false);
  assert.equal(client.github, null);
});

// -------------------------------------------------------
// トークン無し時、GitHub 委譲メソッドに到達すると失敗する
// （＝エンジンは早期 return でここに到達させてはいけない、という契約）
// -------------------------------------------------------
test('LocalQueueClient: トークン無しで GitHub 委譲メソッドを呼ぶと失敗する（ガード必須の証明）', () => {
  const client = new LocalQueueClient({
    owner: 'vektor-inc',
    repo: 'task-queue',
    queuePath: makeQueuePath(),
  });
  // this.github が null のため委譲は同期的に TypeError を投げる（静かに握り潰されない）。
  assert.throws(() => client.findPRForIssue('vektor-inc', 'example', 1), TypeError);
  assert.throws(() => client.searchSourceIssuesByLabel('vektor-inc', 'task-queue'), TypeError);
});

test('LocalQueueClient: トークン無しでも純ローカルの getIssueState（自キュー）は GitHub 不要で動く', async () => {
  const client = new LocalQueueClient({
    owner: 'vektor-inc',
    repo: 'task-queue',
    queuePath: makeQueuePath(),
  });
  const issue = await client.createLocalTask({ title: '純ローカル作業', status: 'ready' });
  const state = await client.getIssueState('vektor-inc', 'task-queue', issue.number, { retryDelays: [] });
  assert.equal(state.title, '純ローカル作業');
  assert.ok(state.labels.includes('status:ready'));
});

// -------------------------------------------------------
// エンジンのガード相当: 無効時は委譲に到達せず早期 return する
// -------------------------------------------------------
test('capability ガード: 無効時は GitHub 委譲を呼ばず早期 return する', async () => {
  const client = new LocalQueueClient({
    owner: 'vektor-inc',
    repo: 'task-queue',
    queuePath: makeQueuePath(),
  });

  // engine の importNewTasks 冒頭ガード（if (!GITHUB_INTEGRATION) return;）を再現。
  async function guardedImport() {
    if (!hasGitHubIntegration(client)) return 'skipped';
    // 到達したら委譲が呼ばれてしまう（トークン無しでは TypeError）。
    await client.searchSourceIssuesByLabel('vektor-inc', 'task-queue');
    return 'ran';
  }

  assert.equal(await guardedImport(), 'skipped');
});

test('capability ガード: 有効時は通常どおり委譲へ進む', async () => {
  const calls = [];
  const client = new LocalQueueClient({
    owner: 'vektor-inc',
    repo: 'task-queue',
    queuePath: makeQueuePath(),
    githubClient: {
      owner: 'vektor-inc',
      repo: 'task-queue',
      queueLabel: 'task-queue',
      searchSourceIssuesByLabel: async (...args) => {
        calls.push(args);
        return [];
      },
    },
  });

  async function guardedImport() {
    if (!hasGitHubIntegration(client)) return 'skipped';
    await client.searchSourceIssuesByLabel('vektor-inc', 'task-queue');
    return 'ran';
  }

  assert.equal(await guardedImport(), 'ran');
  assert.deepEqual(calls, [['vektor-inc', 'task-queue']]);
});
