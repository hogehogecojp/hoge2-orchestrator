#!/usr/bin/env node
/**
 * release-preflight.mjs
 *
 * vk-orchestrator をリリース（タグ付け）する前に必ず通すゲート。
 * 同梱している 2 つの依存を「最新」にそろえ、ズレていればリリースを止める。
 *
 *   1. vk-terminals … package.json / package-lock.json のピン（optionalDependencies の
 *      git+https#<タグ>）を、リモートの最新 semver タグへ追従（bump-vk-terminals.mjs を再利用）。
 *   2. vk-agents   … 実体の vk-agents リポジトリの最新タグを一時 worktree に取り出し、
 *      その版から export-public.sh で vendor/vk-agents-public を再生成（作業ツリーは汚さない）。
 *
 * 終了コード（vk-orchestrator-release スキルの Phase 1 から呼ばれる想定）:
 *   - 0 … どちらも既に最新。差分なし（リリース続行可）。
 *   - 1 … 同梱が古かったので最新にそろえた。作業ツリーに未コミット差分あり（正常系）。
 *         リリーススキルはこの版数を CHANGELOG／コミットに反映してから確定する。
 *   - 2 … エラー（vk-agents リポ未解決・bump 失敗・export 失敗など）。処理は完了していない。
 *
 * bump-vk-terminals.mjs と同じ思想でコミットはしない（CHANGELOG 追記と確定はスキル／人が行う）。
 *
 * vk-agents リポジトリの場所:
 *   env VK_AGENTS_DIR / VK_AGENTS_REPO_PATH > config(vkAgents.repoPath) > 既知の兄弟配置。
 *   同梱 vendor/vk-agents-public は「export の生成物」であり元リポジトリではないため、
 *   export-manifest.json を持つ実体リポジトリが解決できないときはエラーにする。
 *
 * 使い方:
 *   npm run release:preflight
 *   node scripts/release-preflight.mjs
 */

import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { toTuple, cmpTuple, latestSemverTag } from './vk-terminals-tags.mjs';
import { resolveVkAgentsRepoPath } from '../src/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_AGENTS_REL = 'vendor/vk-agents-public';
const VENDOR_AGENTS_DIR = join(ROOT, VENDOR_AGENTS_REL);

function log(msg) {
  console.log(msg);
}

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(2);
}

/** 指定パス配下の追跡差分（porcelain）を返す。差分なしなら空文字。 */
function gitStatus(pathspec) {
  return execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--', pathspec], {
    encoding: 'utf8',
  }).trim();
}

