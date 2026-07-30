/**
 * 配布 zip での入れ替え（判断部分）のユニットテスト。
 *
 * 入れ替えは一度失敗するとアプリが起動しなくなる処理なので、
 *   - 引き継ぐ資産の選び方（存在しないもの・危険なパス・シンボリックリンクを混ぜない）
 *   - 手順の順序（作業記録を書いてから動かす）
 *   - 途中で終わったときの復旧の判断
 * をここで固定する。ネットワークもファイル操作もしない純粋関数だけを対象にする。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_DIR_INFIX,
  PRESERVED_RELATIVE_PATHS,
  STAGING_DIR_PREFIX,
  UNKNOWN_VERSION_LABEL,
  backupDirFor,
  computePreservedPaths,
  evaluateUpdateBlockers,
  planSwap,
  recoverInterruptedUpdate,
  sanitizeVersionForPath,
  stagingDirFor,
  validateUpdateJournalPaths,
} from '../src/engine/update-apply.js';

const INSTALL = '/Users/tester/apps/vk-orchestrator';
const STAGED = '/Users/tester/apps/.vk-orchestrator-staging-1.5.0';
const BACKUP = '/Users/tester/apps/vk-orchestrator.backup-1.4.2';
const JOURNAL = '/Users/tester/.vk-orchestrator/update-state.json';
// 親が書けない環境での退避先（インストールの兄弟に置けないときだけ使う）。
const WORK_DIR = '/Users/tester/.vk-orchestrator/updates';

describe('computePreservedPaths', () => {
  it('存在するものだけを引き継ぐ（存在しない .env は列に入らない）', () => {
    const { preserved } = computePreservedPaths({
      existing: ['config.json', 'vendor/vk-agents-public/config.json'],
    });
    assert.deepEqual(preserved, ['config.json', 'vendor/vk-agents-public/config.json']);
    assert.equal(preserved.includes('.env'), false, '存在しない .env は含めない');
  });

  it('引き継ぐ対象は専用の一覧で持ち、node_modules や *.log は混ざらない', () => {
    const { preserved } = computePreservedPaths({
      existing: ['.env', 'config.json', 'node_modules', 'orchestrator.log', 'debug.log'],
    });
    assert.deepEqual(preserved, ['.env', 'config.json']);
    assert.equal(PRESERVED_RELATIVE_PATHS.includes('node_modules'), false);
    assert.equal(
      PRESERVED_RELATIVE_PATHS.some((p) => p.endsWith('.log') || p.includes('*')),
      false,
      'ログファイルは引き継がない'
    );
  });

  it('親ディレクトリへ脱出する相対パスを弾く', () => {
    const { preserved, rejected } = computePreservedPaths({
      existing: ['../outside.json', 'a/../../escape.json', '/etc/passwd', 'config.json'],
      candidates: ['../outside.json', 'a/../../escape.json', '/etc/passwd', 'config.json'],
    });
    assert.deepEqual(preserved, ['config.json']);
    assert.deepEqual(
      rejected.map((r) => r.reason),
      ['unsafe-path', 'unsafe-path', 'unsafe-path']
    );
  });

  it('シンボリックリンクは引き継がない（指す先がインストール外を向きうる）', () => {
    const { preserved, rejected } = computePreservedPaths({
      existing: [{ path: '.env', symlink: true }, { path: 'config.json', symlink: false }],
    });
    assert.deepEqual(preserved, ['config.json']);
    assert.deepEqual(rejected, [{ path: '.env', reason: 'symlink' }]);
  });

  it('何も存在しなければ空になる', () => {
    assert.deepEqual(computePreservedPaths({ existing: [] }).preserved, []);
    assert.deepEqual(computePreservedPaths().preserved, []);
  });
});

describe('planSwap', () => {
  it('同一ファイルシステムなら rename 2 回で入れ替える', () => {
    const steps = planSwap({
      installDir: INSTALL,
      stagedDir: STAGED,
      sameDevice: true,
      backupPath: BACKUP,
      journalPath: JOURNAL,
      from: '1.4.2',
      to: '1.5.0',
    });

    assert.deepEqual(
      steps.map((s) => s.op),
      ['write-journal', 'rename', 'rename', 'write-journal']
    );
    assert.equal(steps.filter((s) => s.op === 'rename').length, 2);
  });

  it('順序は「作業記録 → backup へ rename → 展開先を rename」', () => {
    const steps = planSwap({
      installDir: INSTALL,
      stagedDir: STAGED,
      sameDevice: true,
      backupPath: BACKUP,
      journalPath: JOURNAL,
    });

    assert.equal(steps[0].op, 'write-journal');
    assert.equal(steps[0].journal.phase, 'swapping');
    assert.equal(steps[0].path, JOURNAL);
    assert.deepEqual({ from: steps[1].from, to: steps[1].to }, { from: INSTALL, to: BACKUP });
    assert.deepEqual({ from: steps[2].from, to: steps[2].to }, { from: STAGED, to: INSTALL });
    assert.equal(steps.at(-1).journal.phase, 'completed');
  });

  it('作業記録には版・パス・元の引数が入る（起動し直しに使う）', () => {
    const steps = planSwap({
      installDir: INSTALL,
      stagedDir: STAGED,
      sameDevice: true,
      backupPath: BACKUP,
      journalPath: JOURNAL,
      from: '1.4.2',
      to: '1.5.0',
      argv: ['up', '--no-attach'],
    });
    assert.deepEqual(steps[0].journal, {
      installPath: INSTALL,
      stagedPath: STAGED,
      backupPath: BACKUP,
      from: '1.4.2',
      to: '1.5.0',
      argv: ['up', '--no-attach'],
      phase: 'swapping',
    });
  });

  it('別ファイルシステムならコピー経路になる', () => {
    const steps = planSwap({
      installDir: INSTALL,
      stagedDir: '/Users/tester/.vk-orchestrator/updates/1.5.0/.vk-orchestrator-staging-1.5.0',
      sameDevice: false,
      backupPath: BACKUP,
      journalPath: JOURNAL,
    });

    assert.deepEqual(
      steps.map((s) => s.op),
      ['write-journal', 'rename', 'copy-dir', 'remove-dir', 'write-journal']
    );
    // コピー方式でも「作業記録 → backup rename」の順序は変えない。
    assert.equal(steps[0].op, 'write-journal');
    assert.deepEqual({ from: steps[1].from, to: steps[1].to }, { from: INSTALL, to: BACKUP });
  });
});

describe('recoverInterruptedUpdate', () => {
  const base = { phase: 'swapping', installPath: INSTALL, backupPath: BACKUP, stagedPath: STAGED };

  it('記録がなければ何もしない', () => {
    assert.deepEqual(recoverInterruptedUpdate(null), { action: 'none', reason: 'no-journal' });
    assert.deepEqual(recoverInterruptedUpdate(undefined), { action: 'none', reason: 'no-journal' });
  });

  it('入れ替え中の記録でなければ何もしない（2 回連続実行が冪等）', () => {
    const completed = { ...base, phase: 'completed', installExists: true, backupExists: true };
    assert.deepEqual(recoverInterruptedUpdate(completed), { action: 'none', reason: 'no-pending-swap' });
    // 1 回目の復旧で phase が completed になったあと、同じ判定をもう一度通しても何もしない。
    assert.deepEqual(recoverInterruptedUpdate(completed), { action: 'none', reason: 'no-pending-swap' });
  });

  it('install が無く展開先が残っていれば続行する', () => {
    assert.deepEqual(
      recoverInterruptedUpdate({ ...base, installExists: false, stagedExists: true, backupExists: true }),
      { action: 'complete', reason: 'staged-ready' }
    );
  });

  it('install が無く控えだけ残っていれば巻き戻す', () => {
    assert.deepEqual(
      recoverInterruptedUpdate({ ...base, installExists: false, stagedExists: false, backupExists: true }),
      { action: 'revert', reason: 'install-missing' }
    );
  });

  it('install と控えの両方があれば巻き戻す（確定していない入れ替えを採用しない）', () => {
    assert.deepEqual(
      recoverInterruptedUpdate({ ...base, installExists: true, backupExists: true, stagedExists: false }),
      { action: 'revert', reason: 'swap-unconfirmed' }
    );
  });

  it('install だけがあれば入れ替えは始まっていない', () => {
    assert.deepEqual(
      recoverInterruptedUpdate({ ...base, installExists: true, backupExists: false, stagedExists: true }),
      { action: 'none', reason: 'swap-not-started' }
    );
  });

  it('どこにも実体が無ければ手の打ちようがない', () => {
    assert.deepEqual(
      recoverInterruptedUpdate({ ...base, installExists: false, backupExists: false, stagedExists: false }),
      { action: 'none', reason: 'nothing-to-recover' }
    );
  });
});

describe('evaluateUpdateBlockers', () => {
  it('静止していれば実行できる', () => {
    assert.deepEqual(
      evaluateUpdateBlockers({ channel: 'zip', healthResponding: false, startLockHeld: false }),
      []
    );
  });

  it('GUI が応答していれば拒否する', () => {
    const blockers = evaluateUpdateBlockers({ channel: 'zip', healthResponding: true });
    assert.deepEqual(blockers.map((b) => b.code), ['busy-gui']);
    assert.ok(blockers[0].message.length > 0);
    assert.ok(blockers[0].hint.length > 0);
  });

  it('オーケストレーターが動作中なら拒否する', () => {
    assert.deepEqual(
      evaluateUpdateBlockers({ channel: 'zip', startLockHeld: true }).map((b) => b.code),
      ['busy-engine']
    );
  });

  it('入手経路が分からなければ拒否する', () => {
    assert.deepEqual(
      evaluateUpdateBlockers({ channel: 'unknown' }).map((b) => b.code),
      ['channel-unresolved']
    );
  });

  it('複数の理由は全部返す（利用者が一度で把握できるように）', () => {
    assert.deepEqual(
      evaluateUpdateBlockers({ channel: 'unknown', healthResponding: true, startLockHeld: true })
        .map((b) => b.code),
      ['channel-unresolved', 'busy-gui', 'busy-engine']
    );
  });
});

describe('展開先・控えのパス', () => {
  it('展開先はインストールディレクトリの兄弟に置く（原子的な rename を保証する）', () => {
    assert.equal(
      stagingDirFor('/Users/tester/apps', '1.5.0'),
      '/Users/tester/apps/.vk-orchestrator-staging-1.5.0'
    );
  });

  it('展開先に識別子を付けられる（同時実行が同じ展開先を掴まないようにする）', () => {
    assert.equal(
      stagingDirFor('/Users/tester/apps', '1.5.0', 12345),
      '/Users/tester/apps/.vk-orchestrator-staging-1.5.0-12345'
    );
  });

  it('控えは版名を含む（世代を 1 つだけ残せる）', () => {
    assert.equal(backupDirFor(INSTALL, '1.4.2'), `${INSTALL}.backup-1.4.2`);
    assert.equal(backupDirFor(INSTALL, null), `${INSTALL}.backup-unknown`);
  });
});

// これらのパスは rename と再帰削除の対象になる。版の出どころには「配布 zip の中の
// package.json」も含まれ、更新情報ファイルほど厳しく検証されていない。
// `1.0.0/../../..` のような値をそのまま連結すると、削除対象が親ディレクトリへ脱出する。
describe('sanitizeVersionForPath（ディレクトリ名に埋める版の検証）', () => {
  it('通常の版はそのまま使う', () => {
    assert.equal(sanitizeVersionForPath('1.5.0'), '1.5.0');
    assert.equal(sanitizeVersionForPath('v1.5.0-beta.1'), 'v1.5.0-beta.1');
  });

  it('パス区切りを含む値は使わない', () => {
    assert.equal(sanitizeVersionForPath('1.0.0/../../../etc'), UNKNOWN_VERSION_LABEL);
    assert.equal(sanitizeVersionForPath('../evil'), UNKNOWN_VERSION_LABEL);
    assert.equal(sanitizeVersionForPath('/absolute'), UNKNOWN_VERSION_LABEL);
    assert.equal(sanitizeVersionForPath('a\\b'), UNKNOWN_VERSION_LABEL);
  });

  it('空・非文字列は使わない', () => {
    assert.equal(sanitizeVersionForPath(''), UNKNOWN_VERSION_LABEL);
    assert.equal(sanitizeVersionForPath('   '), UNKNOWN_VERSION_LABEL);
    assert.equal(sanitizeVersionForPath(null), UNKNOWN_VERSION_LABEL);
    assert.equal(sanitizeVersionForPath({}), UNKNOWN_VERSION_LABEL);
  });

  it('危険な版が入っていても控え・展開先が親ディレクトリを脱出しない', () => {
    const evil = '1.0.0/../../../../../../tmp/pwned';
    assert.equal(backupDirFor(INSTALL, evil), `${INSTALL}${BACKUP_DIR_INFIX}${UNKNOWN_VERSION_LABEL}`);
    assert.equal(
      stagingDirFor('/Users/tester/apps', evil),
      `/Users/tester/apps/${STAGING_DIR_PREFIX}${UNKNOWN_VERSION_LABEL}`
    );
  });
});

// 復旧処理は記録に書かれたパスを rename / 再帰削除の対象にするため、
// 処理する前に「いま動いているインストールのものか」を確かめる。
describe('validateUpdateJournalPaths（作業記録のパスの検証）', () => {
  const journal = { installPath: INSTALL, backupPath: BACKUP, stagedPath: STAGED };

  it('自分自身のインストールで規定の命名なら通る', () => {
    assert.deepEqual(
      validateUpdateJournalPaths({ journal, installDir: INSTALL, recordedInstallDir: INSTALL }),
      { ok: true }
    );
  });

  it('別のインストールを指していれば通さない（clone 側と zip 側の併用で他方を消さない）', () => {
    const r = validateUpdateJournalPaths({
      journal,
      installDir: '/Users/tester/apps/vk-orchestrator-zip',
      recordedInstallDir: INSTALL,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'install-path-mismatch');
  });

  it('控えがインストールの兄弟でなければ通さない', () => {
    const r = validateUpdateJournalPaths({
      journal: { ...journal, backupPath: '/Users/tester/important' },
      installDir: INSTALL,
      recordedInstallDir: INSTALL,
    });
    assert.equal(r.reason, 'backup-path-outside');
  });

  it('控えの名前が規定の形でなければ通さない', () => {
    const r = validateUpdateJournalPaths({
      journal: { ...journal, backupPath: '/Users/tester/apps/other-dir' },
      installDir: INSTALL,
      recordedInstallDir: INSTALL,
    });
    assert.equal(r.reason, 'backup-path-unexpected-name');
  });

  it('展開先の名前が規定の形でなければ通さない', () => {
    const r = validateUpdateJournalPaths({
      journal: { ...journal, stagedPath: '/Users/tester/apps/my-important-data' },
      installDir: INSTALL,
      recordedInstallDir: INSTALL,
    });
    assert.equal(r.reason, 'staged-path-unexpected-name');
  });

  it('展開先はホーム配下の退避先も通す（許可した親であれば）', () => {
    const r = validateUpdateJournalPaths({
      journal: { ...journal, stagedPath: `${WORK_DIR}/.vk-orchestrator-staging-1.5.0-99` },
      installDir: INSTALL,
      recordedInstallDir: INSTALL,
      allowedStagedParents: [WORK_DIR],
    });
    assert.equal(r.ok, true);
  });

  // 名前だけを見て場所を見ないと、規定の名前を付けた任意のディレクトリが
  // 「復旧の続行」で install として据えられ、次回起動でその中のコードが動いてしまう。
  it('許可していない場所の展開先は、規定の名前でも通さない', () => {
    const r = validateUpdateJournalPaths({
      journal: { ...journal, stagedPath: '/private/tmp/attacker/.vk-orchestrator-staging-evil' },
      installDir: INSTALL,
      recordedInstallDir: INSTALL,
      allowedStagedParents: [WORK_DIR],
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'staged-path-outside');
  });

  it('退避先を許可していなければ、ホーム配下の展開先も通さない', () => {
    const r = validateUpdateJournalPaths({
      journal: { ...journal, stagedPath: `${WORK_DIR}/.vk-orchestrator-staging-1.5.0-99` },
      installDir: INSTALL,
      recordedInstallDir: INSTALL,
    });
    assert.equal(r.reason, 'staged-path-outside');
  });

  it('記録が無ければ通さない', () => {
    assert.equal(validateUpdateJournalPaths({ journal: null, installDir: INSTALL }).reason, 'no-journal');
  });

  it('インストール先が解決できなければ通さない', () => {
    assert.equal(
      validateUpdateJournalPaths({ journal, installDir: null, recordedInstallDir: INSTALL }).reason,
      'install-path-unresolved'
    );
  });
});
