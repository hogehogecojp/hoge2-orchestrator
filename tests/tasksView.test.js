import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  buildTasksView,
  fetchAllTaskQueueIssues,
  normalizeTaskIssue,
  refreshTasksViewSnapshot,
  writeTasksViewFile,
} from '../src/engine/tasks-view.js';

async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'vko-tasks-view-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('normalizeTaskIssue: status/担当者/対象 issue URL/PR URL を正規化する', () => {
  const task = normalizeTaskIssue({
    number: 139,
    title: 'tasks-view snapshot',
    body: [
      'https://github.com/vektor-inc/vk-orchestrator/issues/138',
      '',
      '---',
      '',
      '**PR:** https://github.com/vektor-inc/vk-orchestrator/pull/140',
    ].join('\n'),
    labels: [{ name: 'status:waiting-merge' }, { name: 'priority:high' }, { name: 'sequential' }, { name: 'automerge' }],
    assignees: [{ login: 'wada' }, { login: 'tsukasa' }],
    html_url: 'https://github.com/vektor-inc/task-queue/issues/139',
    updated_at: '2026-07-17T01:02:03Z',
  });

  assert.deepEqual(task, {
    id: '139',
    number: 139,
    title: 'tasks-view snapshot',
    status: 'waiting-merge',
    statusLabel: 'status:waiting-merge',
    priority: 'high',
    sequential: true,
    automerge: true,
    assignee: 'wada',
    assignees: ['wada', 'tsukasa'],
    targetIssueUrl: 'https://github.com/vektor-inc/vk-orchestrator/issues/138',
    prUrl: 'https://github.com/vektor-inc/vk-orchestrator/pull/140',
    queueIssueUrl: 'https://github.com/vektor-inc/task-queue/issues/139',
    updatedAt: '2026-07-17T01:02:03Z',
  });
});

test('normalizeTaskIssue: priority ラベルが無ければ null、sequential/automerge が無ければ false を返す', () => {
  const task = normalizeTaskIssue({
    number: 140,
    title: 'parallel task',
    labels: [{ name: 'status:ready' }, { name: 'bug' }],
  });

  assert.equal(task.priority, null);
  assert.equal(task.sequential, false);
  assert.equal(task.automerge, false);
});

test('normalizeTaskIssue: automerge ラベル名は設定値で判定する', () => {
  const task = normalizeTaskIssue({
    number: 141,
    title: 'renamed automerge task',
    labels: [{ name: 'status:ready' }, { name: 'auto-merge-ok' }],
  }, {
    labelsConfig: { automerge: 'auto-merge-ok' },
  });

  assert.equal(task.automerge, true);
});

test('buildTasksView: root updatedAt を含め、pull request は除外する', () => {
  const view = buildTasksView([
    { number: 1, title: 'issue', labels: [], assignees: [] },
    { number: 2, title: 'pr', pull_request: {}, labels: [], assignees: [] },
  ], { now: new Date('2026-07-17T04:05:06Z') });

  assert.equal(view.updatedAt, '2026-07-17T04:05:06.000Z');
  assert.deepEqual(view.tasks.map((task) => task.id), ['1']);
});

test('buildTasksView: viewer に具体的ログイン名を渡すとそのまま viewer に入る', () => {
  const view = buildTasksView([], { viewer: '  Wada  ' });

  // 前後空白は trim、大小文字はそのまま保持する
  assert.equal(view.viewer, 'Wada');
});

test('buildTasksView: all / 空文字 / 未指定のとき viewer は null', () => {
  assert.equal(buildTasksView([], { viewer: 'all' }).viewer, null);
  assert.equal(buildTasksView([], { viewer: 'ALL' }).viewer, null);
  assert.equal(buildTasksView([], { viewer: '   ' }).viewer, null);
  assert.equal(buildTasksView([], { viewer: '' }).viewer, null);
  assert.equal(buildTasksView([], {}).viewer, null);
});

test('fetchAllTaskQueueIssues: クライアントの listAllQueueIssues に委譲する', async () => {
  const issues = [{ number: 1, title: 'team task' }];
  let called = false;
  const github = {
    listAllQueueIssues: async () => {
      called = true;
      return issues;
    },
  };

  assert.deepEqual(await fetchAllTaskQueueIssues(github), issues);
  assert.equal(called, true);
});

test('writeTasksViewFile: 一時ファイル経由で JSON を書き出す', async () => {
  await withTmpDir(async (dir) => {
    const filePath = join(dir, 'tasks-view.json');
    await writeTasksViewFile({ updatedAt: 'now', tasks: [] }, { filePath });

    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), {
      updatedAt: 'now',
      tasks: [],
    });
    assert.deepEqual(readdirSync(dir).sort(), ['tasks-view.json']);
  });
});

test('refreshTasksViewSnapshot: 書き出し失敗は warn のみで握りつぶす', async () => {
  const warnings = [];
  const result = await refreshTasksViewSnapshot(
    { owner: 'o', repo: 'r', octokit: { issues: {} } },
    {
      filePath: '/dev/null/tasks-view.json',
      issues: [],
      logger: { warn: (message) => warnings.push(message) },
    },
  );

  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tasks-view\.json 書き出し失敗/);
});
