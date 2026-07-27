import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createPrLessParentDoneHandler } from '../src/engine/pr-less-parent-done.js';

const silentLogger = { log: () => {}, warn: () => {} };

function createIssue(number = 148) {
  return {
    number,
    title: '親調整 issue',
    body: 'https://github.com/owner/parent-repo/issues/42',
  };
}

function createState(overrides = {}) {
  return {
    target: { owner: 'owner', repo: 'parent-repo', number: 42 },
    pr: null,
    prLookupFailed: false,
    ...overrides,
  };
}

describe('PR なし親調整 issue の done 化判定', () => {
  it('sub-issue あり・全 closed・PR なしなら done 化経路を発火する', async () => {
    const calls = [];
    const issue = createIssue();
    const handleParentDone = createPrLessParentDoneHandler({
      getSubIssueStates: async (owner, repo, number) => {
        calls.push(['getSubIssueStates', owner, repo, number]);
        return [
          { owner: 'owner', repo: 'child-a', number: 1, state: 'closed' },
          { owner: 'owner', repo: 'child-b', number: 2, state: 'closed' },
        ];
      },
      completeIssue: async (receivedIssue) => {
        calls.push(['completeIssue', receivedIssue.number]);
        return true;
      },
      logger: silentLogger,
    });

    const result = await handleParentDone(issue, createState(), { type: 'none' });

    assert.equal(result, true);
    assert.deepEqual(calls, [
      ['getSubIssueStates', 'owner', 'parent-repo', 42],
      ['completeIssue', 148],
    ]);
  });

  it('sub-issue 0 件・PR なしなら何もしない', async () => {
    const calls = [];
    const handleParentDone = createPrLessParentDoneHandler({
      getSubIssueStates: async () => {
        calls.push('getSubIssueStates');
        return [];
      },
      completeIssue: async () => {
        calls.push('completeIssue');
        return true;
      },
      logger: silentLogger,
    });

    const result = await handleParentDone(createIssue(), createState(), { type: 'none' });

    assert.equal(result, false);
    assert.deepEqual(calls, ['getSubIssueStates']);
  });

  it('open の sub-issue が残っているなら何もしない', async () => {
    const calls = [];
    const handleParentDone = createPrLessParentDoneHandler({
      getSubIssueStates: async () => {
        calls.push('getSubIssueStates');
        return [
          { owner: 'owner', repo: 'child-a', number: 1, state: 'closed' },
          { owner: 'owner', repo: 'child-b', number: 2, state: 'open' },
        ];
      },
      completeIssue: async () => {
        calls.push('completeIssue');
        return true;
      },
      logger: silentLogger,
    });

    const result = await handleParentDone(createIssue(), createState(), { type: 'none' });

    assert.equal(result, false);
    assert.deepEqual(calls, ['getSubIssueStates']);
  });

  it('未応答 waiting-input がある場合は従来どおり waiting-input 遷移を優先する', async () => {
    const calls = [];
    const handleParentDone = createPrLessParentDoneHandler({
      getSubIssueStates: async () => {
        calls.push('getSubIssueStates');
        return [
          { owner: 'owner', repo: 'child-a', number: 1, state: 'closed' },
        ];
      },
      completeIssue: async () => {
        calls.push('completeIssue');
        return true;
      },
      logger: silentLogger,
    });

    const result = await handleParentDone(createIssue(), createState(), { type: 'waiting-input' });

    assert.equal(result, false);
    assert.deepEqual(calls, []);
  });

  it('PR が見つかっている場合は sub-issue 状態を取得しない', async () => {
    const calls = [];
    const handleParentDone = createPrLessParentDoneHandler({
      getSubIssueStates: async () => {
        calls.push('getSubIssueStates');
        return [
          { owner: 'owner', repo: 'child-a', number: 1, state: 'closed' },
        ];
      },
      completeIssue: async () => {
        calls.push('completeIssue');
        return true;
      },
      logger: silentLogger,
    });

    const result = await handleParentDone(
      createIssue(),
      createState({ pr: { number: 99, html_url: 'https://github.com/owner/parent-repo/pull/99' } }),
      { type: 'none' }
    );

    assert.equal(result, false);
    assert.deepEqual(calls, []);
  });

  it('PR 検索に失敗している場合は sub-issue 状態を取得しない', async () => {
    const calls = [];
    const handleParentDone = createPrLessParentDoneHandler({
      getSubIssueStates: async () => {
        calls.push('getSubIssueStates');
        return [
          { owner: 'owner', repo: 'child-a', number: 1, state: 'closed' },
        ];
      },
      completeIssue: async () => {
        calls.push('completeIssue');
        return true;
      },
      logger: silentLogger,
    });

    const result = await handleParentDone(
      createIssue(),
      createState({ prLookupFailed: true }),
      { type: 'none' }
    );

    assert.equal(result, false);
    assert.deepEqual(calls, []);
  });

  it('sub-issue 取得失敗時は何もしない', async () => {
    const calls = [];
    const warnings = [];
    const handleParentDone = createPrLessParentDoneHandler({
      getSubIssueStates: async () => {
        calls.push('getSubIssueStates');
        throw new Error('sub issue API failed');
      },
      completeIssue: async () => {
        calls.push('completeIssue');
        return true;
      },
      logger: {
        log: () => {},
        warn: (message) => warnings.push(message),
      },
    });

    const result = await handleParentDone(createIssue(), createState(), { type: 'none' });

    assert.equal(result, false);
    assert.deepEqual(calls, ['getSubIssueStates']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /sub-issue 状態取得失敗/);
    assert.match(warnings[0], /sub issue API failed/);
  });
});
