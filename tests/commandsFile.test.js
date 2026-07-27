import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

import {
  consumeCommandsFile,
  createCommandsFileProcessor,
  isAllowedTransition,
  processApplyBatchCommand,
  startCommandsFileWatcher,
} from '../src/engine/commands-file.js';

async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'vko-commands-file-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeCommands(filePath, commands) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, commands.map((command) => JSON.stringify(command)).join('\n') + '\n');
}

function silentLogger() {
  return { info() {}, warn() {} };
}

function captureLogger() {
  const entries = { info: [], warn: [] };
  return {
    entries,
    logger: {
      info(message) { entries.info.push(message); },
      warn(message) { entries.warn.push(message); },
    },
  };
}

function httpError(status, message = `HTTP ${status}`) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 20 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail('condition was not met before timeout');
}

test('isAllowedTransition: 許可遷移だけを accept する', () => {
  const allowed = [
    ['awaiting-approval', 'ready'],
    ['ready', 'awaiting-approval'],
    ['in-progress', 'awaiting-approval'],
    ['waiting-input', 'awaiting-approval'],
    ['waiting-merge', 'awaiting-approval'],
    ['failed', 'awaiting-approval'],
    ['waiting-merge', 'done'],
    ['failed', 'ready'],
    ['ready', 'failed'],
  ];

  for (const [from, to] of allowed) {
    assert.equal(isAllowedTransition(from, to), true, `${from} -> ${to}`);
  }

  assert.equal(isAllowedTransition('in-progress', 'done'), false);
  assert.equal(isAllowedTransition('awaiting-approval', 'done'), false);
  assert.equal(isAllowedTransition('status:ready', 'status:done'), false);
});

test('consumeCommandsFile: 差し戻し遷移は awaiting-approval へ戻せる', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'revert-to-approval',
      taskId: 41,
      action: 'set-status',
      expected: 'waiting-input',
      to: 'awaiting-approval',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setStatus: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:waiting-input' }],
      }),
    });

    assert.deepEqual(calls, [[41, 'status:awaiting-approval']]);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 1, skipped: 0 });
  });
});

test('consumeCommandsFile: CAS 一致なら setStatus を呼ぶ', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'cmd-1',
      taskId: '42',
      action: 'set-status',
      expected: 'status:awaiting-approval',
      to: 'ready',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      now: () => new Date('2026-07-18T00:00:01.000Z'),
      github: {
        setStatus: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:awaiting-approval' }, { name: 'priority:high' }],
      }),
    });

    assert.deepEqual(calls, [[42, 'status:ready']]);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 1, skipped: 0 });
  });
});

test('consumeCommandsFile: CAS 不一致なら適用せず throw しない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'cmd-2',
      taskId: 43,
      action: 'set-status',
      expected: 'awaiting-approval',
      to: 'ready',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setStatus: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:failed' }],
      }),
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
  });
});

test('consumeCommandsFile: set-priority は CAS 一致なら setPriority を呼ぶ', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'priority-apply',
      taskId: 50,
      action: 'set-priority',
      expected: 'medium',
      to: 'high',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setPriority: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:ready' }, { name: 'priority:medium' }],
      }),
    });

    assert.deepEqual(calls, [[50, 'high']]);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 1, skipped: 0 });
  });
});

test('consumeCommandsFile: set-priority は none を優先度ラベル無しとして扱う', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'priority-none',
      taskId: 51,
      action: 'set-priority',
      expected: 'none',
      to: 'low',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setPriority: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:ready' }],
      }),
    });

    assert.deepEqual(calls, [[51, 'low']]);
  });
});

test('consumeCommandsFile: set-priority は CAS 不一致なら適用しない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'priority-cas-mismatch',
      taskId: 52,
      action: 'set-priority',
      expected: 'high',
      to: 'low',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setPriority: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'priority:medium' }],
      }),
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
  });
});

test('consumeCommandsFile: set-priority は不正値を拒否してメタ issue を読まない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'priority-invalid',
      taskId: 53,
      action: 'set-priority',
      expected: 'high',
      to: 'urgent',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setPriority: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => {
        throw new Error('getMetaIssue should not be called for invalid priority');
      },
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
  });
});

