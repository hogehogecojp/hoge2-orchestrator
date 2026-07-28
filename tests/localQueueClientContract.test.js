import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { LocalQueueClient } from '../src/local-queue/index.js';
import { extractGitHubIssueUrl } from '../src/engine/build-command.js';
import { canTransitionToDone } from '../src/engine/done-gate.js';
import { decideInProgressAction } from '../src/engine/in-progress-decision.js';
import { closeSourceIssueBeforeGate } from '../src/engine/source-close.js';
import { readLocalQueue } from '../src/local-queue/store.js';
import { runQueueClientContract } from './contract/queueClientContract.js';

const tempDirs = [];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'vko-local-queue-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeGitHubClient(extra = {}) {
  return {
    owner: 'vektor-inc',
    repo: 'task-queue',
    queueLabel: 'task-queue',
    postSourceCompletionComment: async () => {},
    removeSourceWorkingLabel: async () => {},
    ...extra,
  };
}

function writeQueue(queuePath, tasks) {
  const maxId = tasks.reduce((max, task) => Math.max(max, task.id), 0);
  writeFileSync(queuePath, JSON.stringify({
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    nextId: maxId + 1,
    tasks,
  }, null, 2));
}

function readQueue(queuePath) {
  return JSON.parse(readFileSync(queuePath, 'utf8'));
}

function runTaskCli(args, { homeDir, env = {} }) {
  return spawnSync(process.execPath, ['bin/vk-orchestrator.js', ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      GITHUB_TOKEN: 'test-token',
      GITHUB_OWNER: 'vektor-inc',
      GITHUB_REPO: 'task-queue',
      QUEUE_BACKEND: 'local',
      ...env,
    },
    encoding: 'utf8',
  });
}

function seedToTask(issue) {
  const now = new Date(Date.UTC(2026, 0, 1, 0, 0, issue.number)).toISOString();
  return {
    id: issue.number,
    state: 'open',
    title: issue.title,
    body: issue.body ?? '',
    status: issue.status ?? 'ready',
    priority: issue.priority ?? 'none',
    sequential: issue.sequential === true,
    automerge: issue.automerge === true,
    cwd: null,
    prUrl: null,
    comments: [],
    assignees: issue.assignees ?? [],
    createdAt: now,
    updatedAt: now,
  };
}

function createLocalQueueClient(seedIssues, options = {}) {
  const dir = makeTempDir();
  const queuePath = join(dir, 'queue.json');
  writeQueue(queuePath, seedIssues.map(seedToTask));
  return new LocalQueueClient({
    token: 'test-token',
    owner: 'vektor-inc',
    repo: 'task-queue',
    queuePath,
    githubClient: options.githubClient ?? fakeGitHubClient(),
  });
}

async function withTmpConfig(config, fn) {
  const dir = makeTempDir();
  const configPath = join(dir, 'config.json');
  const saved = process.env.VK_ORCHESTRATOR_CONFIG;
  writeFileSync(configPath, JSON.stringify(config));
  process.env.VK_ORCHESTRATOR_CONFIG = configPath;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.VK_ORCHESTRATOR_CONFIG;
    else process.env.VK_ORCHESTRATOR_CONFIG = saved;
  }
}

async function importNewTasksLikeEngine(client, sourceOrg, queueLabel) {
  const sourceIssues = await client.searchSourceIssuesByLabel(sourceOrg, queueLabel);
  const createdIssues = [];

  for (const src of sourceIssues) {
    const existing = await client.findTaskQueueIssueBySourceUrl(src.html_url);
    if (existing) continue;

    const claimed = await client.claimSourceIssueByLabelRemoval(src);
    if (!claimed) continue;

    const created = await client.createTaskQueueIssueFromSource(src);
    await client.addSourceWorkingLabel(src);
    await client.postSourceImportComment(src, created.html_url);
    createdIssues.push(created);
  }

  return createdIssues;
}

runQueueClientContract({ label: 'LocalQueueClient', createClient: createLocalQueueClient });

test('LocalQueueClient: removeSourceWorkingLabel を GitHub client へ委譲する', async () => {
  const calls = [];
  const client = createLocalQueueClient([], {
    githubClient: fakeGitHubClient({
      removeSourceWorkingLabel: async (...args) => calls.push(args),
    }),
  });
  const target = { owner: 'vektor-inc', repo: 'example', number: 55 };

  await client.removeSourceWorkingLabel(target);

  assert.deepEqual(calls, [[target]]);
});

