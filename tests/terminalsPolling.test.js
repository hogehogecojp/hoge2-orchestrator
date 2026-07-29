/**
 * waitForTerminalEvent の状態取得ポーリングに関するテスト。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { waitForTerminalEvent } from '../src/terminals/index.js';

test('waitForTerminalEvent: 前回の getStates が未完了なら多重実行しない', async () => {
  const originalFetch = global.fetch;
  const pendingResponses = [];
  let requestCount = 0;

  global.fetch = () => {
    requestCount += 1;
    return new Promise((resolve) => pendingResponses.push(resolve));
  };

  try {
    const waiting = waitForTerminalEvent(13847, 'term-1', {
      pollIntervalMs: 5,
      idleTimeoutMs: 60_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(requestCount, 1, '応答待ちの間は次の状態取得を開始しない');

    pendingResponses[0]({
      json: async () => ({
        terminals: {
          pane1: {
            termId: 'term-1',
            lastOutputTime: Date.now(),
            lastLines: 'confirm?',
            waiting: true,
          },
        },
      }),
    });

    assert.deepEqual(await waiting, { type: 'waiting', lastLines: 'confirm?' });
  } finally {
    global.fetch = originalFetch;
  }
});
