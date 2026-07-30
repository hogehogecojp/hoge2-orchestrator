/**
 * resolveUpdateChannel のユニットテスト。
 *
 * アップデートの入手経路（git clone した作業ツリー / 配布 zip の展開）を取り違えると、
 * 配布 zip を別リポジトリの配下へ展開された環境で「親リポジトリに対して git pull を実行する」
 * という事故になる。ここでは特にその回帰（toplevel 不一致は git と判定しない）を固定する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveUpdateChannel, UPDATE_CHANNELS } from '../src/engine/update-channel.js';

const INSTALL = '/Users/tester/apps/vk-orchestrator';

describe('resolveUpdateChannel', () => {
  it('env の明示指定が最優先（release.json や .git があっても従う）', () => {
    assert.deepEqual(
      resolveUpdateChannel({
        envChannel: 'zip',
        hasGitDir: true,
        gitToplevel: INSTALL,
        repoRoot: INSTALL,
      }),
      { channel: 'zip', reason: 'env-override' }
    );
    assert.deepEqual(
      resolveUpdateChannel({ envChannel: 'off', hasReleaseMarker: true, repoRoot: INSTALL }),
      { channel: 'off', reason: 'env-override' }
    );
    assert.deepEqual(
      resolveUpdateChannel({ envChannel: ' GIT ', hasReleaseMarker: true, hasGitDir: true, gitToplevel: INSTALL, repoRoot: INSTALL }),
      { channel: 'git', reason: 'env-override' }
    );
  });

  it('受け付けない env 値は無視して実状態から判定する', () => {
    assert.deepEqual(
      resolveUpdateChannel({ envChannel: 'rsync', hasReleaseMarker: true, repoRoot: INSTALL }),
      { channel: 'zip', reason: 'release-marker' }
    );
  });

  it('release.json があれば zip', () => {
    assert.deepEqual(
      resolveUpdateChannel({ hasReleaseMarker: true, repoRoot: INSTALL }),
      { channel: 'zip', reason: 'release-marker' }
    );
  });

  it('release.json は .git より優先する（zip を clone 内へ展開した場合も zip として扱う）', () => {
    assert.deepEqual(
      resolveUpdateChannel({
        hasReleaseMarker: true,
        hasGitDir: true,
        gitToplevel: INSTALL,
        repoRoot: INSTALL,
      }),
      { channel: 'zip', reason: 'release-marker' }
    );
  });

  it('.git があり toplevel がインストール先と一致すれば git', () => {
    assert.deepEqual(
      resolveUpdateChannel({ hasGitDir: true, gitToplevel: INSTALL, repoRoot: INSTALL }),
      { channel: 'git', reason: 'git-toplevel-match' }
    );
  });

  it('末尾のスラッシュ差だけなら一致とみなす', () => {
    assert.deepEqual(
      resolveUpdateChannel({ hasGitDir: true, gitToplevel: `${INSTALL}/`, repoRoot: INSTALL }),
      { channel: 'git', reason: 'git-toplevel-match' }
    );
  });

  it('.git があっても toplevel が別ディレクトリなら unknown（親リポジトリ誤認の回帰テスト）', () => {
    assert.deepEqual(
      resolveUpdateChannel({
        hasGitDir: true,
        gitToplevel: '/Users/tester/apps',
        repoRoot: INSTALL,
      }),
      { channel: 'unknown', reason: 'git-toplevel-mismatch' }
    );
  });

  it('.git があっても git が toplevel を答えられなければ unknown', () => {
    assert.deepEqual(
      resolveUpdateChannel({ hasGitDir: true, gitToplevel: null, repoRoot: INSTALL }),
      { channel: 'unknown', reason: 'git-toplevel-unresolved' }
    );
  });

  it('目印なし・.git なしなら unknown', () => {
    assert.deepEqual(
      resolveUpdateChannel({ repoRoot: INSTALL }),
      { channel: 'unknown', reason: 'no-marker' }
    );
    assert.deepEqual(resolveUpdateChannel(), { channel: 'unknown', reason: 'no-marker' });
  });

  it('受け付ける明示指定は git / zip / off の 3 つ', () => {
    assert.deepEqual(UPDATE_CHANNELS, ['git', 'zip', 'off']);
  });
});