test('LocalQueueClient: setStatus は done 再設定でも作業中ラベルを外し、完了コメントは遷移時だけ投稿する', async () => {
  const calls = [];
  const client = createLocalQueueClient([
    {
      number: 11,
      title: 'source task',
      body: 'https://github.com/vektor-inc/example/issues/55',
    },
  ], {
    githubClient: fakeGitHubClient({
      postSourceCompletionComment: async (...args) => {
        calls.push(['postSourceCompletionComment', ...args]);
      },
      removeSourceWorkingLabel: async (...args) => {
        calls.push(['removeSourceWorkingLabel', ...args]);
      },
    }),
  });

  await client.setStatus(11, 'status:done');
  await client.setStatus(11, 'status:done');

  const queue = readQueue(client.queuePath);
  assert.equal(queue.tasks[0].status, 'done');
  assert.equal(calls.filter(call => call[0] === 'postSourceCompletionComment').length, 1);
  assert.equal(calls.filter(call => call[0] === 'removeSourceWorkingLabel').length, 2);
  assert.deepEqual(calls[0][1], {
    url: 'https://github.com/vektor-inc/example/issues/55',
    owner: 'vektor-inc',
    repo: 'example',
    number: 55,
  });
  assert.equal(calls[0][2], 'local://queue/11');
  assert.equal(calls[0][3], 'status:done');
  assert.deepEqual(calls[1], [
    'removeSourceWorkingLabel',
    {
      url: 'https://github.com/vektor-inc/example/issues/55',
      owner: 'vektor-inc',
      repo: 'example',
      number: 55,
    },
  ]);
  assert.deepEqual(calls[2], calls[1]);
});

test('LocalQueueClient: closeIssue は物理削除せず一覧から除外する', async () => {
  const client = createLocalQueueClient([
    { number: 21, title: 'close me' },
    { number: 22, title: 'keep me' },
  ]);

  await client.closeIssue(21);

  assert.deepEqual((await client.listAllQueueIssues()).map(issue => issue.number), [22]);
  const closed = readQueue(client.queuePath).tasks.find(task => task.id === 21);
  assert.equal(closed.state, 'closed');
});

test('LocalQueueClient: setPriority / setSequential / setAutomerge は issue 互換 labels に反映される', async () => {
  const client = createLocalQueueClient([{ number: 31, title: 'label task' }]);

  await client.setPriority(31, 'high');
  await client.setSequential(31, 'sequential');
  await client.setAutomerge(31, 'automerge');

  const [issue] = await client.listAllQueueIssues();
  assert.ok(issue.labels.includes('priority:high'));
  assert.ok(issue.labels.includes('sequential'));
  assert.ok(issue.labels.includes('automerge'));
  assert.equal(client.isSequential(issue), true);
  assert.equal(client.hasAutomergeLabel(issue), true);

  await client.setAutomerge(31, 'manual');

  const [updated] = await client.listAllQueueIssues();
  const stored = readQueue(client.queuePath).tasks.find(task => task.id === 31);
  assert.equal(stored.automerge, false);
  assert.equal(updated.labels.includes('automerge'), false);
});

test('LocalQueueClient: blocked reason の付け外しを issue 互換 labels に反映する', async () => {
  const client = createLocalQueueClient([{ number: 33, title: 'blocked task' }]);

  await client.addBlockedReasonLabel(33, 'conflict');
  let [issue] = await client.listAllQueueIssues();
  assert.ok(issue.labels.includes('blocked:conflict'));

  await client.removeBlockedReasonLabel(33, 'conflict');
  [issue] = await client.listAllQueueIssues();
  assert.equal(issue.labels.includes('blocked:conflict'), false);
});

test('LocalQueueClient: hasAutomergeLabel は設定変更後のラベル名で判定する', async () => {
  await withTmpConfig({ labels: { automerge: 'auto-merge-ok' } }, async () => {
    const client = createLocalQueueClient([{ number: 34, title: 'renamed automerge', automerge: true }]);
    const [issue] = await client.listAllQueueIssues();

    assert.ok(issue.labels.includes('auto-merge-ok'));
    assert.equal(client.hasAutomergeLabel(issue), true);
  });
});

