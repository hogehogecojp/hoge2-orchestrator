/**
 * アップデート実行側（副作用あり）のユニットテスト。
 *
 * ファイルの入れ替えは本物の一時ディレクトリ（mkdtempSync）で検証し、
 * ネットワークは global.fetch を差し替えて検証する。両者は同じテストに混ぜない
 * （どちらの理由で落ちたのか分からなくなるため）。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  MAX_DOWNLOAD_BYTES,
  UPDATE_LOCK_MAX_AGE_MS,
  acquireUpdateLock,
  carryOverVkTerminals,
  checkUrlAllowed,
  copyPreservedAssets,
  detectUpdateChannel,
  downloadZip,
  evaluateBundledDependencies,
  executeSwapSteps,
  extractZip,
  fetchUpdateManifest,
  isStagingDirInUse,
  isStartLockHeld,
  isUpdateLockHeld,
  readBodyWithLimit,
  readInstalledVersion,
  readUpdateState,
  pruneStaleStagingDirs,
  recoverPendingUpdate,
  refreshSnapshotAfterUpdate,
  saveUpdateSnapshot,
  updateLockPathFor,
  validateApplyArguments,
  verifyStagedIdentity,
  writeUpdateState,
  zipExtractCommands,
} from '../src/engine/update-runner.js';
import { STAGE_TARGET_FILENAME, backupDirFor, planSwap } from '../src/engine/update-apply.js';

// ---------------------------------------------------------------------------
// ファイル操作（本物の一時ディレクトリ）
// ---------------------------------------------------------------------------

let work;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'vk-orchestrator-update-test-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** インストールディレクトリ相当のダミーを作る。 */
function makeInstall(dir, version, files = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'vk-orchestrator', version }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe('入れ替えの実行（rename 2 回）', () => {
  it('作業記録 → 控えへ rename → 展開先を rename の順に実行される', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.4.2');
    const staged = makeInstall(join(work, '.vk-orchestrator-staging-1.5.0'), '1.5.0');
    const journal = join(work, 'state', 'update-state.json');
    const backup = backupDirFor(install, '1.4.2');

    executeSwapSteps(
      planSwap({
        installDir: install,
        stagedDir: staged,
        sameDevice: true,
        backupPath: backup,
        journalPath: journal,
        from: '1.4.2',
        to: '1.5.0',
        argv: ['up'],
      })
    );

    assert.equal(readInstalledVersion(install), '1.5.0', '新しい版が install に入る');
    assert.equal(readInstalledVersion(backup), '1.4.2', '旧版は控えとして残る');
    assert.equal(existsSync(staged), false, '展開先は残らない');
    assert.equal(JSON.parse(readFileSync(journal, 'utf8')).phase, 'completed');
  });

  it('コピー経路でも新しい版が入り、展開先が片付く', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.4.2');
    const staged = makeInstall(join(work, 'elsewhere', 'staging'), '1.5.0');
    const journal = join(work, 'state', 'update-state.json');
    const backup = backupDirFor(install, '1.4.2');

    executeSwapSteps(
      planSwap({
        installDir: install,
        stagedDir: staged,
        sameDevice: false,
        backupPath: backup,
        journalPath: journal,
      })
    );

    assert.equal(readInstalledVersion(install), '1.5.0');
    assert.equal(existsSync(staged), false);
  });
});

describe('利用者の資産の引き継ぎ', () => {
  it('存在するものだけを展開先へ写す', () => {
    const install = makeInstall(join(work, 'install'), '1.4.2', {
      '.env': 'GITHUB_TOKEN=dummy\n',
      'config.json': '{"queue":{"backend":"local"}}',
      'vendor/vk-agents-public/config.json': '{"org":{"allowed_owners":["vektor-inc"]}}',
      'orchestrator.log': 'ログは引き継がない',
    });
    mkdirSync(join(install, 'node_modules'), { recursive: true });
    const staged = makeInstall(join(work, 'staged'), '1.5.0');

    const { preserved } = copyPreservedAssets(install, staged);

    assert.deepEqual(preserved.sort(), ['.env', 'config.json', 'vendor/vk-agents-public/config.json']);
    assert.equal(readFileSync(join(staged, '.env'), 'utf8'), 'GITHUB_TOKEN=dummy\n');
    assert.equal(existsSync(join(staged, 'orchestrator.log')), false, 'ログは写さない');
    assert.equal(existsSync(join(staged, 'node_modules')), false, 'node_modules は写さない');
    assert.equal(existsSync(join(staged, '.claude', 'settings.local.json')), false, '無いものは作らない');
  });

  it('シンボリックリンクは引き継がず理由を返す', () => {
    const install = makeInstall(join(work, 'install'), '1.4.2', { 'config.json': '{}' });
    writeFileSync(join(work, 'outside.env'), 'SECRET=1');
    symlinkSync(join(work, 'outside.env'), join(install, '.env'));
    const staged = makeInstall(join(work, 'staged'), '1.5.0');

    const { preserved, rejected } = copyPreservedAssets(install, staged);

    assert.deepEqual(preserved, ['config.json']);
    assert.deepEqual(rejected, [{ path: '.env', reason: 'symlink' }]);
    assert.equal(existsSync(join(staged, '.env')), false);
  });
});

describe('同梱依存関係の信頼判定（npm ci は例外時だけ）', () => {
  const LOCK = 'lockfile content\n';
  const LOCK_SHA = createHash('sha256').update(LOCK).digest('hex');

  function makeStaged({ withNodeModules = true, lock = LOCK } = {}) {
    const staged = makeInstall(join(work, 'staged'), '1.5.0', { 'package-lock.json': lock });
    if (withNodeModules) mkdirSync(join(staged, 'node_modules'), { recursive: true });
    return staged;
  }

  it('node_modules があり lock の sha256 も一致すれば同梱をそのまま信頼する（オフラインでも完結する）', () => {
    assert.deepEqual(evaluateBundledDependencies(makeStaged(), LOCK_SHA), {
      trusted: true,
      reason: 'bundled',
    });
  });

  it('node_modules が入っていなければ信頼しない', () => {
    assert.deepEqual(evaluateBundledDependencies(makeStaged({ withNodeModules: false }), LOCK_SHA), {
      trusted: false,
      reason: 'node-modules-missing',
    });
  });

  it('lock の sha256 が一致しなければ信頼しない', () => {
    assert.deepEqual(evaluateBundledDependencies(makeStaged({ lock: 'tampered\n' }), LOCK_SHA), {
      trusted: false,
      reason: 'lock-sha256-mismatch',
    });
  });

  it('照合材料が無いだけなら同梱を信頼する', () => {
    assert.deepEqual(evaluateBundledDependencies(makeStaged(), null), {
      trusted: true,
      reason: 'lock-sha256-unknown',
    });
  });
});