test('consumeCommandsFile: set-sequential は CAS 一致なら setSequential を呼ぶ', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'sequential-apply',
      taskId: 54,
      action: 'set-sequential',
      expected: 'parallel',
      to: 'sequential',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setSequential: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:ready' }],
      }),
    });

    assert.deepEqual(calls, [[54, 'sequential']]);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 1, skipped: 0 });
  });
});

test('consumeCommandsFile: set-sequential は CAS 不一致なら適用しない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'sequential-cas-mismatch',
      taskId: 55,
      action: 'set-sequential',
      expected: 'parallel',
      to: 'sequential',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setSequential: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'sequential' }],
      }),
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
  });
});

test('consumeCommandsFile: set-sequential は不正値を拒否してメタ issue を読まない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'sequential-invalid',
      taskId: 56,
      action: 'set-sequential',
      expected: 'parallel',
      to: 'serialized',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setSequential: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => {
        throw new Error('getMetaIssue should not be called for invalid sequential');
      },
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
  });
});

test('consumeCommandsFile: set-automerge は CAS 一致なら setAutomerge を呼ぶ', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'automerge-apply',
      taskId: 65,
      action: 'set-automerge',
      expected: 'manual',
      to: 'automerge',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setAutomerge: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:ready' }],
      }),
    });

    assert.deepEqual(calls, [[65, 'automerge']]);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 1, skipped: 0 });
  });
});

test('consumeCommandsFile: set-automerge は CAS 不一致なら適用しない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'automerge-cas-mismatch',
      taskId: 66,
      action: 'set-automerge',
      expected: 'manual',
      to: 'automerge',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setAutomerge: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'automerge' }],
      }),
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
  });
});

test('consumeCommandsFile: set-automerge は不正値を拒否してメタ issue を読まない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'automerge-invalid',
      taskId: 67,
      action: 'set-automerge',
      expected: 'manual',
      to: 'enabled',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setAutomerge: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => {
        throw new Error('getMetaIssue should not be called for invalid automerge');
      },
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
  });
});

test('consumeCommandsFile: set-automerge は設定変更後のラベル名で CAS 判定する', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'automerge-renamed-label',
      taskId: 68,
      action: 'set-automerge',
      expected: 'auto-merge-ok',
      to: 'manual',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      labelsConfig: { automerge: 'auto-merge-ok' },
      github: {
        setAutomerge: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:ready' }, { name: 'auto-merge-ok' }],
      }),
    });

    assert.deepEqual(calls, [[68, 'manual']]);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 1, skipped: 0 });
  });
});

test('consumeCommandsFile: apply-batch は全 op 一致時に優先度、直列指定、自動マージ、ステータスの順で適用する', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'batch-all-match',
      taskId: 57,
      action: 'apply-batch',
      ops: [
        { action: 'set-status', expected: 'ready', to: 'awaiting-approval' },
        { action: 'set-sequential', expected: 'parallel', to: 'sequential' },
        { action: 'set-automerge', expected: 'manual', to: 'automerge' },
        { action: 'set-priority', expected: 'medium', to: 'high' },
      ],
      requestedAt: '2026-07-22T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setPriority: async (...args) => calls.push(['setPriority', ...args]),
        setSequential: async (...args) => calls.push(['setSequential', ...args]),
        setAutomerge: async (...args) => calls.push(['setAutomerge', ...args]),
        setStatus: async (...args) => calls.push(['setStatus', ...args]),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:ready' }, { name: 'priority:medium' }],
      }),
    });

    assert.deepEqual(calls, [
      ['setPriority', 57, 'high'],
      ['setSequential', 57, 'sequential'],
      ['setAutomerge', 57, 'automerge'],
      ['setStatus', 57, 'status:awaiting-approval'],
    ]);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 1, skipped: 0 });
  });
});

test('consumeCommandsFile: apply-batch は単一スナップショットだけで全 op を判定する', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'batch-single-snapshot',
      taskId: 58,
      action: 'apply-batch',
      ops: [
        { action: 'set-priority', expected: 'medium', to: 'high' },
        { action: 'set-sequential', expected: 'parallel', to: 'sequential' },
        { action: 'set-status', expected: 'ready', to: 'awaiting-approval' },
      ],
      requestedAt: '2026-07-22T00:00:00.000Z',
    }]);

    let getCalls = 0;
    await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setPriority: async () => {},
        setSequential: async () => {},
        setStatus: async () => {},
      },
      getMetaIssue: async () => {
        getCalls += 1;
        return { labels: [{ name: 'status:ready' }, { name: 'priority:medium' }] };
      },
    });

    assert.equal(getCalls, 1);
  });
});

