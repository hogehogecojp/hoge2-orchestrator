import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

const MAX_GIT_DEPTH = 4;
const MAX_REPO_ROOT_DEPTH = MAX_GIT_DEPTH - 1;
const PRUNED_DIR_NAMES = new Set(['.git', 'node_modules']);

/**
 * vk-kore step 2.5 の sed 正規化と同じ規則で origin URL を owner/repo へ正規化する。
 *
 * sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##' | tr '[:upper:]' '[:lower:]'
 *
 * @param {string} url
 * @returns {string}
 */
export function normalizeOriginUrl(url) {
  return String(url ?? '')
    .trim()
    .replace(/^git@[^:]+:/, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '')
    .toLowerCase();
}

/**
 * search_paths の先頭 ~ をホームディレクトリへ展開し、絶対パス化する。
 * @param {string} path
 * @returns {string}
 */
function expandSearchPath(path) {
  const raw = String(path ?? '').trim();
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return resolve(raw);
}

/**
 * .git/config から remote "origin" の url を取り出す。
 * @param {string} repoRoot
 * @returns {string|null}
 */
function readOriginUrl(repoRoot) {
  const configPath = join(repoRoot, '.git', 'config');
  if (!existsSync(configPath)) return null;

  let inOriginSection = false;
  const config = readFileSync(configPath, 'utf8');
  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[/.test(trimmed)) {
      inOriginSection = /^\[remote\s+"origin"\]\s*$/.test(trimmed);
      continue;
    }
    if (!inOriginSection) continue;

    const match = trimmed.match(/^url\s*=\s*(.+)$/);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * @param {string} repoRoot
 * @param {string} expectedRepoKey
 * @returns {boolean}
 */
function hasMatchingOrigin(repoRoot, expectedRepoKey) {
  try {
    const originUrl = readOriginUrl(repoRoot);
    return originUrl ? normalizeOriginUrl(originUrl) === expectedRepoKey : false;
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function hasGitDirectory(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => (
      entry.name === '.git' && entry.isDirectory()
    ));
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @param {number} depth
 * @param {string} expectedRepoKey
 * @returns {string|null}
 */
function walkForRepo(dir, depth, expectedRepoKey) {
  if (hasGitDirectory(dir) && hasMatchingOrigin(dir, expectedRepoKey)) {
    return dir;
  }
  if (depth >= MAX_REPO_ROOT_DEPTH) return null;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || PRUNED_DIR_NAMES.has(entry.name)) continue;
    const found = walkForRepo(join(dir, entry.name), depth + 1, expectedRepoKey);
    if (found) return found;
  }
  return null;
}

/**
 * workspace.search_paths から owner/repo に一致する既存ローカルクローンの cwd を解決する。
 * クローン作成・ブランチ切替・worktree 処理は行わない。
 *
 * @param {{ owner: string, repo: string, searchPaths: string[] }} options
 * @returns {string|null}
 */
export function resolveRepoCwd({ owner, repo, searchPaths }) {
  const expectedRepoKey = `${String(owner ?? '').toLowerCase()}/${String(repo ?? '').toLowerCase()}`;
  if (!owner || !repo || !Array.isArray(searchPaths) || searchPaths.length === 0) return null;

  for (const rawBase of searchPaths) {
    if (typeof rawBase !== 'string' || rawBase.trim() === '') continue;
    const base = expandSearchPath(rawBase);
    const found = walkForRepo(base, 0, expectedRepoKey);
    if (found) return found;
  }
  return null;
}