describe('導入済み GUI（vk-terminals）の引き継ぎ', () => {
  function makeInstallWithGui(version) {
    const install = makeInstall(join(work, 'install'), '1.4.2');
    const gui = join(install, 'node_modules', 'vk-terminals');
    mkdirSync(gui, { recursive: true });
    writeFileSync(join(gui, 'package.json'), JSON.stringify({ name: 'vk-terminals', version }));
    return install;
  }

  it('同梱が示す版と一致していれば引き継ぐ（再ビルドを省く）', () => {
    const install = makeInstallWithGui('1.48.0');
    const staged = makeInstall(join(work, 'staged'), '1.5.0');
    assert.deepEqual(carryOverVkTerminals({ installDir: install, stagedDir: staged, bundledVersion: '1.48.0' }), {
      moved: true,
      reason: 'version-match',
    });
    assert.equal(existsSync(join(staged, 'node_modules', 'vk-terminals', 'package.json')), true);
  });

  it('版が違えば引き継がない（入れ替え後の追従処理に任せる）', () => {
    const install = makeInstallWithGui('1.40.0');
    const staged = makeInstall(join(work, 'staged'), '1.5.0');
    assert.deepEqual(carryOverVkTerminals({ installDir: install, stagedDir: staged, bundledVersion: '1.48.0' }), {
      moved: false,
      reason: 'version-mismatch',
    });
    assert.equal(existsSync(join(staged, 'node_modules', 'vk-terminals')), false);
  });

  it('未導入なら何もしない', () => {
    const install = makeInstall(join(work, 'install'), '1.4.2');
    const staged = makeInstall(join(work, 'staged'), '1.5.0');
    assert.deepEqual(carryOverVkTerminals({ installDir: install, stagedDir: staged, bundledVersion: '1.48.0' }), {
      moved: false,
      reason: 'not-installed',
    });
  });
});

