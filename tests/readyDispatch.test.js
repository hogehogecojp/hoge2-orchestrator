/**
 * dispatchReadyIssues（ready ディスパッチ判定）のユニットテスト。
 *
 * GitHub / state / VK Terminals / startTask への副作用は全て fake を依存注入して
 * 検証する。GitHub API 障害で status:in-progress への遷移だけ失敗した場合、
 * state.json には既に termId が残り、実ペインも生存している。この ready issue を
 * 次 tick で再検出しても新規ペインを作らず、ラベル遷移だけ再試行する必要がある。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchReadyIssues } from '../src/engine/ready-dispatch.js';

// console.log / warn / error を黙らせるためのスタブ
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

function issue(number, labels = []) {
  return { number, title: `issue ${number}`, body: '', labels };
}

function makeDeps(overrides = {}) {
  const calls = {
    startTask: [],
    setStatus: [],
    getTask: [],
    getStates: [],
  };
  const deps = {
    inFlightIssues: new Set(),
    occupiedRepos: new Set(),
    getTargetRepoKey: () => 'owner/repo',
    isSequential: () => false,
    startTask: async (taskIssue) => {
      calls.startTask.push(taskIssue.number);
      return true;
    },
    getTask: async (issueNumber) => {
      calls.getTask.push(issueNumber);
      return null;
    },
    getStates: async (port) => {
      calls.getStates.push(port);
      return { terminals: {} };
    },
    setStatus: async (issueNumber, label) => {
      calls.setStatus.push([issueNumber, label]);
    },
    formatErrorSummary: (err) => err.message,
    ...overrides,
  };
  return { deps, calls };
}

describe('dispatchReadyIssues', () => {
  it('state に生存ペインの termId がある ready issue は新規起動せず in-progress 遷移だけ再試行する', async () => {
    const { deps, calls } = makeDeps({
      getTask: async (issueNumber) => {
        calls.getTask.push(issueNumber);
        return { termId: 22, repo: 'owner/repo' };
      },
      getStates: async (port) => {
        calls.getStates.push(port);
        return { terminals: { one: { termId: 22, waiting: false } } };
      },
    });

    await dispatchReadyIssues([issue(151)], deps, {
      port: 4567,
      logger: silentLogger,
    });

    assert.deepEqual(calls.startTask, [], '既存ペインが生きている ready issue で新規ペインを作らない');
    assert.deepEqual(calls.getTask, [151]);
    assert.deepEqual(calls.getStates, [4567]);
    assert.deepEqual(calls.setStatus, [[151, 'status:in-progress']]);
    assert.equal(deps.occupiedRepos.has('owner/repo'), true);
  });

  it('state に termId があるがペインが消失している ready issue は従来どおり新規起動する', async () => {
    const { deps, calls } = makeDeps({
      getTask: async (issueNumber) => {
        calls.getTask.push(issueNumber);
        return { termId: 22, repo: 'owner/repo' };
      },
      getStates: async (port) => {
        calls.getStates.push(port);
        return { terminals: { other: { termId: 99, waiting: false } } };
      },
    });

    await dispatchReadyIssues([issue(152)], deps, {
      port: 4567,
      logger: silentLogger,
    });

    assert.deepEqual(calls.getStates, [4567]);
    assert.deepEqual(calls.startTask, [152]);
    assert.deepEqual(calls.setStatus, []);
    assert.equal(deps.occupiedRepos.has('owner/repo'), true);
  });

  it('VK Terminals states が取得できない場合は termId 記録済み ready の起動を見送る', async () => {
    const logs = [];
    const { deps, calls } = makeDeps({
      getTask: async (issueNumber) => {
        calls.getTask.push(issueNumber);
        if (issueNumber === 153) return { termId: 22, repo: 'owner/repo' };
        return null;
      },
      getStates: async (port) => {
        calls.getStates.push(port);
        throw new Error('terminals down');
      },
    });

    await dispatchReadyIssues([issue(153), issue(154)], deps, {
      port: 4567,
      logger: {
        log: () => {},
        error: () => {},
        warn: (msg) => logs.push(msg),
      },
    });

    assert.deepEqual(calls.getStates, [4567], 'states 取得は失敗時も 1 tick で 1 回だけ');
    assert.deepEqual(calls.startTask, [154], 'termId の無い ready issue は通常どおり起動する');
    assert.deepEqual(calls.setStatus, []);
    assert.match(logs.join('\n'), /states 取得失敗/);
    assert.match(logs.join('\n'), /termId:22 の生死判定ができない/);
  });

  it('既存ペインの in-progress 再試行が失敗しても throw せず新規起動もしない', async () => {
    const logs = [];
    const { deps, calls } = makeDeps({
      getTask: async (issueNumber) => {
        calls.getTask.push(issueNumber);
        return { termId: 22, repo: 'owner/repo' };
      },
      getStates: async (port) => {
        calls.getStates.push(port);
        return { terminals: { one: { termId: 22, waiting: false } } };
      },
      setStatus: async (issueNumber, label) => {
        calls.setStatus.push([issueNumber, label]);
        throw new Error('GitHub 5xx');
      },
    });

    await dispatchReadyIssues([issue(155)], deps, {
      port: 4567,
      logger: {
        log: () => {},
        error: () => {},
        warn: (msg) => logs.push(msg),
      },
    });

    assert.deepEqual(calls.setStatus, [[155, 'status:in-progress']]);
    assert.deepEqual(calls.startTask, []);
    assert.equal(deps.occupiedRepos.has('owner/repo'), false, '再試行失敗時は作業中扱いを追加しない');
    assert.match(logs.join('\n'), /in-progress 遷移の再試行失敗/);
  });

  it('ready issue に state エントリが無い場合は getStates を呼ばず通常起動する', async () => {
    const { deps, calls } = makeDeps();

    await dispatchReadyIssues([issue(156), issue(157)], deps, {
      port: 4567,
      logger: silentLogger,
    });

    assert.deepEqual(calls.getTask, [156, 157]);
    assert.deepEqual(calls.getStates, []);
    assert.deepEqual(calls.startTask, [156, 157]);
  });

  it('state エントリがあっても termId が null の ready issue は getStates を呼ばず通常起動する', async () => {
    const { deps, calls } = makeDeps({
      getTask: async (issueNumber) => {
        calls.getTask.push(issueNumber);
        return { termId: null, repo: 'owner/repo' };
      },
    });

    await dispatchReadyIssues([issue(158)], deps, {
      port: 4567,
      logger: silentLogger,
    });

    assert.deepEqual(calls.getStates, []);
    assert.deepEqual(calls.startTask, [158]);
  });

  it('複数の termId 記録済み ready issue があっても getStates は 1 回だけ呼ぶ', async () => {
    const { deps, calls } = makeDeps({
      getTask: async (issueNumber) => {
        calls.getTask.push(issueNumber);
        return { termId: issueNumber, repo: 'owner/repo' };
      },
      getStates: async (port) => {
        calls.getStates.push(port);
        return {
          terminals: {
            one: { termId: 159, waiting: false },
            two: { termId: 160, waiting: false },
          },
        };
      },
    });

    await dispatchReadyIssues([issue(159), issue(160)], deps, {
      port: 4567,
      logger: silentLogger,
    });

    assert.deepEqual(calls.getStates, [4567]);
    assert.deepEqual(calls.setStatus, [
      [159, 'status:in-progress'],
      [160, 'status:in-progress'],
    ]);
    assert.deepEqual(calls.startTask, []);
  });

  it('生存済みペインの in-progress 再試行は sequential 待機より優先する', async () => {
    const { deps, calls } = makeDeps({
      occupiedRepos: new Set(['owner/repo']),
      isSequential: () => true,
      getTask: async (issueNumber) => {
        calls.getTask.push(issueNumber);
        return { termId: 22, repo: 'owner/repo' };
      },
      getStates: async (port) => {
        calls.getStates.push(port);
        return { terminals: { one: { termId: 22, waiting: false } } };
      },
    });

    await dispatchReadyIssues([issue(161)], deps, {
      port: 4567,
      logger: silentLogger,
    });

    assert.deepEqual(calls.setStatus, [[161, 'status:in-progress']]);
    assert.deepEqual(calls.startTask, []);
  });
});