test('consumeCommandsFile: apply-batch は一部 CAS 不一致なら全 op を破棄してカーソルを進める', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'batch-cas-mismatch',
      taskId: 59,
      action: 'apply-batch',
      ops: [
        { action: 'set-priority', expected: 'medium', to: 'high' },
        { action: 'set-automerge', expected: 'manual', to: 'automerge' },
        { action: 'set-sequential', expected: 'parallel', to: 'sequential' },
        { action: 'set-status', expected: 'ready', to: 'awaiting-approval' },
      ],
      requestedAt: '2026-07-22T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setPriority: async (...args) => calls.push(['setPriority', ...args]),
        setSequential: async (...args) => calls.push(['setSequential', ...args]),
        setAutomerge: async (...args) => calls.push(['setAutomerge', ...args]),
        setStatus: async (...args) => calls.push(['setStatus', ...args]),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:ready' }, { name: 'priority:low' }],
      }),
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
    assert.equal(JSON.parse(readFileSync(processedPath, 'utf8')).consumedLines, 1);
  });
});

test('consumeCommandsFile: apply-batch は同一 id を二重適用しない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    const command = {
      id: 'batch-idempotent',
      taskId: 60,
      action: 'apply-batch',
      ops: [
        { action: 'set-priority', expected: 'medium', to: 'high' },
        { action: 'set-sequential', expected: 'parallel', to: 'sequential' },
        { action: 'set-status', expected: 'ready', to: 'awaiting-approval' },
      ],
      requestedAt: '2026-07-22T00:00:00.000Z',
    };
    writeCommands(commandsPath, [command, command]);

    const calls = [];
    await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setPriority: async (...args) => calls.push(['setPriority', ...args]),
        setSequential: async (...args) => calls.push(['setSequential', ...args]),
        setStatus: async (...args) => calls.push(['setStatus', ...args]),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:ready' }, { name: 'priority:medium' }],
      }),
    });

    assert.deepEqual(calls, [
      ['setPriority', 60, 'high'],
      ['setSequential', 60, 'sequential'],
      ['setStatus', 60, 'status:awaiting-approval'],
    ]);
  });
});

test('consumeCommandsFile: apply-batch は一時失敗後のリトライで適用済み op を飛ばして収束する', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'batch-transient-converges',
      taskId: 61,
      action: 'apply-batch',
      ops: [
        { action: 'set-priority', expected: 'medium', to: 'high' },
        { action: 'set-sequential', expected: 'parallel', to: 'sequential' },
        { action: 'set-status', expected: 'ready', to: 'awaiting-approval' },
      ],
      requestedAt: '2026-07-22T00:00:00.000Z',
    }]);

    const calls = [];
    let getCalls = 0;
    let sequentialAttempts = 0;
    const common = {
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setPriority: async (...args) => calls.push(['setPriority', ...args]),
        setSequential: async (...args) => {
          calls.push(['setSequential', ...args]);
          sequentialAttempts += 1;
          if (sequentialAttempts === 1) throw httpError(500, 'temporary failure');
        },
        setStatus: async (...args) => calls.push(['setStatus', ...args]),
      },
      getMetaIssue: async () => {
        getCalls += 1;
        return getCalls === 1
          ? { labels: [{ name: 'status:ready' }, { name: 'priority:medium' }] }
          : { labels: [{ name: 'status:ready' }, { name: 'priority:high' }] };
      },
    };

    const first = await consumeCommandsFile(common);
    const second = await consumeCommandsFile(common);

    assert.deepEqual(first, { read: 1, evaluated: 0, applied: 0, skipped: 0 });
    assert.deepEqual(second, { read: 1, evaluated: 1, applied: 1, skipped: 0 });
    assert.deepEqual(calls, [
      ['setPriority', 61, 'high'],
      ['setSequential', 61, 'sequential'],
      ['setSequential', 61, 'sequential'],
      ['setStatus', 61, 'status:awaiting-approval'],
    ]);
  });
});