describe('中断したアップデートの復旧', () => {
  const QUIET = { log() {}, warn() {} };

  // 復旧処理は毎起動の先頭で必ず走り、記録に書かれたパスを rename / 再帰削除の対象にする。
  // そのため「記録が自分自身のインストールを指していること」を渡して呼ぶ形にしている。
  const STAGING = '.vk-orchestrator-staging-1.5.0';

  it('install が無く展開先が残っていれば続きを実行する', () => {
    const install = join(work, 'vk-orchestrator');
    const staged = makeInstall(join(work, STAGING), '1.5.0');
    const statePath = join(work, 'state.json');
    // install が存在しない状態を作るため、記録上の installPath は実体解決できない。
    // 実運用でも同じ状況（rename 1 回目の直後）なので、記録の生値で比較される。
    writeUpdateState(
      { phase: 'swapping', installPath: install, stagedPath: staged, backupPath: `${install}.backup-1.4.2` },
      { statePath }
    );

    const outcome = recoverPendingUpdate({ repoRoot: install, statePath, logger: QUIET });

    assert.equal(outcome.action, 'complete');
    assert.equal(readInstalledVersion(install), '1.5.0');
    assert.equal(readUpdateState({ statePath }).phase, 'completed');
  });

  it('install が無く控えだけ残っていれば元の版へ戻す', () => {
    const install = join(work, 'vk-orchestrator');
    const backup = makeInstall(`${install}.backup-1.4.2`, '1.4.2');
    const statePath = join(work, 'state.json');
    writeUpdateState(
      { phase: 'swapping', installPath: install, stagedPath: join(work, STAGING), backupPath: backup },
      { statePath }
    );

    const outcome = recoverPendingUpdate({ repoRoot: install, statePath, logger: QUIET });

    assert.equal(outcome.action, 'revert');
    assert.equal(readInstalledVersion(install), '1.4.2');
    assert.equal(readUpdateState({ statePath }).phase, 'reverted');
  });

  it('確定していない入れ替え（install と控えの両方あり）は元の版へ戻す', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.5.0');
    const backup = makeInstall(`${install}.backup-1.4.2`, '1.4.2');
    const statePath = join(work, 'state.json');
    writeUpdateState(
      { phase: 'swapping', installPath: install, stagedPath: join(work, STAGING), backupPath: backup },
      { statePath }
    );

    const outcome = recoverPendingUpdate({ repoRoot: install, statePath, logger: QUIET });

    assert.equal(outcome.action, 'revert');
    assert.equal(readInstalledVersion(install), '1.4.2');
  });

  it('記録が無ければ何もしない', () => {
    const statePath = join(work, 'state.json');
    assert.deepEqual(
      recoverPendingUpdate({ repoRoot: join(work, 'vk-orchestrator'), statePath, logger: QUIET }),
      { action: 'none', reason: 'no-journal' }
    );
  });

  it('2 回連続で実行しても結果が変わらない（冪等）', () => {
    const install = join(work, 'vk-orchestrator');
    const staged = makeInstall(join(work, STAGING), '1.5.0');
    const statePath = join(work, 'state.json');
    writeUpdateState(
      { phase: 'swapping', installPath: install, stagedPath: staged, backupPath: `${install}.backup-1.4.2` },
      { statePath }
    );

    const first = recoverPendingUpdate({ repoRoot: install, statePath, logger: QUIET });
    const second = recoverPendingUpdate({ repoRoot: install, statePath, logger: QUIET });

    assert.equal(first.action, 'complete');
    assert.deepEqual(second, { action: 'none', reason: 'no-pending-swap' });
    assert.equal(readInstalledVersion(install), '1.5.0');
  });

  // --- ここから、記録のパスを検証していなかったことによる事故の回帰テスト -------------

  it('記録が別のインストールを指していたら何もしない（他方のディレクトリを消さない）', () => {
    // clone 側と zip 側を併用している状況。zip 側から起動したのに、記録は clone 側を指している。
    const other = makeInstall(join(work, 'other-install'), '1.4.2');
    const otherBackup = makeInstall(`${other}.backup-1.4.2`, '1.4.2');
    const self = makeInstall(join(work, 'vk-orchestrator'), '1.4.2');
    const statePath = join(work, 'state.json');
    writeUpdateState(
      { phase: 'swapping', installPath: other, stagedPath: join(work, STAGING), backupPath: otherBackup },
      { statePath }
    );

    const outcome = recoverPendingUpdate({ repoRoot: self, statePath, logger: QUIET });

    assert.equal(outcome.action, 'none');
    assert.match(outcome.reason, /journal-rejected/);
    // 巻き戻しが走っていたら other は控えの内容へ差し替わり、控えは消えていた。
    assert.equal(existsSync(other), true, '無関係なインストールを触っていない');
    assert.equal(existsSync(otherBackup), true, '無関係な控えを消していない');
    assert.equal(readUpdateState({ statePath }).phase, 'swapping', '記録は残す（本来の持ち主が使う）');
  });

  it('控えのパスが親ディレクトリを脱出していたら何もしない', () => {
    const install = makeInstall(join(work, 'nested', 'vk-orchestrator'), '1.5.0');
    const outside = makeInstall(join(work, 'outside'), '1.4.2');
    const statePath = join(work, 'state.json');
    writeUpdateState(
      { phase: 'swapping', installPath: install, stagedPath: join(work, STAGING), backupPath: outside },
      { statePath }
    );

    const outcome = recoverPendingUpdate({ repoRoot: install, statePath, logger: QUIET });

    assert.equal(outcome.action, 'none');
    assert.match(outcome.reason, /backup-path-outside/);
    assert.equal(existsSync(outside), true);
  });

  it('展開先のパスが規定の名前でなければ何もしない', () => {
    const install = join(work, 'vk-orchestrator');
    const notStaging = makeInstall(join(work, 'important-data'), '1.5.0');
    const statePath = join(work, 'state.json');
    writeUpdateState(
      { phase: 'swapping', installPath: install, stagedPath: notStaging, backupPath: `${install}.backup-1.4.2` },
      { statePath }
    );

    const outcome = recoverPendingUpdate({ repoRoot: install, statePath, logger: QUIET });

    assert.equal(outcome.action, 'none');
    assert.match(outcome.reason, /staged-path-unexpected-name/);
    assert.equal(existsSync(notStaging), true, '規定外のディレクトリを install へ rename しない');
  });

  // 復旧は入れ替えと同じ 3 つのパスを rename するため、更新処理と同じロックの下で行う。
  // ロックを取らないと、入れ替えの「2 回目の rename 済み・記録の確定前」という短い窓に
  // 復旧が入り込み、入れ替わったばかりの新版をどけて旧版へ戻してしまう
  //（更新側は成功として記録を確定するため、更新したつもりで旧版のまま残る）。
  it('更新処理が走っている最中は後始末を行わない', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.5.0');
    const backup = makeInstall(`${install}.backup-1.4.2`, '1.4.2');
    const statePath = join(work, 'state.json');
    const lockDir = join(work, 'locks');
    writeUpdateState(
      { phase: 'swapping', installPath: install, stagedPath: join(work, STAGING), backupPath: backup },
      { statePath }
    );
    // 別プロセス（生きている親）がロックを保持している状態を作る。
    const lock = acquireUpdateLock(install, { lockDir });
    assert.equal(lock.ok, true);
    writeFileSync(lock.lockFile, JSON.stringify({ pid: process.ppid }));

    const outcome = recoverPendingUpdate({
      repoRoot: install,
      statePath,
      logger: QUIET,
      lockDir,
      workDir: join(work, 'updates'),
    });

    assert.deepEqual(outcome, { action: 'none', reason: 'update-in-progress' });
    assert.equal(readInstalledVersion(install), '1.5.0', '入れ替わった新版をどけない');
    assert.equal(existsSync(backup), true, '控えを消さない');
  });

  it('ロックが空いていれば通常どおり後始末する', () => {
    const install = join(work, 'vk-orchestrator');
    const staged = makeInstall(join(work, STAGING), '1.5.0');
    const statePath = join(work, 'state.json');
    writeUpdateState(
      { phase: 'swapping', installPath: install, stagedPath: staged, backupPath: `${install}.backup-1.4.2` },
      { statePath }
    );

    const outcome = recoverPendingUpdate({
      repoRoot: install,
      statePath,
      logger: QUIET,
      lockDir: join(work, 'locks'),
      workDir: join(work, 'updates'),
    });

    assert.equal(outcome.action, 'complete');
    assert.equal(readInstalledVersion(install), '1.5.0');
  });

  it('復旧対象が特定できなければ何もしない', () => {
    const statePath = join(work, 'state.json');
    writeUpdateState(
      { phase: 'swapping', installPath: join(work, 'x'), stagedPath: join(work, STAGING), backupPath: join(work, 'b') },
      { statePath }
    );
    assert.deepEqual(
      recoverPendingUpdate({ repoRoot: null, statePath, logger: QUIET }),
      { action: 'none', reason: 'install-dir-unknown' }
    );
  });
});

// `update --apply` は受け取ったパスを rename と再帰削除の対象にする。ヘルプに内部用として
// 載せている（障害時に読めないと困る）ので、誤って手で叩かれても無関係なディレクトリを
// 触らないことをここで固定する。
describe('update --apply の引数の検証', () => {
  const STAGING = '.vk-orchestrator-staging-1.5.0-1';

  function setup({ recordTarget = true, targetVersion = '1.4.2' } = {}) {
    const install = makeInstall(join(work, 'vk-orchestrator'), targetVersion);
    const staged = makeInstall(join(work, STAGING), '1.5.0');
    if (recordTarget) {
      writeFileSync(
        join(staged, STAGE_TARGET_FILENAME),
        JSON.stringify({ installPath: install })
      );
    }
    return { install, staged };
  }

  it('展開先から起動され、記録どおりの入れ替え先なら通る', () => {
    const { install, staged } = setup();
    const r = validateApplyArguments({ from: staged, target: install, selfRoot: staged });
    assert.equal(r.ok, true);
  });

  it('実行位置と --from が違えば拒否する（入れ替えは展開先から起動したプロセスが行う）', () => {
    const { install, staged } = setup();
    const r = validateApplyArguments({ from: staged, target: install, selfRoot: install });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'apply-from-mismatch');
  });

  it('展開先の名前が規定の形でなければ拒否する', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.4.2');
    const notStaging = makeInstall(join(work, 'somewhere'), '1.5.0');
    writeFileSync(join(notStaging, STAGE_TARGET_FILENAME), JSON.stringify({ installPath: install }));
    const r = validateApplyArguments({ from: notStaging, target: install, selfRoot: notStaging });
    assert.equal(r.code, 'apply-from-not-staging');
  });

  // ここが本命の回帰テスト。引数だけを信じると、任意のディレクトリを入れ替え対象にできる。
  it('記録と違う入れ替え先は拒否する（任意のディレクトリを消させない）', () => {
    const { staged } = setup();
    const other = makeInstall(join(work, 'important-install'), '9.9.9');
    const r = validateApplyArguments({ from: staged, target: other, selfRoot: staged });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'apply-target-mismatch');
  });

  it('入れ替え先の記録が無い展開先は拒否する', () => {
    const { install, staged } = setup({ recordTarget: false });
    const r = validateApplyArguments({ from: staged, target: install, selfRoot: staged });
    assert.equal(r.code, 'apply-target-unrecorded');
  });

  it('入れ替え先に package.json が無ければ拒否する', () => {
    const install = join(work, 'vk-orchestrator');
    mkdirSync(install, { recursive: true });
    const staged = makeInstall(join(work, STAGING), '1.5.0');
    writeFileSync(join(staged, STAGE_TARGET_FILENAME), JSON.stringify({ installPath: install }));
    assert.equal(
      validateApplyArguments({ from: staged, target: install, selfRoot: staged }).code,
      'apply-target-invalid'
    );
  });
});

