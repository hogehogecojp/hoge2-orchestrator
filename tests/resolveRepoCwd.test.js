/**
 * task pane cwd 用のローカルリポジトリ検出テスト。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { normalizeOriginUrl, resolveRepoCwd } from '../src/engine/resolve-repo-cwd.js';

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'vko-repo-cwd-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createClone(root, originUrl) {
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(
    join(root, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${originUrl}\n`,
  );
}

test('normalizeOriginUrl: vk-kore step 2.5 の sed 正規化と同じ結果を返す', () => {
  // sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##' | tr '[:upper:]' '[:lower:]'
  assert.equal(normalizeOriginUrl('git@github.com:VeKtor-inc/Foo.git'), 'vektor-inc/foo');
  assert.equal(normalizeOriginUrl('https://github.com/vektor-inc/vk-orchestrator.git'), 'vektor-inc/vk-orchestrator');
  assert.equal(normalizeOriginUrl('https://github.com/vektor-inc/vk-orchestrator'), 'vektor-inc/vk-orchestrator');
  assert.equal(normalizeOriginUrl('git@github.com:vektor-inc/vk-orchestrator'), 'vektor-inc/vk-orchestrator');
});

test('resolveRepoCwd: searchPaths の優先順で最初に一致した clone root を返す', () => {
  withTmpDir((dir) => {
    const firstBase = join(dir, 'first');
    const secondBase = join(dir, 'second');
    const firstClone = join(firstBase, 'vk-orchestrator');
    const secondClone = join(secondBase, 'nested', 'vk-orchestrator');
    createClone(firstClone, 'git@github.com:vektor-inc/vk-orchestrator.git');
    createClone(secondClone, 'git@github.com:vektor-inc/vk-orchestrator.git');

    assert.equal(
      resolveRepoCwd({
        owner: 'vektor-inc',
        repo: 'vk-orchestrator',
        searchPaths: [secondBase, firstBase],
      }),
      secondClone,
    );
  });
});

test('resolveRepoCwd: owner/repo は正規化後に完全一致で判定する', () => {
  withTmpDir((dir) => {
    const almost = join(dir, 'almost');
    const match = join(dir, 'match');
    createClone(almost, 'git@github.com:vektor-inc/vk-orchestrator-extra.git');
    createClone(match, 'https://github.com/VeKtor-inc/vk-orchestrator.git');

    assert.equal(
      resolveRepoCwd({
        owner: 'vektor-inc',
        repo: 'vk-orchestrator',
        searchPaths: [dir],
      }),
      match,
    );
  });
});

test('resolveRepoCwd: 一致する origin が無ければ null を返す', () => {
  withTmpDir((dir) => {
    createClone(join(dir, 'other'), 'https://github.com/vektor-inc/other.git');
    assert.equal(
      resolveRepoCwd({
        owner: 'vektor-inc',
        repo: 'vk-orchestrator',
        searchPaths: [dir],
      }),
      null,
    );
  });
});

test('resolveRepoCwd: .git がファイルの worktree は候補から除外する', () => {
  withTmpDir((dir) => {
    const worktree = join(dir, 'worktree');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: /tmp/worktrees/vk-orchestrator/.git\n');

    assert.equal(
      resolveRepoCwd({
        owner: 'vektor-inc',
        repo: 'vk-orchestrator',
        searchPaths: [dir],
      }),
      null,
    );
  });
});

test('resolveRepoCwd: find -maxdepth 4 相当の深さまで検出する', () => {
  withTmpDir((dir) => {
    const withinDepth = join(dir, 'a', 'b', 'c');
    const tooDeep = join(dir, 'x', 'y', 'z', 'w');
    createClone(withinDepth, 'https://github.com/vektor-inc/vk-orchestrator.git');
    createClone(tooDeep, 'https://github.com/vektor-inc/vk-orchestrator.git');

    assert.equal(
      resolveRepoCwd({
        owner: 'vektor-inc',
        repo: 'vk-orchestrator',
        searchPaths: [dir],
      }),
      withinDepth,
    );
  });
});

test('resolveRepoCwd: find -maxdepth 4 より深い .git は検出しない', () => {
  withTmpDir((dir) => {
    const tooDeep = join(dir, 'x', 'y', 'z', 'w');
    createClone(tooDeep, 'https://github.com/vektor-inc/vk-orchestrator.git');

    assert.equal(
      resolveRepoCwd({
        owner: 'vektor-inc',
        repo: 'vk-orchestrator',
        searchPaths: [dir],
      }),
      null,
    );
  });
});