test('consumeCommandsFile: apply-batch は不正 batch を API 取得前に拒否する', async (t) => {
  const cases = [
    ['ops-missing', { ops: undefined }],
    ['ops-empty', { ops: [] }],
    ['duplicate-field', {
      ops: [
        { action: 'set-priority', expected: 'medium', to: 'high' },
        { action: 'set-priority', expected: 'low', to: 'medium' },
      ],
    }],
    ['unknown-op-action', {
      ops: [{ action: 'set-label', expected: 'old', to: 'new' }],
    }],
    ['disallowed-transition', {
      ops: [{ action: 'set-status', expected: 'in-progress', to: 'done' }],
    }],
  ];

  for (const [name, patch] of cases) {
    await t.test(name, async () => {
      await withTmpDir(async (dir) => {
        const commandsPath = join(dir, 'commands.jsonl');
        const processedPath = join(dir, 'commands-processed.json');
        const command = {
          id: `batch-invalid-${name}`,
          taskId: 62,
          action: 'apply-batch',
          requestedAt: '2026-07-22T00:00:00.000Z',
        };
        if ('ops' in patch) command.ops = patch.ops;
        writeCommands(commandsPath, [command]);

        const calls = [];
        const summary = await consumeCommandsFile({
          commandsPath,
          processedPath,
          logger: silentLogger(),
          github: {
            setPriority: async (...args) => calls.push(['setPriority', ...args]),
            setSequential: async (...args) => calls.push(['setSequential', ...args]),
            setStatus: async (...args) => calls.push(['setStatus', ...args]),
          },
          getMetaIssue: async () => {
            throw new Error('getMetaIssue should not be called for invalid batch');
          },
        });

        assert.deepEqual(calls, []);
        assert.equal(summary.read, 1);
        assert.equal(summary.applied, 0);
        assert.equal(JSON.parse(readFileSync(processedPath, 'utf8')).consumedLines, 1);
      });
    });
  }
});

test('processApplyBatchCommand: apply-batch はプロトタイプチェーン由来 action を invalid-batch で拒否する', async () => {
  const githubCalls = [];
  let getMetaIssueCalls = 0;
  const result = await processApplyBatchCommand({
    id: 'batch-prototype-action',
    taskId: 64,
    action: 'apply-batch',
    ops: [
      { action: 'set-priority', expected: 'medium', to: 'high' },
      { action: '__proto__', expected: 'parallel', to: 'sequential' },
    ],
    requestedAt: '2026-07-22T00:00:00.000Z',
  }, {
    logger: silentLogger(),
    github: {
      setPriority: async (...args) => githubCalls.push(['setPriority', ...args]),
      setSequential: async (...args) => githubCalls.push(['setSequential', ...args]),
      setStatus: async (...args) => githubCalls.push(['setStatus', ...args]),
    },
    getMetaIssue: async () => {
      getMetaIssueCalls += 1;
      return { labels: [{ name: 'status:ready' }, { name: 'priority:medium' }] };
    },
  });

  assert.deepEqual(result, {
    evaluated: true,
    applied: false,
    reason: 'invalid-batch',
    id: 'batch-prototype-action',
  });
  assert.deepEqual(githubCalls, []);
  assert.equal(getMetaIssueCalls, 0);
});

test('consumeCommandsFile: apply-batch は waiting-merge→done のリトライで setStatus を二重に呼ばない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'batch-done-comment-once',
      taskId: 63,
      action: 'apply-batch',
      ops: [
        { action: 'set-status', expected: 'waiting-merge', to: 'done' },
      ],
      requestedAt: '2026-07-22T00:00:00.000Z',
    }]);

    const calls = [];
    let getCalls = 0;
    let statusAttempts = 0;
    const common = {
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setStatus: async (...args) => {
          calls.push(args);
          statusAttempts += 1;
          if (statusAttempts === 1) throw httpError(500, 'post-side-effect failure');
        },
      },
      getMetaIssue: async () => {
        getCalls += 1;
        return getCalls === 1
          ? { labels: [{ name: 'status:waiting-merge' }] }
          : { labels: [{ name: 'status:done' }] };
      },
    };

    await consumeCommandsFile(common);
    const second = await consumeCommandsFile(common);

    assert.deepEqual(calls, [[63, 'status:done']]);
    assert.deepEqual(second, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
    assert.equal(JSON.parse(readFileSync(processedPath, 'utf8')).consumedLines, 1);
  });
});