// 展開先には利用者の資産（.env / config.json）の複製と node_modules が入る。
// 削除の機会が「同じ版で次に stage したとき」だけだと、版が変わるたびに溜まり続ける。
describe('使われていない展開先の片付け', () => {
  const QUIET = { log() {}, warn() {} };
  /** 実在しないプロセス ID（PID の上限を超える値）。 */
  const DEAD_PID = 2 ** 30;

  function prune(install) {
    pruneStaleStagingDirs(install, {
      logger: QUIET,
      statePath: join(work, 'state.json'),
      workDir: join(work, 'updates'),
      lockDir: join(work, 'locks'),
    });
  }

  it('もう誰も使っていない展開先を削除する', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.4.2');
    const stale = makeInstall(join(work, `.vk-orchestrator-staging-1.4.0-${DEAD_PID}`), '1.4.0');
    writeFileSync(join(stale, '.env'), 'SECRET=1');

    prune(install);

    assert.equal(existsSync(stale), false, '資産の複製を残さない');
  });

  it('自分のプロセスの展開先は残す（走行中のものを消さない）', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.4.2');
    const mine = makeInstall(join(work, `.vk-orchestrator-staging-1.5.0-${process.pid}`), '1.5.0');

    prune(install);

    assert.equal(existsSync(mine), true);
  });

  // ここが回帰テスト。「自分の pid か」だけを見ていると、別の端末で走っている
  // `vk-orchestrator update` の展開先を消してしまい、その更新を失敗させる。
  // まれに「控えの削除中」に当たると、続く rename が失敗してインストールが
  // 一時的に存在しない状態になる。
  it('生きている別プロセスの展開先は残す', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.4.2');
    // 自分以外の生きているプロセスとして、親プロセス（テストランナー）の ID を使う。
    const otherLivePid = process.ppid;
    assert.notEqual(otherLivePid, process.pid);
    const inUse = makeInstall(join(work, `.vk-orchestrator-staging-1.5.0-${otherLivePid}`), '1.5.0');

    prune(install);

    assert.equal(existsSync(inUse), true, '走行中の別プロセスの展開先を消さない');
  });

  it('別のインストール宛の展開先は残す', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.4.2');
    const otherInstall = makeInstall(join(work, 'other-install'), '1.4.2');
    const forOther = makeInstall(join(work, `.vk-orchestrator-staging-1.5.0-${DEAD_PID}`), '1.5.0');
    writeFileSync(join(forOther, STAGE_TARGET_FILENAME), JSON.stringify({ installPath: otherInstall }));

    prune(install);

    assert.equal(existsSync(forOther), true, '別インストールの更新処理のものを消さない');
  });

  it('自分のインストール宛と記録された展開先は削除する', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.4.2');
    const forSelf = makeInstall(join(work, `.vk-orchestrator-staging-1.5.0-${DEAD_PID}`), '1.5.0');
    writeFileSync(join(forSelf, STAGE_TARGET_FILENAME), JSON.stringify({ installPath: install }));

    prune(install);

    assert.equal(existsSync(forSelf), false);
  });

  it('展開先でないディレクトリは触らない', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.4.2');
    const other = makeInstall(join(work, 'important-data'), '1.0.0');

    prune(install);

    assert.equal(existsSync(other), true);
  });

  it('入れ替え中の記録が指す展開先は残す（復旧に必要）', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.4.2');
    const needed = makeInstall(join(work, `.vk-orchestrator-staging-1.5.0-${DEAD_PID}`), '1.5.0');
    const statePath = join(work, 'state.json');
    writeUpdateState(
      { phase: 'swapping', installPath: install, stagedPath: needed, backupPath: `${install}.backup-1.4.2` },
      { statePath }
    );

    prune(install);

    assert.equal(existsSync(needed), true);
  });

  it('更新処理が走っている最中は片付け自体を行わない', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.4.2');
    const stale = makeInstall(join(work, `.vk-orchestrator-staging-1.4.0-${DEAD_PID}`), '1.4.0');
    const lockDir = join(work, 'locks');
    // 別プロセス（生きている親）が更新ロックを保持している状態を作る。
    const lock = acquireUpdateLock(install, { lockDir });
    assert.equal(lock.ok, true);
    writeFileSync(lock.lockFile, JSON.stringify({ pid: process.ppid }));

    pruneStaleStagingDirs(install, {
      logger: QUIET,
      statePath: join(work, 'state.json'),
      workDir: join(work, 'updates'),
      lockDir,
    });

    assert.equal(existsSync(stale), true, '更新中は何も消さない');
  });

  // 片付けが更新ロックを「取る」と、片付けの数秒のあいだに実行された
  // `vk-orchestrator update` が「ほかのアップデート処理が実行中です」で失敗する。
  // 実際に走っているのは片付けだけなので、利用者に見せる結論が事実と合わない。
  it('片付けは更新ロックを占有しない（実行中の判定は読むだけ）', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.4.2');
    const lockDir = join(work, 'locks');

    // 片付け専用ロックを別プロセスが保持していても、更新ロックは取れる。
    const pruneLock = acquireUpdateLock(install, { lockDir, purpose: 'prune' });
    assert.equal(pruneLock.ok, true);
    writeFileSync(pruneLock.lockFile, JSON.stringify({ pid: process.ppid }));

    const updateLock = acquireUpdateLock(install, { lockDir });
    assert.equal(updateLock.ok, true, '片付け中でもアップデートは開始できる');
    updateLock.release();
  });

  it('片付け用と更新用のロックは別ファイル', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.4.2');
    const lockDir = join(work, 'locks');
    assert.notEqual(
      updateLockPathFor(install, lockDir, 'prune'),
      updateLockPathFor(install, lockDir, 'update')
    );
  });

  it('片付けどうしは重ならない', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.4.2');
    const stale = makeInstall(join(work, `.vk-orchestrator-staging-1.4.0-${DEAD_PID}`), '1.4.0');
    const lockDir = join(work, 'locks');
    const held = acquireUpdateLock(install, { lockDir, purpose: 'prune' });
    writeFileSync(held.lockFile, JSON.stringify({ pid: process.ppid }));

    pruneStaleStagingDirs(install, {
      logger: QUIET,
      statePath: join(work, 'state.json'),
      workDir: join(work, 'updates'),
      lockDir,
    });

    assert.equal(existsSync(stale), true, 'ほかの片付けが走っていれば見送る');
  });

  it('更新処理の中から呼ぶときは、自分の更新を実行中と見なさない', () => {
    const install = makeInstall(join(work, 'vk-orchestrator'), '1.4.2');
    const stale = makeInstall(join(work, `.vk-orchestrator-staging-1.4.0-${DEAD_PID}`), '1.4.0');
    const lockDir = join(work, 'locks');
    // performZipUpdate と同じ状況（自分が更新ロックを持っている）を作る。
    const lock = acquireUpdateLock(install, { lockDir });
    assert.equal(lock.ok, true);

    pruneStaleStagingDirs(install, {
      logger: QUIET,
      statePath: join(work, 'state.json'),
      workDir: join(work, 'updates'),
      lockDir,
      insideUpdate: true,
    });

    assert.equal(existsSync(stale), false, '自分の更新を理由に見送らない');
    lock.release();
  });

  it('isStagingDirInUse: 名前末尾のプロセス ID の生死で判定する', () => {
    assert.equal(isStagingDirInUse(`.vk-orchestrator-staging-1.5.0-${process.pid}`), true);
    assert.equal(isStagingDirInUse(`.vk-orchestrator-staging-1.5.0-${DEAD_PID}`), false);
    // 識別子の無い古い形式は判定できないので、使用中とはみなさない（片付け対象になる）。
    assert.equal(isStagingDirInUse('.vk-orchestrator-staging-1.5.0'), false);
  });
});

