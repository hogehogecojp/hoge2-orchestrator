import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

async function makeTempDir() {
  return fs.mkdtemp(join(tmpdir(), 'vk-orchestrator-lock-'));
}

// 「所有者限定 mode」は POSIX の権限ビットの話で、Windows には対応する概念が無い。
// Windows のアクセス制御は ACL が担い、Node の mode 引数はほぼ無視されるため、
// stat().mode は常に 0o666 / 0o777 相当を返す（実装が正しくても 0o600 にはならない）。
// そこで **mode の検証だけ** を POSIX 限定にし、作成されたこと自体は全 OS で検証する。
const POSIX_MODES = process.platform !== 'win32';

describe('start lock', () => {
  it('同時取得では片方だけがロック作成に成功する', async () => {
    const { createStartLock } = await import('../src/engine/start-lock.js');
    const dir = await makeTempDir();
    const lockFile = join(dir, 'orchestrator.lock');
    const alivePids = new Set([111, 222]);
    const makeProcess = (pid) => ({
      pid,
      kill(targetPid, signal) {
        assert.equal(signal, 0);
        if (alivePids.has(targetPid)) return true;
        const err = new Error('not found');
        err.code = 'ESRCH';
        throw err;
      },
    });
    const lockA = createStartLock({
      lockFile,
      process: makeProcess(111),
      now: () => new Date('2026-07-10T01:00:00.000Z'),
    });
    const lockB = createStartLock({
      lockFile,
      process: makeProcess(222),
      now: () => new Date('2026-07-10T01:00:00.000Z'),
    });

    const results = await Promise.allSettled([lockA.acquire(), lockB.acquire()]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.match(
      results.find((result) => result.status === 'rejected').reason.message,
      /既に起動中/
    );

    const record = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    assert.ok(alivePids.has(record.pid));

    await lockA.release();
    await lockB.release();
  });

  it('生存中 PID のロックがある場合は起動を中止するエラーにする', async () => {
    const { createStartLock } = await import('../src/engine/start-lock.js');
    const dir = await makeTempDir();
    const lockFile = join(dir, 'orchestrator.lock');
    await fs.writeFile(lockFile, JSON.stringify({ pid: 111, startedAt: '2026-07-10T00:00:00.000Z' }), 'utf8');

    const lock = createStartLock({
      lockFile,
      process: {
        pid: 222,
        kill(pid, signal) {
          assert.equal(pid, 111);
          assert.equal(signal, 0);
          return true;
        },
      },
      now: () => new Date('2026-07-10T01:00:00.000Z'),
    });

    await assert.rejects(() => lock.acquire(), /既に起動中.*pid=111/);
    assert.equal(
      await fs.readFile(lockFile, 'utf8'),
      JSON.stringify({ pid: 111, startedAt: '2026-07-10T00:00:00.000Z' }),
      '生存中ロックは上書きしない'
    );
  });

  it('stale lock は奪取して release で削除する', async () => {
    const { createStartLock } = await import('../src/engine/start-lock.js');
    const dir = await makeTempDir();
    const lockFile = join(dir, 'orchestrator.lock');
    await fs.writeFile(lockFile, JSON.stringify({ pid: 111, startedAt: '2026-07-10T00:00:00.000Z' }), 'utf8');

    const lock = createStartLock({
      lockFile,
      process: {
        pid: 222,
        kill() {
          const err = new Error('not found');
          err.code = 'ESRCH';
          throw err;
        },
      },
      now: () => new Date('2026-07-10T01:00:00.000Z'),
    });

    const result = await lock.acquire();
    assert.deepEqual(result, { acquired: true, stale: true, previousPid: 111 });
    assert.deepEqual(JSON.parse(await fs.readFile(lockFile, 'utf8')), {
      pid: 222,
      startedAt: '2026-07-10T01:00:00.000Z',
    });

    await lock.release();
    await assert.rejects(() => fs.readFile(lockFile, 'utf8'), /ENOENT/);
  });

  it('stale 判定後に差し替わったロックは削除せず取得に失敗する', async () => {
    const { createStartLock } = await import('../src/engine/start-lock.js');
    const staleRecord = { pid: 111, startedAt: '2026-07-10T00:00:00.000Z' };
    const liveRecord = { pid: 333, startedAt: '2026-07-10T00:00:01.000Z' };
    const lockFile = '/tmp/orchestrator.lock';
    let lockText = JSON.stringify(staleRecord);
    let readCount = 0;
    let unlinkCalled = false;

    const lock = createStartLock({
      lockFile,
      fs: {
        async mkdir() {},
        async writeFile() {
          const err = new Error('exists');
          err.code = 'EEXIST';
          throw err;
        },
        async readFile() {
          readCount += 1;
          const result = lockText;
          if (readCount === 1) {
            lockText = JSON.stringify(liveRecord);
          }
          return result;
        },
        async unlink() {
          unlinkCalled = true;
        },
      },
      process: {
        pid: 222,
        kill(pid, signal) {
          assert.equal(pid, staleRecord.pid);
          assert.equal(signal, 0);
          const err = new Error('not found');
          err.code = 'ESRCH';
          throw err;
        },
      },
      now: () => new Date('2026-07-10T01:00:00.000Z'),
      logger: { warn() {} },
    });

    await assert.rejects(() => lock.acquire(), /既に起動中.*pid=333/);
    assert.equal(readCount, 2);
    assert.equal(unlinkCalled, false);
    assert.equal(lockText, JSON.stringify(liveRecord));
  });

  it('不正な pid の lock は process.kill せず stale として奪取する', async () => {
    const { createStartLock } = await import('../src/engine/start-lock.js');
    const invalidPids = [-1, 1.5, '111'];

    for (const invalidPid of invalidPids) {
      const dir = await makeTempDir();
      const lockFile = join(dir, 'orchestrator.lock');
      await fs.writeFile(lockFile, JSON.stringify({ pid: invalidPid, startedAt: '2026-07-10T00:00:00.000Z' }), 'utf8');
      const killCalls = [];

      const lock = createStartLock({
        lockFile,
        process: {
          pid: 222,
          kill(pid, signal) {
            killCalls.push([pid, signal]);
            return true;
          },
        },
        now: () => new Date('2026-07-10T01:00:00.000Z'),
      });

      const result = await lock.acquire();
      assert.deepEqual(result, { acquired: true, stale: true, previousPid: invalidPid });
      assert.deepEqual(killCalls, []);
      assert.deepEqual(JSON.parse(await fs.readFile(lockFile, 'utf8')), {
        pid: 222,
        startedAt: '2026-07-10T01:00:00.000Z',
      });
    }
  });

  it('新規ロックファイルと親ディレクトリを所有者限定 mode で作成する', async () => {
    const { createStartLock } = await import('../src/engine/start-lock.js');
    const dir = await makeTempDir();
    const lockDir = join(dir, 'locks');
    const lockFile = join(lockDir, 'orchestrator.lock');

    const lock = createStartLock({
      lockFile,
      process: {
        pid: 222,
        kill() {
          return true;
        },
      },
      now: () => new Date('2026-07-10T01:00:00.000Z'),
    });

    await lock.acquire();

    // 全 OS 共通: 親ディレクトリごと作られること。
    assert.ok((await fs.stat(lockDir)).isDirectory(), 'ロックの親ディレクトリが作られること');
    assert.ok((await fs.stat(lockFile)).isFile(), 'ロックファイルが作られること');

    // mode の検証は POSIX 限定。理由は POSIX_MODES の定義箇所を参照。
    if (POSIX_MODES) {
      assert.equal((await fs.stat(lockDir)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(lockFile)).mode & 0o777, 0o600);
    }
  });
});