test('consumeCommandsFile: 許可外遷移は拒否して setStatus を呼ばない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'cmd-3',
      taskId: 44,
      action: 'set-status',
      expected: 'in-progress',
      to: 'done',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setStatus: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => {
        throw new Error('CAS should not run for disallowed transitions');
      },
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
  });
});

test('consumeCommandsFile: 未対応 action は consumed 扱いで無視する', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'unsupported',
      taskId: 49,
      action: 'set-label',
      expected: 'old',
      to: 'new',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setStatus: async () => {
          throw new Error('setStatus should not be called for unsupported action');
        },
      },
      getMetaIssue: async () => {
        throw new Error('getMetaIssue should not be called for unsupported action');
      },
    });

    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
    assert.equal(JSON.parse(readFileSync(processedPath, 'utf8')).consumedLines, 1);
  });
});

test('createCommandsFileProcessor: 同じ id は同一実行内でも再起動相当でも二重適用しない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [
      {
        id: 'cmd-4',
        taskId: '45',
        action: 'set-status',
        expected: 'failed',
        to: 'ready',
        requestedAt: '2026-07-18T00:00:00.000Z',
      },
      {
        id: 'cmd-4',
        taskId: '45',
        action: 'set-status',
        expected: 'failed',
        to: 'ready',
        requestedAt: '2026-07-18T00:00:00.000Z',
      },
    ]);

    const calls = [];
    const common = {
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setStatus: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:failed' }],
      }),
    };

    await createCommandsFileProcessor(common).consumeOnce();
    await createCommandsFileProcessor(common).consumeOnce();

    assert.deepEqual(calls, [[45, 'status:ready']]);
  });
});

test('startCommandsFileWatcher: watch 起点の消化後に summary 付きで afterConsume を呼ぶ', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    mkdirSync(dirname(commandsPath), { recursive: true });
    writeFileSync(commandsPath, '');

    const summary = { read: 1, evaluated: 1, applied: 1, skipped: 0 };
    const afterConsumeCalls = [];
    let consumeCalls = 0;
    const watcher = startCommandsFileWatcher(
      {
        consumeOnce: async () => {
          consumeCalls += 1;
          return summary;
        },
      },
      {
        commandsPath,
        debounceMs: 10,
        logger: silentLogger(),
        afterConsume: async (result) => {
          afterConsumeCalls.push(result);
        },
      }
    );

    let writes = 0;
    const writeInterval = setInterval(() => {
      writes += 1;
      writeFileSync(commandsPath, JSON.stringify({ id: `watch-trigger-${writes}` }) + '\n');
    }, 20);
    try {
      await waitFor(() => afterConsumeCalls.length >= 1);
    } finally {
      clearInterval(writeInterval);
      watcher.close();
    }

    assert.ok(consumeCalls >= 1);
    assert.deepEqual(afterConsumeCalls[0], summary);
  });
});

test('consumeCommandsFile: 恒久失敗 4xx は隔離して 2 回目に再試行しない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const statePath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'poison-404',
      taskId: 404,
      action: 'set-status',
      expected: 'failed',
      to: 'ready',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const { entries, logger } = captureLogger();
    let getCalls = 0;
    const setCalls = [];
    const common = {
      commandsPath,
      processedPath: statePath,
      logger,
      github: {
        setStatus: async (...args) => setCalls.push(args),
      },
      getMetaIssue: async () => {
        getCalls += 1;
        throw httpError(404, 'not found');
      },
    };

    await consumeCommandsFile(common);
    await consumeCommandsFile(common);

    assert.equal(getCalls, 1);
    assert.deepEqual(setCalls, []);
    assert.equal(entries.warn.length, 1);
    assert.match(entries.warn[0], /恒久失敗/);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).consumedLines, 1);
  });
});