describe('更新処理の排他ロック', () => {
  it('取得できれば release で解放できる', () => {
    const install = makeInstall(join(work, 'install'), '1.4.2');
    const lockDir = join(work, 'locks');
    const first = acquireUpdateLock(install, { lockDir });
    assert.equal(first.ok, true);

    // 同じインストールに対する 2 つ目は拒否される（同時に走らせない）。
    const second = acquireUpdateLock(install, { lockDir });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'update-in-progress');

    first.release();
    const third = acquireUpdateLock(install, { lockDir });
    assert.equal(third.ok, true);
    third.release();
  });

  it('別のインストールなら同時に取得できる', () => {
    const a = makeInstall(join(work, 'a'), '1.4.2');
    const b = makeInstall(join(work, 'b'), '1.4.2');
    const lockDir = join(work, 'locks');
    const lockA = acquireUpdateLock(a, { lockDir });
    const lockB = acquireUpdateLock(b, { lockDir });
    assert.equal(lockA.ok, true);
    assert.equal(lockB.ok, true);
    lockA.release();
    lockB.release();
  });

  it('死んだプロセスが残したロックは奪う（永久に更新できなくならない）', () => {
    const install = makeInstall(join(work, 'install'), '1.4.2');
    const lockDir = join(work, 'locks');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(updateLockPathFor(install, lockDir), JSON.stringify({ pid: 2 ** 30 }));

    const lock = acquireUpdateLock(install, { lockDir });
    assert.equal(lock.ok, true);
    lock.release();
  });
});

// ロックは O_EXCL でファイルを作ってから中身を書く。作成直後・書き込み前の空ファイルを
// 「壊れている＝奪ってよい」と扱うと、2 プロセスが同時にロックを持つ状態に戻る。
describe('更新ロックの保持判定', () => {
  const HOUR = 60 * 60 * 1000;

  function lockAt(content, ageMs) {
    const lockFile = join(work, `lock-${Math.random().toString(16).slice(2)}.lock`);
    writeFileSync(lockFile, content);
    const mtime = new Date(Date.now() - ageMs);
    utimesSync(lockFile, mtime, mtime);
    return lockFile;
  }

  it('存在しなければ保持されていない', () => {
    assert.equal(isUpdateLockHeld(join(work, 'nope.lock')), false);
  });

  it('中身が書かれる前の空ファイルは保持中として扱う（同時取得へ戻さない）', () => {
    assert.equal(isUpdateLockHeld(lockAt('', 0)), true);
    assert.equal(isUpdateLockHeld(lockAt('{ partial', 0)), true);
  });

  it('中身が読めないまま長く放置されたものは奪ってよい', () => {
    assert.equal(isUpdateLockHeld(lockAt('', 2 * HOUR)), false);
  });

  it('生きているプロセスのロックは保持中', () => {
    assert.equal(isUpdateLockHeld(lockAt(JSON.stringify({ pid: process.pid }), 0)), true);
  });

  it('死んだプロセスのロックは保持されていない', () => {
    assert.equal(isUpdateLockHeld(lockAt(JSON.stringify({ pid: 2 ** 30 }), 0)), false);
  });

  // プロセス ID が再利用されて無関係な生存プロセスと一致すると、永久に更新できなくなる。
  it('生きているプロセスでも古すぎるロックは見捨てる（ID 再利用の救済）', () => {
    const old = lockAt(JSON.stringify({ pid: process.pid }), UPDATE_LOCK_MAX_AGE_MS + 1000);
    assert.equal(isUpdateLockHeld(old), false);
  });

  it('上限より新しければ保持中のまま', () => {
    const fresh = lockAt(JSON.stringify({ pid: process.pid }), UPDATE_LOCK_MAX_AGE_MS - 1000);
    assert.equal(isUpdateLockHeld(fresh), true);
  });
});

