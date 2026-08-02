import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

async function makeTempDir() {
  return fs.mkdtemp(join(tmpdir(), 'vk-orchestrator-logger-'));
}

// 「所有者限定 mode」は POSIX の権限ビットの話で、Windows には対応する概念が無い。
// Windows のアクセス制御は ACL が担い、Node の mode 引数はほぼ無視されるため、
// stat().mode は常に 0o666 / 0o777 相当を返す（実装が正しくても 0o600 にはならない）。
// そこで **mode の検証だけ** を POSIX 限定にし、作成されたこと自体は全 OS で検証する
// （テストごと skip すると、Windows ではファイルが作られない退行を拾えなくなる）。
const POSIX_MODES = process.platform !== 'win32';

describe('persistent logger', () => {
  it('console 出力を維持しつつ、ISO 時刻付き・秘匿情報マスク済みの行をファイルへ追記する', async () => {
    const { createPersistentLogger } = await import('../src/engine/persistent-logger.js');
    const dir = await makeTempDir();
    const logFile = join(dir, 'orchestrator.log');
    const consoleCalls = [];

    const logger = createPersistentLogger({
      logFile,
      console: {
        log: (...args) => consoleCalls.push(['log', args]),
        warn: (...args) => consoleCalls.push(['warn', args]),
        error: (...args) => consoleCalls.push(['error', args]),
      },
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    logger.log('token', 'ghp_abcdefghijklmnopqrstuvwxyz123456');

    assert.deepEqual(consoleCalls, [['log', ['token', 'ghp_abcdefghijklmnopqrstuvwxyz123456']]]);
    const text = await fs.readFile(logFile, 'utf8');
    assert.match(text, /^\[2026-07-10T00:00:00\.000Z\] \[log\] token \*\*\*REDACTED\*\*\*$/m);
    assert.doesNotMatch(text, /ghp_abcdefghijklmnopqrstuvwxyz123456/);
  });

  it('最大サイズを超えた既存ログを .1 へ退避してから新しい行を書き込む', async () => {
    const { createPersistentLogger } = await import('../src/engine/persistent-logger.js');
    const dir = await makeTempDir();
    const logFile = join(dir, 'orchestrator.log');
    await fs.writeFile(logFile, 'x'.repeat(20), 'utf8');

    const logger = createPersistentLogger({
      logFile,
      maxBytes: 10,
      console: { log() {}, warn() {}, error() {} },
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    logger.warn('rotated');

    assert.equal(await fs.readFile(`${logFile}.1`, 'utf8'), 'x'.repeat(20));
    const text = await fs.readFile(logFile, 'utf8');
    assert.match(text, /\[warn\] rotated/);
  });

  it('新規ログファイルと親ディレクトリを所有者限定 mode で作成する', async () => {
    const { createPersistentLogger } = await import('../src/engine/persistent-logger.js');
    const dir = await makeTempDir();
    const logDir = join(dir, 'logs');
    const logFile = join(logDir, 'orchestrator.log');

    const logger = createPersistentLogger({
      logFile,
      console: { log() {}, warn() {}, error() {} },
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    logger.log('created');

    // 全 OS 共通: 親ディレクトリごと作られること。
    assert.ok((await fs.stat(logDir)).isDirectory(), 'ログの親ディレクトリが作られること');
    assert.ok((await fs.stat(logFile)).isFile(), 'ログファイルが作られること');

    if (POSIX_MODES) {
      assert.equal((await fs.stat(logDir)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(logFile)).mode & 0o777, 0o600);
    }
  });
});