test('consumeCommandsFile: 一時失敗 5xx は上限までリトライし超過後に隔離する', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const statePath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'poison-500',
      taskId: 500,
      action: 'set-status',
      expected: 'failed',
      to: 'ready',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const { logger } = captureLogger();
    let getCalls = 0;
    const common = {
      commandsPath,
      processedPath: statePath,
      logger,
      transientRetryLimit: 2,
      github: {
        setStatus: async () => {
          throw new Error('setStatus should not be called');
        },
      },
      getMetaIssue: async () => {
        getCalls += 1;
        throw httpError(500, 'server\nfailed');
      },
    };

    await consumeCommandsFile(common);
    await consumeCommandsFile(common);
    await consumeCommandsFile(common);
    await consumeCommandsFile(common);

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(getCalls, 3);
    assert.equal(state.consumedLines, 1);
    assert.equal(state.retry, null);
  });
});

test('consumeCommandsFile: 403 は一時失敗として上限超過までリトライする', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const statePath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'secondary-rate-limit-403',
      taskId: 403,
      action: 'set-status',
      expected: 'failed',
      to: 'ready',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const { entries, logger } = captureLogger();
    let getCalls = 0;
    const common = {
      commandsPath,
      processedPath: statePath,
      logger,
      transientRetryLimit: 2,
      github: {
        setStatus: async () => {
          throw new Error('setStatus should not be called');
        },
      },
      getMetaIssue: async () => {
        getCalls += 1;
        throw httpError(403, 'secondary rate limit');
      },
    };

    await consumeCommandsFile(common);

    const firstState = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(getCalls, 1);
    assert.equal(firstState.consumedLines, 0);
    assert.equal(firstState.retry?.lineNumber, 1);
    assert.equal(firstState.retry?.attempts, 1);
    assert.doesNotMatch(entries.warn[0], /恒久失敗/);

    await consumeCommandsFile(common);
    await consumeCommandsFile(common);
    await consumeCommandsFile(common);

    const finalState = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(getCalls, 3);
    assert.equal(finalState.consumedLines, 1);
    assert.equal(finalState.retry, null);
  });
});

test('consumeCommandsFile: 不良行は 2 回目に再 warn / 再評価しない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const statePath = join(dir, 'commands-processed.json');
    mkdirSync(dirname(commandsPath), { recursive: true });
    writeFileSync(
      commandsPath,
      '{"id":"bad-json",\n' +
        JSON.stringify({ id: 'missing-keys', taskId: 46 }) + '\n'
    );

    const { entries, logger } = captureLogger();
    let getCalls = 0;
    const common = {
      commandsPath,
      processedPath: statePath,
      logger,
      github: { setStatus: async () => {} },
      getMetaIssue: async () => {
        getCalls += 1;
        throw new Error('getMetaIssue should not be called');
      },
    };

    await consumeCommandsFile(common);
    await consumeCommandsFile(common);

    assert.equal(getCalls, 0);
    assert.equal(entries.warn.length, 2);
    assert.match(entries.warn[0], /JSON パースに失敗/);
    assert.match(entries.warn[1], /必須キーが不足/);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).consumedLines, 2);
  });
});

test('consumeCommandsFile: 永続状態を読み直す再起動相当でも確定済み行を再適用しない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'restart-safe',
      taskId: 47,
      action: 'set-status',
      expected: 'failed',
      to: 'ready',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setStatus: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:failed' }],
      }),
    });

    await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setStatus: async () => {
          throw new Error('setStatus should not be called after restart');
        },
      },
      getMetaIssue: async () => {
        throw new Error('getMetaIssue should not be called after restart');
      },
    });

    assert.deepEqual(calls, [[47, 'status:ready']]);
  });
});

test('consumeCommandsFile: 行カーソルを進め、不完全な末尾行は次回へ残す', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const statePath = join(dir, 'commands-processed.json');
    const complete = {
      id: 'complete-line',
      taskId: 48,
      action: 'set-status',
      expected: 'failed',
      to: 'ready',
      requestedAt: '2026-07-18T00:00:00.000Z',
    };
    mkdirSync(dirname(commandsPath), { recursive: true });
    writeFileSync(commandsPath, JSON.stringify(complete) + '\n{"id":"incomplete"');

    const calls = [];
    await consumeCommandsFile({
      commandsPath,
      processedPath: statePath,
      logger: silentLogger(),
      github: {
        setStatus: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:failed' }],
      }),
    });

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.deepEqual(calls, [[48, 'status:ready']]);
    assert.equal(state.consumedLines, 1);
    assert.equal(readFileSync(commandsPath, 'utf8'), JSON.stringify(complete) + '\n{"id":"incomplete"');
  });
});
