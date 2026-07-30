/**
 * アップデートの入手経路（チャネル）を決める純粋関数。
 *
 * vk-orchestrator は 2 通りの入れ方で使われる。
 *
 *   - git clone した作業ツリー（開発者・従来ユーザー）… `git pull --ff-only` で更新する
 *   - 配布 zip を展開したインストール（一般ユーザー）… 新しい zip を取得して入れ替える
 *
 * どちらなのかを取り違えると重大な事故になる。とくに zip を「別のリポジトリの配下」へ
 * 展開されると、`.git` の有無だけで判定していると親リポジトリを自分だと誤認し、
 * 親リポジトリに対して `git pull` を実行してしまう。これを防ぐため、git と判定するには
 * 「`.git` が存在する」だけでなく「`git rev-parse --show-toplevel` の結果が
 * インストールディレクトリと一致する」ことまで要求する。
 *
 * fs も git も呼ばない（測定値は呼び出し側から受け取る）。src/engine/self-update.js と同じ方針。
 */

import { resolve } from 'path';

/** 明示指定（env VK_ORCHESTRATOR_UPDATE_CHANNEL）で受け付ける値。 */
export const UPDATE_CHANNELS = ['git', 'zip', 'off'];

/** 配布 zip に同梱する「zip 展開環境の目印」ファイル名。 */
export const RELEASE_MARKER_FILENAME = 'release.json';

/**
 * パス比較用の正規化。末尾の区切り文字差だけで不一致になるのを防ぐ。
 * @param {string|null|undefined} p
 * @returns {string|null}
 */
function normalizePath(p) {
  if (typeof p !== 'string') return null;
  const trimmed = p.trim();
  if (trimmed === '') return null;
  return resolve(trimmed);
}

/**
 * アップデートの入手経路を決める。
 *
 * 優先順:
 *   1. env VK_ORCHESTRATOR_UPDATE_CHANNEL（git / zip / off）… 明示上書き・テストフック
 *   2. インストール直下の release.json が存在 → zip
 *   3. .git が存在し、かつ git の toplevel がインストールディレクトリと一致 → git
 *   4. どれでもない → unknown（更新を試みない）
 *
 * 受け付けない値が env に入っていた場合は「指定なし」として 2 以降の判定へ落とす
 * （タイプミスで起動が止まるより、実状態から判定するほうが安全）。
 *
 * @param {object} input
 * @param {string|null} [input.envChannel] env VK_ORCHESTRATOR_UPDATE_CHANNEL の生値
 * @param {boolean} [input.hasReleaseMarker] インストール直下に release.json があるか
 * @param {boolean} [input.hasGitDir] インストール直下に .git があるか
 * @param {string|null} [input.gitToplevel] `git rev-parse --show-toplevel` の結果（失敗時 null）
 * @param {string|null} [input.repoRoot] インストールディレクトリの絶対パス
 * @returns {{ channel: 'git'|'zip'|'off'|'unknown', reason: string }}
 */
export function resolveUpdateChannel({
  envChannel = null,
  hasReleaseMarker = false,
  hasGitDir = false,
  gitToplevel = null,
  repoRoot = null,
} = {}) {
  const explicit = String(envChannel ?? '').trim().toLowerCase();
  if (UPDATE_CHANNELS.includes(explicit)) {
    return { channel: explicit, reason: 'env-override' };
  }

  if (hasReleaseMarker) {
    return { channel: 'zip', reason: 'release-marker' };
  }

  if (hasGitDir) {
    const top = normalizePath(gitToplevel);
    const root = normalizePath(repoRoot);
    if (top === null) {
      // .git はあるが git が答えられない（git 未導入・壊れたリポジトリ等）。
      return { channel: 'unknown', reason: 'git-toplevel-unresolved' };
    }
    if (root === null) {
      return { channel: 'unknown', reason: 'install-dir-unresolved' };
    }
    if (top !== root) {
      // 親リポジトリの配下に zip を展開された状態。親に対して git 操作をしてはいけない。
      return { channel: 'unknown', reason: 'git-toplevel-mismatch' };
    }
    return { channel: 'git', reason: 'git-toplevel-match' };
  }

  return { channel: 'unknown', reason: 'no-marker' };
}
