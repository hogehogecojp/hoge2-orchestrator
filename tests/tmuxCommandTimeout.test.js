/**
 * tmux コマンド呼び出しのタイムアウト（issue #222）のテスト。
 *
 * tmux サーバーが応答しないと spawnSync が同期ブロックし、約 2 秒間隔のポーリングごと
 * 停止する。ここではテスト用 run に渡された timeoutMs を記録し、各操作が処理の重さに
 * 応じた既定の打ち切り時間を必ず指定することを、実時間を待たずに検証する。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { createDefaultRun, createTmuxBackend } from '../src/terminals/backend-tmux.js';

function recordingRunner(responses = {}) {
  const calls = [];
  const run = (args, options) => {
    calls.push({ args, options });
    const response = responses[args[0]];
    return response ?? { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('health: has-session の打ち切り時間は 3000ms', async () => {
  const { run, calls } = recordingRunner();
  const backend = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });

  await backend.fetchHealth(0);

  assert.deepEqual(calls, [{
    args: ['has-session', '-t', 'vk-orch'],
    options: { timeoutMs: 3_000 },
  }]);
});

test('状態取得: list-panes は 5000ms、capture-pane はペインごとに 3000ms', async () => {
  const { run, calls } = recordingRunner({
    'split-window': { status: 0, stdout: '%3\n', stderr: '' },
    'list-panes': { status: 0, stdout: '%3\n', stderr: '' },
    'capture-pane': { status: 0, stdout: 'body\n', stderr: '' },
  });
  const backend = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  await backend.createNewPane(0, null, {});
  calls.length = 0;

  await backend.getStates(0);

  assert.deepEqual(calls.map(({ args, options }) => ({ command: args[0], ...options })), [
    { command: 'list-panes', timeoutMs: 5_000 },
    { command: 'capture-pane', timeoutMs: 3_000 },
  ]);
});

test('ペイン作成: split-window は 10000ms、表示調整は 3000ms', async () => {
  const { run, calls } = recordingRunner({
    'split-window': { status: 0, stdout: '%3\n', stderr: '' },
  });
  const backend = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });

  await backend.createNewPane(0, null, {});

  assert.deepEqual(calls.map(({ args, options }) => ({ command: args[0], ...options })), [
    { command: 'split-window', timeoutMs: 10_000 },
    { command: 'select-layout', timeoutMs: 3_000 },
    { command: 'set-window-option', timeoutMs: 3_000 },
  ]);
});

test('入力送信: send-keys の打ち切り時間は 3000ms', async () => {
  const { run, calls } = recordingRunner();
  const backend = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });

  await backend.sendToTerminal(0, '%3', 'hello');

  assert.deepEqual(calls.map(({ args, options }) => ({ command: args[0], ...options })), [
    { command: 'send-keys', timeoutMs: 3_000 },
  ]);
});

test('タイトル表示: select-pane の打ち切り時間は 3000ms', async () => {
  const { run, calls } = recordingRunner();
  const backend = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });

  await backend.setTerminalTitle(0, '%3', 'issue #222');

  assert.deepEqual(calls.map(({ args, options }) => ({ command: args[0], ...options })), [
    { command: 'select-pane', timeoutMs: 3_000 },
  ]);
});

test('defaultRun: spawnSync の timeout に timeoutMs を渡す', () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  const run = createDefaultRun({ spawn });

  assert.deepEqual(run(['has-session'], { timeoutMs: 1_234 }), {
    status: 0,
    stdout: 'ok',
    stderr: '',
  });
  assert.deepEqual(calls, [{
    command: 'tmux',
    args: ['has-session'],
    options: { encoding: 'utf8', timeout: 1_234, killSignal: 'SIGKILL' },
  }]);
});

test('defaultRun: error と signal のない正常終了は status 0 を維持する', () => {
  const run = createDefaultRun({
    spawn: () => ({ status: 0, signal: null, stdout: 'ok', stderr: '' }),
  });

  assert.deepEqual(run(['has-session'], { timeoutMs: 3_000 }), {
    status: 0,
    stdout: 'ok',
    stderr: '',
  });
});

test('defaultRun: 実 tmux 同様に status 0 でも ETIMEDOUT なら失敗へ倒す', () => {
  const error = Object.assign(new Error('spawnSync tmux ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const run = createDefaultRun({
    spawn: () => ({ status: 0, signal: null, stdout: '', stderr: '', error }),
  });

  assert.deepEqual(run(['wait-for'], { timeoutMs: 800 }), {
    status: 1,
    stdout: '',
    stderr: 'tmux wait-for timed out after 800ms',
  });
});

test('defaultRun: ETIMEDOUT をコマンド名と打ち切り時間が分かる stderr にする', () => {
  const error = Object.assign(new Error('spawnSync tmux ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const run = createDefaultRun({
    spawn: () => ({ status: null, stdout: '', stderr: '', error }),
  });

  assert.deepEqual(run(['list-panes'], { timeoutMs: 5_000 }), {
    status: 1,
    stdout: '',
    stderr: 'tmux list-panes timed out after 5000ms',
  });
});

test('defaultRun: ETIMEDOUT 以外の spawn エラーも stderr に載せる', () => {
  const error = Object.assign(new Error('spawnSync tmux ENOENT'), { code: 'ENOENT' });
  const run = createDefaultRun({
    spawn: () => ({ status: null, stdout: '', stderr: '', error }),
  });

  const result = run(['has-session'], { timeoutMs: 3_000 });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /tmux has-session failed to start: spawnSync tmux ENOENT/);
});

test('defaultRun: error がなくても signal があれば失敗理由を stderr に載せる', () => {
  const run = createDefaultRun({
    spawn: () => ({ status: 0, signal: 'SIGKILL', stdout: '', stderr: '' }),
  });

  assert.deepEqual(run(['capture-pane'], { timeoutMs: 3_000 }), {
    status: 1,
    stdout: '',
    stderr: 'tmux capture-pane terminated by signal SIGKILL',
  });
});

test('defaultRun: timeoutMs の省略・非正値・非有限値は既定 3000ms に倒す', () => {
  const timeouts = [];
  const run = createDefaultRun({
    spawn: (_command, _args, options) => {
      timeouts.push(options.timeout);
      return { status: 0, signal: null, stdout: '', stderr: '' };
    },
  });

  run(['has-session']);
  run(['has-session'], { timeoutMs: 0 });
  run(['has-session'], { timeoutMs: -1 });
  run(['has-session'], { timeoutMs: Number.NaN });
  run(['has-session'], { timeoutMs: Number.POSITIVE_INFINITY });

  assert.deepEqual(timeouts, [3_000, 3_000, 3_000, 3_000, 3_000]);
});

test('getStates: list-panes 打ち切りは原因を含めて throw する', async () => {
  const run = (args) => args[0] === 'list-panes'
    ? { status: 1, stdout: '', stderr: 'tmux list-panes timed out after 5000ms' }
    : { status: 0, stdout: '', stderr: '' };
  const backend = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });

  await assert.rejects(
    () => backend.getStates(0),
    /list-panes failed.*tmux list-panes timed out after 5000ms/
  );
});

test('sendToTerminal: send-keys 打ち切りは原因を含めて throw する', async () => {
  const run = () => ({
    status: 1,
    stdout: '',
    stderr: 'tmux send-keys timed out after 3000ms',
  });
  const backend = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });

  await assert.rejects(
    () => backend.sendToTerminal(0, '%3', 'hello'),
    /send-keys failed.*tmux send-keys timed out after 3000ms/
  );
});

test('getStates: capture-pane 打ち切り時は前回の出力と活動時刻を維持する', async () => {
  let clock = 100;
  let captureTimedOut = false;
  const run = (args) => {
    if (args[0] === 'split-window') return { status: 0, stdout: '%3\n', stderr: '' };
    if (args[0] === 'list-panes') return { status: 0, stdout: '%3\n', stderr: '' };
    if (args[0] === 'capture-pane') {
      return captureTimedOut
        ? { status: 1, stdout: '', stderr: 'tmux capture-pane timed out after 3000ms' }
        : { status: 0, stdout: 'previous output\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const backend = createTmuxBackend({
    session: 'vk-orch',
    claudeCommand: 'claude',
    run,
    now: () => clock,
    warn: () => {},
  });
  await backend.createNewPane(0, null, {});
  let { terminals } = await backend.getStates(0);
  assert.equal(terminals['%3'].lastLines, 'previous output\n');
  assert.equal(terminals['%3'].lastOutputTime, 100);

  clock = 200;
  captureTimedOut = true;
  ({ terminals } = await backend.getStates(0));

  assert.equal(terminals['%3'].lastLines, 'previous output\n');
  assert.equal(terminals['%3'].lastOutputTime, 100);
});

test('getStates: 全体予算切れ後の capture をスキップし、前回値を維持する', async () => {
  let clock = 100;
  let paneCounter = 0;
  let exhaustBudget = false;
  const captureCalls = [];
  const run = (args, options) => {
    if (args[0] === 'split-window') {
      paneCounter += 1;
      return { status: 0, stdout: `%${paneCounter}\n`, stderr: '' };
    }
    if (args[0] === 'list-panes') {
      if (exhaustBudget) clock += 5_000;
      return { status: 0, stdout: '%1\n%2\n', stderr: '' };
    }
    if (args[0] === 'capture-pane') {
      const paneId = args[args.indexOf('-t') + 1];
      captureCalls.push({ paneId, timeoutMs: options.timeoutMs });
      if (exhaustBudget) clock += options.timeoutMs;
      return { status: 0, stdout: `previous ${paneId}`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const backend = createTmuxBackend({
    session: 'vk-orch',
    claudeCommand: 'claude',
    run,
    now: () => clock,
    warn: () => {},
  });
  await backend.createNewPane(0, null, {});
  await backend.createNewPane(0, null, {});
  let { terminals } = await backend.getStates(0);
  assert.equal(terminals['%2'].lastLines, 'previous %2');

  captureCalls.length = 0;
  exhaustBudget = true;
  clock = 200;
  ({ terminals } = await backend.getStates(0));

  assert.deepEqual(captureCalls, [{ paneId: '%1', timeoutMs: 2_500 }]);
  assert.equal(terminals['%2'].lastLines, 'previous %2');
  assert.equal(terminals['%2'].lastOutputTime, 100);
});

test('getStates: 予算が限られても LRU 順で巡回し、後発ペインを飢餓させない', async () => {
  let clock = 100;
  let paneCounter = 0;
  const capturesByRound = [];
  let captures = [];
  const run = (args, options) => {
    if (args[0] === 'split-window') {
      paneCounter += 1;
      return { status: 0, stdout: `%${paneCounter}\n`, stderr: '' };
    }
    if (args[0] === 'list-panes') {
      clock += 5_000;
      return { status: 0, stdout: '%1\n%2\n%3\n%4\n', stderr: '' };
    }
    if (args[0] === 'capture-pane') {
      const paneId = args[args.indexOf('-t') + 1];
      captures.push(paneId);
      clock += options.timeoutMs;
      return { status: 1, stdout: '', stderr: 'timed out' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const backend = createTmuxBackend({
    session: 'vk-orch',
    claudeCommand: 'claude',
    run,
    now: () => clock,
    warn: () => {},
  });
  for (let i = 0; i < 4; i += 1) await backend.createNewPane(0, null, {});

  for (let round = 0; round < 4; round += 1) {
    captures = [];
    await backend.getStates(0);
    capturesByRound.push(captures);
    clock += 60_000;
  }

  assert.deepEqual(capturesByRound, [['%1'], ['%2'], ['%3'], ['%4']]);
});

test('getStates: capture 失敗と予算切れが同一巡回でも別々に warn する', async () => {
  let clock = 100;
  let paneCounter = 0;
  const warnings = [];
  const run = (args, options) => {
    if (args[0] === 'split-window') {
      paneCounter += 1;
      return { status: 0, stdout: `%${paneCounter}\n`, stderr: '' };
    }
    if (args[0] === 'list-panes') {
      clock += 5_000;
      return { status: 0, stdout: '%1\n%2\n', stderr: '' };
    }
    if (args[0] === 'capture-pane') {
      clock += options.timeoutMs;
      return { status: 1, stdout: '', stderr: 'tmux capture-pane timed out' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const backend = createTmuxBackend({
    session: 'vk-orch',
    claudeCommand: 'claude',
    run,
    now: () => clock,
    warn: (message) => warnings.push(message),
  });
  await backend.createNewPane(0, null, {});
  await backend.createNewPane(0, null, {});

  await backend.getStates(0);

  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /capture-pane failed.*timed out/);
  assert.match(warnings[1], /capture-pane:budget failed.*budget exhausted/);
});

test('getStates: capture の残予算が 100ms 未満なら spawn せずスキップする', async () => {
  let clock = 100;
  let captureCalls = 0;
  const run = (args) => {
    if (args[0] === 'split-window') return { status: 0, stdout: '%1\n', stderr: '' };
    if (args[0] === 'list-panes') {
      clock += 7_401;
      return { status: 0, stdout: '%1\n', stderr: '' };
    }
    if (args[0] === 'capture-pane') captureCalls += 1;
    return { status: 0, stdout: '', stderr: '' };
  };
  const backend = createTmuxBackend({
    session: 'vk-orch',
    claudeCommand: 'claude',
    run,
    now: () => clock,
    warn: () => {},
  });
  await backend.createNewPane(0, null, {});

  await backend.getStates(0);

  assert.equal(captureCalls, 0);
});

test('無視可能な tmux 失敗はサブコマンド単位で 60 秒に 1 回だけ warn する', async () => {
  let clock = 100;
  const warnings = [];
  const run = (args) => {
    if (args[0] === 'split-window') return { status: 0, stdout: '%3\n', stderr: '' };
    if (args[0] === 'list-panes') return { status: 0, stdout: '%3\n', stderr: '' };
    if (args[0] === 'capture-pane') {
      return { status: 1, stdout: '', stderr: 'tmux capture-pane timed out after 3000ms' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const backend = createTmuxBackend({
    session: 'vk-orch',
    claudeCommand: 'claude',
    run,
    now: () => clock,
    warn: (message) => warnings.push(message),
  });
  await backend.createNewPane(0, null, {});

  await backend.getStates(0);
  clock = 200;
  await backend.getStates(0);
  clock = 60_100;
  await backend.getStates(0);

  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /capture-pane failed.*timed out/);
});

test('表示系 tmux コマンドの失敗も warn する', async () => {
  const warnings = [];
  const run = (args) => {
    if (args[0] === 'split-window') return { status: 0, stdout: '%3\n', stderr: '' };
    return { status: 1, stdout: '', stderr: `${args[0]} timed out` };
  };
  const backend = createTmuxBackend({
    session: 'vk-orch',
    claudeCommand: 'claude',
    run,
    now: () => 100,
    warn: (message) => warnings.push(message),
  });

  await backend.createNewPane(0, null, {});
  await backend.setTerminalTitle(0, '%3', 'issue #222');

  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /select-layout failed/);
  assert.match(warnings[1], /set-window-option failed/);
  assert.match(warnings[2], /select-pane failed/);
});

test('表示系 tmux コマンドは同一サブコマンドが連続失敗しても warn を連発しない', async () => {
  const warnings = [];
  const backend = createTmuxBackend({
    session: 'vk-orch',
    claudeCommand: 'claude',
    run: () => ({ status: 1, stdout: '', stderr: 'select-pane timed out' }),
    now: () => 100,
    warn: (message) => warnings.push(message),
  });

  await backend.setTerminalTitle(0, '%3', 'issue #222');
  await backend.setTerminalTitle(0, '%3', 'issue #222 retry');

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /select-pane failed/);
});

test('split-window 失敗は孤児ペインの可能性を warn して throw する', async () => {
  const warnings = [];
  const backend = createTmuxBackend({
    session: 'vk-orch',
    claudeCommand: 'claude',
    run: () => ({ status: 1, stdout: '', stderr: 'timed out' }),
    warn: (message) => warnings.push(message),
  });

  await assert.rejects(() => backend.createNewPane(0, null, {}), /split-window failed/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /孤児ペインが残った可能性/);
});

test('実コマンドが応答しなくても指定時間で打ち切られる', () => {
  const run = createDefaultRun({
    spawn: (_command, args, options) => spawnSync(process.execPath, args, options),
  });
  const startedAt = Date.now();

  const result = run(['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 30 });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /timed out after 30ms/);
  assert.ok(Date.now() - startedAt < 5_000, '5秒以内に制御が戻る');
});