describe('detectUpdateChannel（実ディレクトリからの判定）', () => {
  it('release.json があれば zip', () => {
    const install = makeInstall(join(work, 'install'), '1.4.2', {
      'release.json': JSON.stringify({ product: 'vk-orchestrator', version: '1.4.2' }),
    });
    assert.deepEqual(detectUpdateChannel(install, { env: {} }), {
      channel: 'zip',
      reason: 'release-marker',
    });
  });

  it('目印も .git も無ければ unknown', () => {
    const install = makeInstall(join(work, 'install'), '1.4.2');
    assert.deepEqual(detectUpdateChannel(install, { env: {} }), {
      channel: 'unknown',
      reason: 'no-marker',
    });
  });

  it('.git があっても git が別ディレクトリを答えれば unknown（親リポジトリ誤認の回帰テスト）', () => {
    const install = makeInstall(join(work, 'nested', 'install'), '1.4.2');
    mkdirSync(join(install, '.git'), { recursive: true });
    const fakeSpawn = () => ({ status: 0, stdout: `${join(work, 'nested')}\n` });
    assert.deepEqual(detectUpdateChannel(install, { env: {}, spawnSyncImpl: fakeSpawn }), {
      channel: 'unknown',
      reason: 'git-toplevel-mismatch',
    });
  });

  it('env の明示指定が最優先', () => {
    const install = makeInstall(join(work, 'install'), '1.4.2');
    assert.deepEqual(
      detectUpdateChannel(install, { env: { VK_ORCHESTRATOR_UPDATE_CHANNEL: 'off' } }),
      { channel: 'off', reason: 'env-override' }
    );
  });
});

describe('起動ロックの生存判定', () => {
  it('ロックが無ければ取られていない', () => {
    assert.equal(isStartLockHeld(join(work, 'nope.lock')), false);
  });

  it('自分自身の pid が書かれていれば取られている', () => {
    const lock = join(work, 'orchestrator.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    assert.equal(isStartLockHeld(lock), true);
  });

  it('存在しないプロセスの記録（stale lock）は取られていない扱い', () => {
    const lock = join(work, 'orchestrator.lock');
    // 到達しない大きな pid を使う（PID 上限を超える値）。
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 30, startedAt: new Date().toISOString() }));
    assert.equal(isStartLockHeld(lock), false);
  });

  it('壊れた記録は取られていない扱い', () => {
    const lock = join(work, 'orchestrator.lock');
    writeFileSync(lock, 'not json');
    assert.equal(isStartLockHeld(lock), false);
  });
});

// ---------------------------------------------------------------------------
// ネットワーク（global.fetch を差し替え。ファイル操作とは混ぜない）
// ---------------------------------------------------------------------------

describe('取得先の検証（許可ホスト・https 限定）', () => {
  const ALLOWED = ['license.vektor-inc.co.jp'];

  it('許可ホストの https なら通る', () => {
    assert.equal(checkUrlAllowed('https://license.vektor-inc.co.jp/x.json', ALLOWED).ok, true);
  });

  it('http は通さない', () => {
    assert.equal(checkUrlAllowed('http://license.vektor-inc.co.jp/x.json', ALLOWED).code, 'insecure-scheme');
  });

  it('許可外ホストは通さない', () => {
    assert.equal(checkUrlAllowed('https://evil.example.com/x.json', ALLOWED).code, 'host-not-allowed');
  });
});

describe('fetchUpdateManifest', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const ALLOWED = ['license.vektor-inc.co.jp'];
  const MANIFEST_URL = 'https://license.vektor-inc.co.jp/check/packages/vk-orchestrator-latest.json';

  const validManifest = {
    schemaVersion: 1,
    product: 'vk-orchestrator',
    version: '1.5.0',
    download: {
      url: 'https://license.vektor-inc.co.jp/check/packages/vk-orchestrator-1.5.0.zip',
      sha256: 'a'.repeat(64),
    },
  };

  /** JSON を返す応答を組み立てる。 */
  function jsonResponse(body, { status = 200 } = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.from(text, 'utf8'),
    };
  }

  /** 転送（リダイレクト）応答を組み立てる。 */
  function redirectResponse(location, status = 302) {
    return {
      ok: false,
      status,
      headers: { get: (k) => (String(k).toLowerCase() === 'location' ? location : null) },
    };
  }

  it('取得して検証まで通れば manifest を返す', async () => {
    global.fetch = async () => jsonResponse(validManifest);
    const result = await fetchUpdateManifest(MANIFEST_URL, { allowedHosts: ALLOWED });
    assert.equal(result.ok, true);
    assert.equal(result.manifest.version, '1.5.0');
  });

  it('自動追従を切って取得する（転送先を検証できない形で取りに行かない）', async () => {
    let seenRedirect = null;
    global.fetch = async (_url, options) => {
      seenRedirect = options?.redirect ?? null;
      return jsonResponse(validManifest);
    };
    await fetchUpdateManifest(MANIFEST_URL, { allowedHosts: ALLOWED });
    assert.equal(seenRedirect, 'manual');
  });

  it('許可ホストへの転送は 1 ホップずつ検証して追う', async () => {
    const seen = [];
    global.fetch = async (url) => {
      seen.push(url);
      return seen.length === 1 ? redirectResponse('/moved.json') : jsonResponse(validManifest);
    };
    const result = await fetchUpdateManifest(MANIFEST_URL, { allowedHosts: ALLOWED });
    assert.equal(result.ok, true);
    assert.equal(seen.length, 2);
    assert.equal(seen[1], 'https://license.vektor-inc.co.jp/moved.json');
  });

  // ここが回帰テスト。fetch の既定は転送先を自動で追うため、検証を最初の 1 ホップにしか
  // 掛けていないと、配布元が 302 を返すだけで任意のホスト（http を含む）へ取得が飛ぶ。
  it('許可外ホストへの転送は追わない', async () => {
    const seen = [];
    global.fetch = async (url) => {
      seen.push(url);
      return redirectResponse('https://evil.example.com/x.json');
    };
    const result = await fetchUpdateManifest(MANIFEST_URL, { allowedHosts: ALLOWED });
    assert.equal(result.ok, false);
    assert.match(result.message, /許可していないホスト/);
    assert.equal(seen.length, 1, '許可外ホストへは 1 度も取りに行かない');
  });

  it('http への転送も追わない', async () => {
    global.fetch = async () => redirectResponse('http://license.vektor-inc.co.jp/x.json', 301);
    const result = await fetchUpdateManifest(MANIFEST_URL, { allowedHosts: ALLOWED });
    assert.equal(result.ok, false);
    assert.match(result.message, /https 以外/);
  });

  it('転送が続きすぎたら打ち切る', async () => {
    global.fetch = async () => redirectResponse('/again.json');
    assert.equal((await fetchUpdateManifest(MANIFEST_URL, { allowedHosts: ALLOWED })).code, 'too-many-redirects');
  });

  // 待ち時間の期限をホップごとに張り直すと、転送を挟むだけで合計の待ち時間が
  // 上限の回数倍まで伸びる。起動処理を長く止めないため、期限は全体で 1 つにする。
  it('待ち時間の期限は全ホップで共有する（転送のたびに張り直さない）', async () => {
    const signals = new Set();
    const seen = [];
    global.fetch = async (url, options) => {
      seen.push(url);
      signals.add(options?.signal);
      return seen.length < 3 ? redirectResponse(`/hop${seen.length}.json`) : jsonResponse(validManifest);
    };
    const result = await fetchUpdateManifest(MANIFEST_URL, { allowedHosts: ALLOWED });
    assert.equal(result.ok, true);
    assert.equal(seen.length, 3, '3 ホップ辿っている');
    assert.equal(signals.size, 1, '同じ期限（signal）を使い回している');
  });

  it('許可ホストが未設定なら取得しない', async () => {
    let called = false;
    global.fetch = async () => {
      called = true;
      return jsonResponse(validManifest);
    };
    const result = await fetchUpdateManifest(MANIFEST_URL, { allowedHosts: [] });
    assert.equal(result.ok, false);
    assert.equal(called, false);
  });

  it('通信できなければ network-error（オフライン時に例外で落とさない）', async () => {
    global.fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    const result = await fetchUpdateManifest(MANIFEST_URL, { allowedHosts: ALLOWED });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'network-error');
  });

  it('HTTP エラーは http-error として判別できる', async () => {
    global.fetch = async () => jsonResponse({}, { status: 500 });
    assert.equal((await fetchUpdateManifest(MANIFEST_URL, { allowedHosts: ALLOWED })).code, 'http-error');
  });

  it('JSON として読めなければ manifest-invalid', async () => {
    global.fetch = async () => jsonResponse('{ broken');
    assert.equal((await fetchUpdateManifest(MANIFEST_URL, { allowedHosts: ALLOWED })).code, 'manifest-invalid');
  });

  it('解釈できない schemaVersion は manifest-unsupported', async () => {
    global.fetch = async () => jsonResponse({ ...validManifest, schemaVersion: 2 });
    assert.equal((await fetchUpdateManifest(MANIFEST_URL, { allowedHosts: ALLOWED })).code, 'manifest-unsupported');
  });
});

