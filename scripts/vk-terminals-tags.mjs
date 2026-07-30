/**
 * vk-terminals-tags.mjs
 *
 * vk-terminals のリモートタグ解決を共通化するヘルパー。
 * bump-vk-terminals.mjs（手動 bump）と bin/vk-orchestrator.js の up 起動時
 * 自動追従の双方から利用する。
 */

import { execFileSync } from 'child_process';

export const REPO_URL = 'https://github.com/vektor-inc/vk-terminals.git';

/**
 * リモート照会の待ち時間の上限（ミリ秒）。
 *
 * `git ls-remote` は「応答しないリモート」や「認証を求められる非公開リポジトリ」に対して
 * 既定では無制限に待つ。この関数は up 起動時の版確認から呼ばれるため、待ち続けると
 * アプリの起動そのものが進まなくなる。呼び出し側は例外を捕まえて現行版で起動を続けるので、
 * 上限に達したら打ち切って throw させるのが正しい。
 */
export const FETCH_TAGS_TIMEOUT_MS = 15_000;

/**
 * 認証情報の入力を一切求めさせないための環境変数。
 *
 * リポジトリが非公開になった場合や認証情報が無い環境では、git が
 * 「ユーザー名／パスワードを入力してください」の対話待ちに入り、起動処理が固まる
 * （`GIT_TERMINAL_PROMPT=0` は端末プロンプトを、`GIT_ASKPASS` / `SSH_ASKPASS` を空にすることで
 * 外部の入力ダイアログ呼び出しを止める）。待つのではなく即座に失敗させ、
 * 呼び出し側のフォールバック（現行版で起動）へ落とす。
 */
export const NON_INTERACTIVE_GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  SSH_ASKPASS_REQUIRE: 'never',
};

/**
 * リモートの全タグ → commit SHA のマップ。annotated タグは ^{} の
 * dereference 済み commit を優先する（lightweight タグはそのまま）。
 *
 * 待ち時間の上限（既定 15 秒）と認証プロンプトの抑止を既定で掛ける。どちらも options で
 * 上書きできる（`timeout` / `env`）ので、テストや特殊な呼び出しからは従来どおり調整できる。
 *
 * @param {string} repoUrl
 * @param {import('child_process').ExecFileSyncOptions} options 信頼できる内部呼び出し由来の値のみを渡すこと。外部入力を渡さない。
 * @returns {Map<string, string>}
 */
export function fetchTags(repoUrl = REPO_URL, options = {}) {
  const { env: envOverride, ...rest } = options;
  const out = execFileSync('git', ['ls-remote', '--tags', repoUrl], {
    encoding: 'utf8',
    timeout: FETCH_TAGS_TIMEOUT_MS,
    // 標準入力を閉じ、対話入力の経路自体を与えない（プロンプト抑止の多層防御）。
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...NON_INTERACTIVE_GIT_ENV, ...(envOverride ?? {}) },
    // timeout / stdio も呼び出し側から上書きできるよう、既定より後に展開する。
    ...rest,
  });
  return parseLsRemoteTags(out);
}

/**
 * `git ls-remote --tags` の出力をタグ → commit SHA のマップに変換する。
 *
 * 同期版（fetchTags）と非同期版（常駐ループから呼ぶ経路）で同じ解釈を使うために切り出す。
 * @param {string} out
 * @returns {Map<string, string>}
 */
export function parseLsRemoteTags(out) {
  const map = new Map();
  for (const line of String(out ?? '').split('\n')) {
    const m = line.match(/^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/);
    if (!m) continue;
    const [, sha, tag, deref] = m;
    if (deref || !map.has(tag)) map.set(tag, sha);
  }
  return map;
}

// "1.5.0" / "v1.1.0" → [1,5,0]。semver でなければ null。
export function toTuple(tag) {
  const m = tag.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function cmpTuple(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// タグマップから最新の semver タグ文字列を返す。無ければ null。
export function latestSemverTag(tags) {
  const semver = [...tags.keys()]
    .map(t => ({ t, tup: toTuple(t) }))
    .filter(x => x.tup)
    .sort((a, b) => cmpTuple(a.tup, b.tup));
  return semver.at(-1)?.t ?? null;
}