test('LocalQueueClient: getIssueState は自キューのメタ issue を queue.json から返す', async () => {
  const client = createLocalQueueClient([
    {
      number: 32,
      title: 'state task',
      body: 'body text',
      priority: 'high',
      sequential: true,
      automerge: true,
    },
  ]);

  const issue = await client.getIssueState(client.owner, client.repo, 32, { retryDelays: [] });

  assert.equal(issue.state, 'open');
  assert.equal(issue.closedAt, null);
  assert.equal(issue.title, 'state task');
  assert.equal(issue.htmlUrl, 'local://queue/32');
  assert.equal(issue.body, 'body text');
  assert.ok(issue.labels.includes('status:ready'));
  assert.ok(issue.labels.includes('priority:high'));
  assert.ok(issue.labels.includes('sequential'));
  assert.ok(issue.labels.includes('automerge'));
});

test('LocalQueueClient: getIssueState は自キューに存在しない id なら 404 を throw する', async () => {
  const client = createLocalQueueClient([{ number: 33, title: 'known task' }]);

  await assert.rejects(
    client.getIssueState(client.owner, client.repo, 999, { retryDelays: [] }),
    (err) => err.status === 404,
  );
});

test('LocalQueueClient: getIssueState は対象リポ issue なら内包 GitHubClient に委譲する', async () => {
  const calls = [];
  const expected = { state: 'open', closedAt: null, title: 'source issue', htmlUrl: 'https://github.com/vektor-inc/example/issues/55', body: '', labels: [] };
  const client = createLocalQueueClient([], {
    githubClient: fakeGitHubClient({
      getIssueState: async (...args) => {
        calls.push(args);
        return expected;
      },
    }),
  });
  const opts = { retryDelays: [] };

  const actual = await client.getIssueState('vektor-inc', 'example', 55, opts);

  assert.equal(actual, expected);
  assert.deepEqual(calls, [['vektor-inc', 'example', 55, opts]]);
});

test('LocalQueueClient: appendPRUrlToIssue は冪等に PR URL を追記する', async () => {
  const client = createLocalQueueClient([{ number: 41, title: 'pr task', body: 'body' }]);
  const prUrl = 'https://github.com/vektor-inc/example/pull/9';

  await client.appendPRUrlToIssue(41, prUrl);
  await client.appendPRUrlToIssue(41, prUrl);

  const task = readQueue(client.queuePath).tasks[0];
  assert.equal(task.prUrl, prUrl);
  assert.equal([...task.body.matchAll(/\*\*PR:\*\*/g)].length, 1);
  assert.equal(client.extractPRUrlFromIssueBody(task.body), prUrl);
});

test('LocalQueueClient: fetchPendingIssues は priority high / medium / low / none 順で返す', async () => {
  const client = createLocalQueueClient([
    { number: 51, title: 'low', priority: 'low' },
    { number: 52, title: 'none', priority: 'none' },
    { number: 53, title: 'high', priority: 'high' },
    { number: 54, title: 'medium', priority: 'medium' },
  ]);

  assert.deepEqual(
    (await client.fetchPendingIssues()).map(issue => issue.number),
    [53, 54, 51, 52],
  );
});

test('LocalQueueClient: createTaskQueueIssueFromSource と findTaskQueueIssueBySourceUrl が queue.json を扱う', async () => {
  const client = createLocalQueueClient([]);
  const source = {
    number: 71,
    title: 'Implement local backend',
    html_url: 'https://github.com/vektor-inc/example/issues/71',
    repository_url: 'https://api.github.com/repos/vektor-inc/example',
  };

  const created = await client.createTaskQueueIssueFromSource(source);
  const found = await client.findTaskQueueIssueBySourceUrl(source.html_url);

  assert.equal(created.number, 1);
  assert.equal(created.title, '[example] Implement local backend');
  assert.equal(created.body, source.html_url);
  assert.equal(found.number, 1);
  assert.ok(found.labels.includes('status:awaiting-approval'));
});

test('LocalQueueClient: createLocalTask は source URL を足さず純ローカルタスクを queue.json に登録する', async () => {
  const client = createLocalQueueClient([
    { number: 10, title: 'existing task' },
  ]);

  const created = await client.createLocalTask({
    title: '純ローカル作業',
    body: 'issue URL なしの本文',
    priority: 'high',
    sequential: true,
    status: 'waiting-input',
    cwd: '/tmp/local-work',
  });

  assert.equal(created.number, 11);
  assert.equal(created.title, '純ローカル作業');
  assert.equal(created.body, 'issue URL なしの本文');
  assert.ok(created.labels.includes('status:waiting-input'));
  assert.ok(created.labels.includes('priority:high'));
  assert.ok(created.labels.includes('sequential'));

  const task = readQueue(client.queuePath).tasks.find(item => item.id === 11);
  assert.equal(task.state, 'open');
  assert.equal(task.status, 'waiting-input');
  assert.equal(task.priority, 'high');
  assert.equal(task.sequential, true);
  assert.equal(task.automerge, false);
  assert.equal(task.cwd, '/tmp/local-work');
  assert.equal(task.prUrl, null);
  assert.deepEqual(task.comments, []);
  assert.equal(task.body.includes('https://github.com/'), false);
});