describe('本文の大きさの上限', () => {
  function response(bytes, { contentLength = null } = {}) {
    const buffer = Buffer.alloc(bytes, 0x41);
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? contentLength : null) },
      arrayBuffer: async () => buffer,
    };
  }

  it('宣言サイズと一致すれば受け取る', async () => {
    const r = await readBodyWithLimit(response(100, { contentLength: '100' }), MAX_DOWNLOAD_BYTES, 100);
    assert.equal(r.ok, true);
    assert.equal(r.buffer.byteLength, 100);
  });

  it('Content-Length が上限を超えていれば読まずに中断する', async () => {
    const r = await readBodyWithLimit(response(100, { contentLength: '999999' }), MAX_DOWNLOAD_BYTES, 100);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'too-large');
  });

  // 転送時に圧縮が掛かる構成では Content-Length が圧縮後の値になる。厳密一致を求めると、
  // サーバーや CDN の設定変更だけで更新が丸ごと止まる。中身の同一性は sha256 が保証する。
  it('Content-Length が宣言サイズより小さくても受け取る（圧縮転送で止まらない）', async () => {
    const r = await readBodyWithLimit(response(100, { contentLength: '40' }), MAX_DOWNLOAD_BYTES, 100);
    assert.equal(r.ok, true);
    assert.equal(r.buffer.byteLength, 100);
  });

  it('絶対上限を超える宣言は読まずに中断する', async () => {
    const r = await readBodyWithLimit(
      response(10, { contentLength: String(MAX_DOWNLOAD_BYTES + 1) }),
      MAX_DOWNLOAD_BYTES
    );
    assert.equal(r.code, 'too-large');
  });

  // Content-Length を付けずに大量に送ってくる応答も、受け取った量で打ち切る。
  it('宣言サイズより大きい本文は打ち切る', async () => {
    const r = await readBodyWithLimit(response(5_000), MAX_DOWNLOAD_BYTES, 100);
    assert.equal(r.code, 'too-large');
  });
});

describe('downloadZip', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const ALLOWED = ['license.vektor-inc.co.jp'];
  const URL_ZIP = 'https://license.vektor-inc.co.jp/check/packages/vk-orchestrator-1.5.0.zip';

  function zipResponse(buffer) {
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(buffer.byteLength) : null) },
      arrayBuffer: async () => buffer,
    };
  }

  it('照合を通ればディスクへ書く', async () => {
    const buffer = Buffer.from('zip content');
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    global.fetch = async () => zipResponse(buffer);

    const destDir = join(work, 'dl');
    const r = await downloadZip({ url: URL_ZIP, sha256, size: buffer.byteLength, destDir, allowedHosts: ALLOWED });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(r.zipPath).toString(), 'zip content');
  });

  it('照合が合わなければディスクへ書かない（中身が確かでないファイルを残さない）', async () => {
    const buffer = Buffer.from('tampered');
    global.fetch = async () => zipResponse(buffer);

    const destDir = join(work, 'dl');
    const r = await downloadZip({
      url: URL_ZIP,
      sha256: 'b'.repeat(64),
      size: buffer.byteLength,
      destDir,
      allowedHosts: ALLOWED,
    });
    assert.equal(r.code, 'checksum-mismatch');
    assert.equal(existsSync(join(destDir, 'vk-orchestrator.zip')), false);
  });

  it('許可外ホストの zip は取りに行かない', async () => {
    let called = false;
    global.fetch = async () => {
      called = true;
      return zipResponse(Buffer.from('x'));
    };
    const r = await downloadZip({
      url: 'https://evil.example.com/x.zip',
      sha256: 'a'.repeat(64),
      destDir: join(work, 'dl'),
      allowedHosts: ALLOWED,
    });
    assert.equal(r.ok, false);
    assert.equal(called, false);
  });
});

// ---------------------------------------------------------------------------
// zip の展開
// ---------------------------------------------------------------------------

/** zip の CRC-32。zip を手で組み立てるために必要（Node に zip 生成は無い）。 */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 無圧縮（stored）の zip を組み立てる。
 *
 * 展開できることを本物の zip で確かめたいが、Node にも依存パッケージにも zip 生成が無い。
 * 無圧縮なら形式が単純なので、ここで直接組み立てる。日時は 1980-01-01 で固定する。
 */
function buildStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);  // ローカルファイルヘッダの目印
    local.writeUInt16LE(20, 4);          // 展開に必要な版
    local.writeUInt16LE(0, 6);           // フラグ
    local.writeUInt16LE(0, 8);           // 圧縮方式 0 = 無圧縮
    local.writeUInt16LE(0, 10);          // 時刻
    local.writeUInt16LE(0x21, 12);       // 日付（1980-01-01）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // 拡張フィールド
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央ディレクトリの目印
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);   // 対応するローカルヘッダの位置
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);      // 中央ディレクトリ終端の目印
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([localPart, centralPart, end]);
}

describe('zip を展開するコマンドの選択', () => {
  // Windows に unzip は無い（Git for Windows にも同梱されない）。
  // 決め打ちで unzip を起動していたため、Windows では自己更新が必ず失敗していた。
  it('Windows では unzip を候補に入れず、tar と Expand-Archive を順に試す', () => {
    const cmds = zipExtractCommands('win32', 'C:\\tmp\\a.zip', 'C:\\tmp\\out');
    assert.deepEqual(cmds.map((c) => c.command), ['tar', 'powershell']);
  });

  it('Windows の tar には展開先を -C で渡す', () => {
    const [tar] = zipExtractCommands('win32', 'C:\\tmp\\a.zip', 'C:\\tmp\\out');
    assert.deepEqual(tar.args, ['-x', '-f', 'C:\\tmp\\a.zip', '-C', 'C:\\tmp\\out']);
  });

  // PowerShell の単引用符文字列は、単引用符自身を 2 つ重ねて表す。重ねずに埋め込むと
  // 経路の側から囲いを閉じられ、後ろが別のコマンドとして解釈されうる。
  it('PowerShell へ渡す経路の単引用符を重ねて閉じ込める', () => {
    const cmds = zipExtractCommands('win32', "C:\\it's\\a.zip", "C:\\out's");
    const script = cmds[1].args.at(-1);
    assert.match(script, /-LiteralPath 'C:\\it''s\\a\.zip'/);
    assert.match(script, /-DestinationPath 'C:\\out''s'/);
  });

  it('macOS は unzip を試し、無ければ ditto へ回す', () => {
    const cmds = zipExtractCommands('darwin', '/tmp/a.zip', '/tmp/out');
    assert.deepEqual(cmds.map((c) => c.command), ['unzip', 'ditto']);
  });

  it('Linux は unzip を使う', () => {
    const cmds = zipExtractCommands('linux', '/tmp/a.zip', '/tmp/out');
    assert.deepEqual(cmds.map((c) => c.command), ['unzip']);
  });
});

describe('zip の展開（この環境の標準コマンドで実行する）', () => {
  it('配布 zip を展開し、vk-orchestrator/ の中身を取り出す', () => {
    const zipPath = join(work, 'vk-orchestrator.zip');
    writeFileSync(zipPath, buildStoredZip([
      { name: 'vk-orchestrator/package.json', content: JSON.stringify({ name: 'vk-orchestrator', version: '1.5.0' }) },
      { name: 'vk-orchestrator/src/engine/index.js', content: '// dummy\n' },
    ]));

    const destDir = join(work, 'extracted');
    const r = extractZip(zipPath, destDir);

    assert.equal(r.ok, true, r.ok ? '' : r.message);
    assert.equal(r.rootDir, join(destDir, 'vk-orchestrator'));
    assert.equal(
      readFileSync(join(r.rootDir, 'src', 'engine', 'index.js'), 'utf8'),
      '// dummy\n'
    );
  });

  it('壊れた zip は展開できなかったと伝える', () => {
    const zipPath = join(work, 'broken.zip');
    writeFileSync(zipPath, Buffer.from('これは zip ではありません'));

    const r = extractZip(zipPath, join(work, 'extracted'));

    assert.equal(r.ok, false);
    assert.equal(r.code, 'extract-failed');
  });
});

describe('展開した中身の同一性の確認', () => {
  const manifest = { version: '1.5.0' };

  it('版が一致すれば通る', () => {
    const staged = makeInstall(join(work, 'staged'), '1.5.0');
    assert.deepEqual(verifyStagedIdentity(staged, manifest), { ok: true });
  });

  it('先頭の v の有無は無視する', () => {
    const staged = makeInstall(join(work, 'staged'), '1.5.0');
    assert.equal(verifyStagedIdentity(staged, { version: 'v1.5.0' }).ok, true);
  });

  // sha256 は「その zip であること」しか保証しない。更新情報ファイルを差し替えられる立場なら
  // 「新しい版と名乗り、URL と sha256 は実在の旧版」で既知の不具合を含む版へ落とせてしまう。
  it('中身が別の版なら拒否する（旧版へのすり替えを防ぐ）', () => {
    const staged = makeInstall(join(work, 'staged'), '1.0.0');
    const r = verifyStagedIdentity(staged, manifest);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'staged-version-mismatch');
  });

  it('別の製品なら拒否する', () => {
    const staged = join(work, 'other');
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, 'package.json'), JSON.stringify({ name: 'something-else', version: '1.5.0' }));
    assert.equal(verifyStagedIdentity(staged, manifest).code, 'staged-product-mismatch');
  });

  it('package.json が読めなければ拒否する', () => {
    const staged = join(work, 'empty');
    mkdirSync(staged, { recursive: true });
    assert.equal(verifyStagedIdentity(staged, manifest).code, 'staged-package-unreadable');
  });
});

describe('アップデート直後の記録の直し', () => {
  it('通信せずに「お使いの版」を今の版へ合わせる', () => {
    const install = makeInstall(join(work, 'install'), '1.5.0');
    const statePath = join(work, 'state.json');
    // 更新前の記録（旧版・新しい版あり）を作る。
    saveUpdateSnapshot(
      {
        channel: 'zip',
        current: '1.4.2',
        latest: '1.5.0',
        updateAvailable: true,
        decision: { action: 'update', reason: 'newer-release' },
        notice: { code: 'zip-update-available', tone: 'info', lines: ['x'] },
        summary: '新しい版 1.5.0 があります（お使いの版は 1.4.2）。',
      },
      { statePath }
    );

    const next = refreshSnapshotAfterUpdate({ repoRoot: install, statePath });

    assert.equal(next.lastReport.current, '1.5.0', '切り替え直後に旧版を表示しない');
    assert.equal(next.lastReport.updateAvailable, false);
    assert.equal(next.lastReport.notice, null);
    assert.match(next.lastReport.summary, /お使いの版は 1\.5\.0/);
  });

  it('記録が無ければ作らない（確認していない状態を捏造しない）', () => {
    const install = makeInstall(join(work, 'install'), '1.5.0');
    const statePath = join(work, 'state.json');
    assert.equal(refreshSnapshotAfterUpdate({ repoRoot: install, statePath }), null);
  });
});