// ---------------------------------------------------------------------------
// 1. vk-terminals ピンを最新タグへ追従
// ---------------------------------------------------------------------------
function syncVkTerminals() {
  log('▶ vk-terminals ピンを最新タグへ追従します...');
  const r = spawnSync('node', [join(ROOT, 'scripts', 'bump-vk-terminals.mjs'), 'latest'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    fail('vk-terminals の bump に失敗しました（リモートタグの解決に失敗した可能性があります）。');
  }
  const changed = gitStatus('package.json') !== '' || gitStatus('package-lock.json') !== '';
  if (changed) {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const spec = pkg.optionalDependencies?.['vk-terminals'] ?? '';
    const tag = spec.match(/#(.+)$/)?.[1] ?? '(不明)';
    log(`  → 更新あり: vk-terminals ピンを ${tag} に更新しました。`);
    return { changed: true, tag };
  }
  log('  → 既に最新。変更なし。');
  return { changed: false };
}

// ---------------------------------------------------------------------------
// 2. vk-agents 同梱を最新タグから再 export
// ---------------------------------------------------------------------------
function resolveAgentsSourceRepo() {
  let repo;
  try {
    repo = resolveVkAgentsRepoPath();
  } catch {
    repo = null;
  }
  if (!repo) {
    fail(
      'vk-agents リポジトリを解決できませんでした。\n' +
        '  実体の clone を用意し、VK_AGENTS_DIR で場所を指定してください。\n' +
        '  例: VK_AGENTS_DIR=/path/to/vk-agents npm run release:preflight'
    );
  }
  // 同梱 vendor は export 生成物であって元リポジトリではない。取り違え防止のため
  // export-manifest.json と scripts/export-public.sh の両方を持つことを必須にする。
  const manifest = join(repo, 'export-manifest.json');
  const exporter = join(repo, 'scripts', 'export-public.sh');
  if (!existsSync(manifest) || !existsSync(exporter)) {
    fail(
      `解決した vk-agents パスが export 元リポジトリではありません: ${repo}\n` +
        '  export-manifest.json と scripts/export-public.sh を持つ実体の vk-agents clone を\n' +
        '  VK_AGENTS_DIR で指定してください（同梱 vendor/vk-agents-public は指定不可）。'
    );
  }
  // git 管理下であることも確認（worktree/tag 操作に必要）。
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  } catch {
    fail(`vk-agents パスが git リポジトリではありません: ${repo}`);
  }
  return repo;
}

/** ローカルリポジトリの最新 semver タグを返す。 */
function latestLocalTag(repo) {
  execFileSync('git', ['-C', repo, 'fetch', '--tags', '--quiet'], { stdio: 'ignore' });
  const out = execFileSync('git', ['-C', repo, 'tag', '--list'], { encoding: 'utf8' });
  const tags = new Map();
  for (const line of out.split('\n')) {
    const tag = line.trim();
    if (tag && toTuple(tag)) tags.set(tag, true);
  }
  return latestSemverTag(tags);
}

function syncVkAgents() {
  log('\n▶ vk-agents 同梱を最新タグから再 export します...');
  const repo = resolveAgentsSourceRepo();
  const tag = latestLocalTag(repo);
  if (!tag) {
    fail(`vk-agents から semver タグを解決できませんでした: ${repo}`);
  }
  log(`  対象タグ: ${tag}（元リポジトリ: ${repo}）`);

  // 元リポジトリの作業ツリーを汚さないよう、最新タグの detached worktree を一時作成し、
  // そこから export-public.sh を実行する。
  const work = mkdtempSync(join(tmpdir(), 'vk-agents-export-'));
  const worktree = join(work, 'vk-agents');
  let added = false;
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', '--quiet', worktree, tag], {
      stdio: 'inherit',
    });
    added = true;
    const exporter = join(worktree, 'scripts', 'export-public.sh');
    const r = spawnSync('bash', [exporter, '--dest', VENDOR_AGENTS_DIR], {
      cwd: worktree,
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      fail('export-public.sh の実行に失敗しました。');
    }
  } finally {
    if (added) {
      try {
        execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', worktree], {
          stdio: 'ignore',
        });
      } catch {
        // worktree の後始末失敗は致命ではない。手動整理を促す。
        console.warn(`  ⚠ 一時 worktree の後始末に失敗しました。手動で削除してください: ${worktree}`);
      }
    }
    rmSync(work, { recursive: true, force: true });
  }

  const changed = gitStatus(VENDOR_AGENTS_REL) !== '';
  if (changed) {
    log(`  → 更新あり: ${VENDOR_AGENTS_REL} を vk-agents ${tag} に同期しました。`);
    return { changed: true, tag };
  }
  log(`  → 既に最新（vk-agents ${tag}）。変更なし。`);
  return { changed: false, tag };
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------
const terminals = syncVkTerminals();
const agents = syncVkAgents();

log('\n' + '─'.repeat(60));
if (!terminals.changed && !agents.changed) {
  log('✅ 同梱の vk-terminals / vk-agents は既に最新です。リリースを続行できます。');
  process.exit(0);
}

log('✔ 同梱が古かったため、最新にそろえました（未コミットの差分があります）。');
if (terminals.changed) log(`   - vk-terminals ピン → ${terminals.tag}`);
if (agents.changed) log(`   - vk-agents 同梱 → ${agents.tag}`);
log('');
log('リリース確定時（vk-orchestrator-release スキル）に次を反映してください:');
if (terminals.changed) {
  log(`   - CHANGELOG.md に「vk-terminals を <旧> から ${terminals.tag} にアップデート」行を追記`);
}
if (agents.changed) {
  log(`   - コミット／CHANGELOG に「同梱 vk-agents-public を vk-agents ${agents.tag} に同期」を反映`);
}
log('   - 上記差分をリリースコミットに含める');
// exit 1 = 「同期して差分あり（正常系）」。エラー（exit 2）と区別する。
process.exit(1);