test('LocalQueueClient: createLocalTask の既定値は ready / priority none / 非 sequential', async () => {
  const client = createLocalQueueClient([]);

  await client.createLocalTask({ title: 'default local task' });

  const task = readQueue(client.queuePath).tasks[0];
  assert.equal(task.id, 1);
  assert.equal(task.title, 'default local task');
  assert.equal(task.body, '');
  assert.equal(task.status, 'ready');
  assert.equal(task.priority, 'none');
  assert.equal(task.sequential, false);
  assert.equal(task.automerge, false);
  assert.equal(task.cwd, null);
});

test('CLI task: add / list --status --json / set-status はローカル queue.json を操作する', () => {
  const homeDir = makeTempDir();
  const queuePath = join(homeDir, '.task-queue', 'queue.json');

  const addReady = runTaskCli(['task', 'add', 'ready task', '--body', 'plain body'], { homeDir });
  assert.equal(addReady.status, 0, addReady.stderr);
  assert.match(addReady.stdout, /task #1 を登録しました（status:ready）/);

  const addWaiting = runTaskCli([
    'task',
    'add',
    'waiting task',
    '--status',
    'waiting-input',
    '--priority',
    'low',
    '--sequential',
  ], { homeDir });
  assert.equal(addWaiting.status, 0, addWaiting.stderr);

  const listReady = runTaskCli(['task', 'list', '--status', 'ready', '--json'], { homeDir });
  assert.equal(listReady.status, 0, listReady.stderr);
  const listed = JSON.parse(listReady.stdout);
  assert.deepEqual(listed.map(task => task.title), ['ready task']);

  const setDone = runTaskCli(['task', 'set-status', '2', 'done'], { homeDir });
  assert.equal(setDone.status, 0, setDone.stderr);

  const queue = readQueue(queuePath);
  const tasksById = new Map(queue.tasks.map(task => [task.id, task]));
  assert.equal(tasksById.get(1).body, 'plain body');
  assert.equal(tasksById.get(1).status, 'ready');
  assert.equal(tasksById.get(2).status, 'done');
  assert.equal(tasksById.get(2).priority, 'low');
  assert.equal(tasksById.get(2).sequential, true);
});

test('CLI task: github backend では local 専用エラーで終了する', () => {
  const homeDir = makeTempDir();
  const result = runTaskCli(['task', 'list'], {
    homeDir,
    env: { QUEUE_BACKEND: 'github' },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /queue\.backend: local 専用です（現在: github）/);
});

test('LocalQueueClient: importNewTasks 相当の source import は queue.json に作成し、source 操作だけ委譲する', async () => {
  const source = {
    number: 72,
    title: 'Import source issue locally',
    html_url: 'https://github.com/vektor-inc/example/issues/72',
    repository_url: 'https://api.github.com/repos/vektor-inc/example',
  };
  const calls = [];
  const client = createLocalQueueClient([], {
    githubClient: fakeGitHubClient({
      createTaskQueueIssueFromSource: async () => {
        throw new Error('queue issue creation must stay local');
      },
      searchSourceIssuesByLabel: async (...args) => {
        calls.push(['searchSourceIssuesByLabel', ...args]);
        return [source];
      },
      claimSourceIssueByLabelRemoval: async (src) => {
        calls.push(['claimSourceIssueByLabelRemoval', src.html_url]);
        return true;
      },
      addSourceWorkingLabel: async (src) => {
        calls.push(['addSourceWorkingLabel', src.html_url]);
      },
      postSourceImportComment: async (src, queueUrl) => {
        calls.push(['postSourceImportComment', src.html_url, queueUrl]);
      },
    }),
  });

  const firstImport = await importNewTasksLikeEngine(client, 'vektor-inc', 'task-queue');
  const secondImport = await importNewTasksLikeEngine(client, 'vektor-inc', 'task-queue');

  assert.equal(firstImport.length, 1);
  assert.equal(secondImport.length, 0);
  assert.equal(firstImport[0].html_url, 'local://queue/1');
  const queue = readQueue(client.queuePath);
  assert.equal(queue.tasks.length, 1);
  assert.equal(queue.tasks[0].body.split('\n')[0], source.html_url);
  assert.equal(queue.tasks[0].status, 'awaiting-approval');
  assert.equal((await client.findTaskQueueIssueBySourceUrl(source.html_url)).number, 1);
  assert.deepEqual(calls, [
    ['searchSourceIssuesByLabel', 'vektor-inc', 'task-queue'],
    ['claimSourceIssueByLabelRemoval', source.html_url],
    ['addSourceWorkingLabel', source.html_url],
    ['postSourceImportComment', source.html_url, 'local://queue/1'],
    ['searchSourceIssuesByLabel', 'vektor-inc', 'task-queue'],
  ]);
});

test('LocalQueueClient: PR 完了条件充足時に checkPRCompletion と setStatus 経由で waiting-merge へ遷移できる', async () => {
  const prUrl = 'https://github.com/vektor-inc/example/pull/73';
  const calls = [];
  const client = createLocalQueueClient([
    {
      number: 73,
      title: '[example] PR monitoring',
      body: 'https://github.com/vektor-inc/example/issues/173',
      status: 'in-progress',
    },
  ], {
    githubClient: fakeGitHubClient({
      checkPRCompletion: async (...args) => {
        calls.push(['checkPRCompletion', ...args]);
        return { ready: true, ciPassing: true, coderabbitOk: true, headSha: 'abc1234' };
      },
    }),
  });

  const [issue] = await client.fetchInProgressIssues();
  const completion = await client.checkPRCompletion('vektor-inc', 'example', 73);
  const action = decideInProgressAction({
    comments: [],
    // scanInProgressIssues と同じ引数の形（draft / reviewGateReady も渡す。#213）。
    // automerge ラベルの無いタスクなのでレビュー完了マーカーは要求されず、
    // 完了条件充足 + 非 Draft で waiting-merge に進む（従来挙動）。
    pr: { state: 'open', merged: false, draft: false },
    prCompletionReady: completion.ready,
    automerge: client.hasAutomergeLabel(issue),
    reviewGateReady: false,
  });

  assert.equal(action.type, 'waiting-merge');

  await client.appendPRUrlToIssue(issue.number, prUrl);
  await client.setStatus(issue.number, 'status:waiting-merge');

  const queueTask = readQueue(client.queuePath).tasks[0];
  assert.equal(queueTask.status, 'waiting-merge');
  assert.equal(client.extractPRUrlFromIssueBody(queueTask.body), prUrl);
  assert.deepEqual(calls, [['checkPRCompletion', 'vektor-inc', 'example', 73]]);
});

test('LocalQueueClient: automerge 条件充足時に mergePR と done-gate 経由で source close 後 done へ遷移できる', async () => {
  const prUrl = 'https://github.com/vektor-inc/example/pull/74';
  const sourceUrl = 'https://github.com/vektor-inc/example/issues/174';
  const calls = [];
  let sourceClosed = false;
  const client = createLocalQueueClient([
    {
      number: 74,
      title: '[example] automerge local task',
      body: `${sourceUrl}\n\n---\n\n**PR:** ${prUrl}`,
      status: 'waiting-merge',
      automerge: true,
    },
  ], {
    githubClient: fakeGitHubClient({
      getPRState: async (...args) => {
        calls.push(['getPRState', ...args]);
        return {
          state: 'open',
          merged: false,
          draft: false,
          mergeable: true,
          mergeableState: 'clean',
          headRefName: 'feature/local',
        };
      },
      checkPRCompletion: async (...args) => {
        calls.push(['checkPRCompletion', ...args]);
        return { ready: true, ciPassing: true, coderabbitOk: true, headSha: 'def5678' };
      },
      hasReviewGateMarker: async (...args) => {
        calls.push(['hasReviewGateMarker', ...args]);
        return true;
      },
      mergePR: async (...args) => {
        calls.push(['mergePR', ...args]);
        return { merged: true, sha: 'merge-sha' };
      },
      listSubIssueStates: async (...args) => {
        calls.push(['listSubIssueStates', ...args]);
        return [];
      },
      closeSourceIssue: async (target) => {
        calls.push(['closeSourceIssue', target]);
        sourceClosed = true;
      },
      getIssueState: async (...args) => {
        calls.push(['getIssueState', ...args]);
        return { state: sourceClosed ? 'closed' : 'open' };
      },
      postSourceCompletionComment: async (...args) => {
        calls.push(['postSourceCompletionComment', ...args]);
      },
      removeSourceWorkingLabel: async (...args) => {
        calls.push(['removeSourceWorkingLabel', ...args]);
      },
    }),
  });

  const [issue] = await client.fetchWaitingMergeIssues();
  const prRef = client.parsePRUrl(client.extractPRUrlFromIssueBody(issue.body));
  const prState = await client.getPRState(prRef.owner, prRef.repo, prRef.number);
  const completion = await client.checkPRCompletion(prRef.owner, prRef.repo, prRef.number);
  const reviewPassed = await client.hasReviewGateMarker(
    prRef.owner,
    prRef.repo,
    prRef.number,
    completion.headSha,
  );

  assert.equal(client.hasAutomergeLabel(issue), true);
  assert.equal(prState.state, 'open');
  assert.equal(completion.ready, true);
  assert.equal(reviewPassed, true);

  await client.mergePR(prRef.owner, prRef.repo, prRef.number, {
    method: 'squash',
    sha: completion.headSha,
  });
  await closeSourceIssueBeforeGate(
    issue,
    {
      extractGitHubIssueUrl,
      closeSourceIssue: client.closeSourceIssue.bind(client),
      getSubIssueStates: client.listSubIssueStates.bind(client),
    },
    { logger: { log: () => {}, warn: () => {} } },
  );
  const canDone = await canTransitionToDone(
    issue,
    {
      extractGitHubIssueUrl,
      getIssueState: client.getIssueState.bind(client),
      getSubIssueStates: client.listSubIssueStates.bind(client),
    },
    { logger: { log: () => {}, warn: () => {} } },
  );

  assert.equal(canDone, true);

  await client.closeIssue(issue.number);
  await client.setStatus(issue.number, 'status:done');

  const queueTask = readQueue(client.queuePath).tasks[0];
  assert.equal(queueTask.state, 'closed');
  assert.equal(queueTask.status, 'done');
  assert.deepEqual(
    calls.map(call => call[0]),
    [
      'getPRState',
      'checkPRCompletion',
      'hasReviewGateMarker',
      'mergePR',
      'listSubIssueStates',
      'closeSourceIssue',
      'getIssueState',
      'listSubIssueStates',
      'postSourceCompletionComment',
      'removeSourceWorkingLabel',
    ],
  );
  assert.deepEqual(calls.find(call => call[0] === 'mergePR'), [
    'mergePR',
    'vektor-inc',
    'example',
    74,
    { method: 'squash', sha: 'def5678' },
  ]);
  assert.deepEqual(calls.find(call => call[0] === 'closeSourceIssue')[1], {
    url: sourceUrl,
    owner: 'vektor-inc',
    repo: 'example',
    number: 174,
  });
});

test('LocalQueueClient: 同時更新しても queue.json の異なる task 変更を失わない', async () => {
  const client = createLocalQueueClient([
    { number: 81, title: 'first task' },
    { number: 82, title: 'second task' },
  ]);

  await Promise.all([
    client.setStatus(81, 'done'),
    client.setStatus(82, 'failed'),
  ]);

  const tasksById = new Map(readQueue(client.queuePath).tasks.map(task => [task.id, task]));
  assert.equal(tasksById.get(81).status, 'done');
  assert.equal(tasksById.get(82).status, 'failed');
});

test('readLocalQueue: tasks 内の不正要素を除外して warn する', () => {
  const dir = makeTempDir();
  const queuePath = join(dir, 'queue.json');
  writeFileSync(queuePath, JSON.stringify({
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    nextId: 99,
    tasks: [
      null,
      'invalid',
      [],
      { title: 'missing id' },
      { id: 91, state: 'open', title: 'valid', status: 'ready' },
      { id: 0, state: 'open', title: 'invalid id', status: 'ready' },
    ],
  }, null, 2));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    const queue = readLocalQueue(queuePath);

    assert.deepEqual(queue.tasks.map(task => task.id), [91]);
    assert.equal(queue.nextId, 99);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /5 件/);
  } finally {
    console.warn = originalWarn;
  }
});

test('readLocalQueue: JSON パース失敗時は元エラーを cause に保持する', () => {
  const dir = makeTempDir();
  const queuePath = join(dir, 'queue.json');
  writeFileSync(queuePath, '{ invalid json');

  assert.throws(
    () => readLocalQueue(queuePath),
    (err) => {
      assert.match(err.message, /queue\.json の読み込みに失敗しました/);
      assert.ok(err.cause instanceof SyntaxError);
      return true;
    },
  );
});
