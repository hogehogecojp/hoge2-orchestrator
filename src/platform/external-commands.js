// 外部コマンド（npm / bash）の起動方法を、プラットフォームごとに解決する。
//
// macOS / Linux では `spawn('npm', ...)` `spawn('bash', ...)` がそのまま動くので、
// 従来の呼び出しと 1 文字も変わらない値を返す。**Windows だけが例外**で、そこに必要な
// 迂回をこのモジュール 1 か所へ閉じ込める。
//
// なぜ Windows で必要か（どちらも実測で確認した挙動）:
//
// - `npm` / `npx` は実体が `.cmd` のシムで、`spawn` は拡張子を補って探さないため ENOENT になる。
//   さらに Node 20.12 以降は CVE-2024-27980 の対策として、`shell: false` のまま `.cmd` を
//   起動しようとすると EINVAL で弾く。つまり `spawn('npm.cmd', ...)` に書き換えても直らない。
//   `shell: true` を付ければ動くが、Node が DEP0190 で警告するとおり引数がエスケープされず
//   連結されるだけなので、空白や記号を含むパス（Windows の `C:\Users\...` では珍しくない）で
//   壊れる。**そこで npm の実体（npm-cli.js）を Node で直接実行する**。シェルを介さないので
//   引数はそのまま渡り、エスケープの問題自体が発生しない。
//
// - `bash` は Git for Windows に同梱されているが、PATH に載るのは `<Git>\cmd` だけで
//   `bash.exe` がある `<Git>\bin` は載らない。したがって `spawn('bash', ...)` は ENOENT になる。
//   vk-agents の展開は 1489 行の `sync.sh` が担っており Node への移植は現実的でないため、
//   **Git Bash の実行ファイルを探して絶対パスで起動する**。
//
// 副作用のある入力（platform / 実行ファイルの場所 / PATH / ファイルの有無）はすべて引数で
// 差し替えられるようにしてある（keep-awake.js と同じ方針。テストから実環境に触れずに検証する）。

import { existsSync as realExistsSync } from 'fs';
import { dirname, join, delimiter } from 'path';

/**
 * npm の起動方法を解決する。
 *
 * 呼び出し側は `spawn(command, [...prefixArgs, ...npmArgs], options)` の形で使う。
 * 非 Windows では `{ command: 'npm', prefixArgs: [] }` を返すので、展開しても従来と同じ呼び出しになる。
 *
 * Windows で npm-cli.js を見つけられなかった場合は `npm` へ倒し、`fallback: true` と
 * `hint`（利用者へ出す説明）を添える。ここで例外にはしない。npm が要るのは GUI 起動や
 * 導入といった一部の経路だけで、解決できないというだけで orchestrator 全体を止めると、
 * 影響のない機能まで巻き添えにしてしまうため。呼び出し側は失敗時に hint を出せばよい。
 *
 * @param {{ platform?: string, execPath?: string, fileExists?: (p: string) => boolean }} [options]
 *   execPath は Node 実行ファイルのパス（既定 process.execPath）。npm は Node の同梱物として
 *   `<node.exe と同じディレクトリ>\node_modules\npm\bin\npm-cli.js` に置かれる。この配置は
 *   公式インストーラだけでなく nvm-windows / fnm / volta のように node.exe ごと切り替える
 *   ツールでも共通なので、版を切り替えても「今動いている Node に対応した npm」が選ばれる。
 * @returns {{ command: string, prefixArgs: string[], fallback?: true, hint?: string }}
 */
export function resolveNpmLauncher({
  platform = process.platform,
  execPath = process.execPath,
  fileExists = realExistsSync,
} = {}) {
  if (platform !== 'win32') return { command: 'npm', prefixArgs: [] };

  const npmCli = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fileExists(npmCli)) return { command: execPath, prefixArgs: [npmCli] };

  return {
    command: 'npm',
    prefixArgs: [],
    fallback: true,
    hint:
      `npm の本体（${npmCli}）が見つかりませんでした。\n` +
      '  Windows では npm が .cmd のシムのため、この状態では起動に失敗します（ENOENT / EINVAL）。\n' +
      '  Node.js を公式インストーラ（または nvm-windows / fnm）で入れ直すと解決します。',
  };
}

/**
 * Windows で Git Bash（bash.exe）を探す既知の場所。
 *
 * PATH からの導出（`<Git>\cmd\git.exe` → `<Git>\bin\bash.exe`）で見つからなかったときの
 * 保険として使う。winget / 公式インストーラ（全ユーザー・ユーザー単位）の既定の配置を並べる。
 */
const WINDOWS_BASH_FALLBACK_DIRS = [
  'C:\\Program Files\\Git',
  'C:\\Program Files (x86)\\Git',
];

/**
 * PATH に載っている `git.exe` から Git のインストールディレクトリを推定する。
 *
 * Git for Windows は `<Git>\cmd\git.exe` を PATH に載せる（`<Git>\bin\git.exe` を載せる
 * 設定もある）。どちらの場合も 1 階層上が Git のルートなので、そこから `bin\bash.exe` を導く。
 * @param {string} pathEnv PATH 環境変数の値
 * @param {(p: string) => boolean} fileExists
 * @returns {string[]} 見つかった Git ルートの候補（重複なし・PATH の並び順）
 */
function gitRootsFromPath(pathEnv, fileExists) {
  const roots = [];
  for (const entry of String(pathEnv ?? '').split(delimiter)) {
    const dir = entry.trim().replace(/^"|"$/g, '');
    if (dir === '') continue;
    if (!fileExists(join(dir, 'git.exe'))) continue;
    const root = dirname(dir); // <Git>\cmd → <Git>
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

/**
 * bash の起動方法を解決する。
 *
 * 非 Windows では `{ command: 'bash' }` を返す（従来どおり PATH 解決に任せる）。
 * Windows では Git Bash の絶対パスを返し、見つからなければ `command: null` と hint を返す。
 * 呼び出し側は null のとき「何を入れれば直るか」を出して終われる（ENOENT のスタックを
 * 見せるより、Git for Windows の導入を案内するほうが打つ手が分かる）。
 *
 * 環境変数 `VK_BASH` で明示指定できる。Git を既定以外へ入れている場合や、MSYS2 / Cygwin の
 * bash を使いたい場合の逃げ道として用意する（存在確認は行い、無ければ探索へ進む）。
 *
 * @param {{ platform?: string, env?: object, fileExists?: (p: string) => boolean }} [options]
 * @returns {{ command: string, hint?: undefined } | { command: null, hint: string }}
 */
export function resolveBashLauncher({
  platform = process.platform,
  env = process.env,
  fileExists = realExistsSync,
} = {}) {
  if (platform !== 'win32') return { command: 'bash' };

  const override = String(env?.VK_BASH ?? '').trim();
  if (override !== '' && fileExists(override)) return { command: override };

  const candidates = [
    ...gitRootsFromPath(env?.PATH ?? env?.Path ?? '', fileExists),
    ...WINDOWS_BASH_FALLBACK_DIRS,
    // ユーザー単位インストール（管理者権限なしで入れた場合の既定）。
    ...(env?.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'Git')] : []),
  ].map((root) => join(root, 'bin', 'bash.exe'));

  for (const candidate of candidates) {
    if (fileExists(candidate)) return { command: candidate };
  }

  return {
    command: null,
    hint:
      'Windows で bash が見つかりませんでした。\n' +
      '  Git for Windows に同梱される Git Bash を使います（PATH には <Git>\\cmd しか載らないため、\n' +
      '  bash.exe は自動で探しています）。Git for Windows を導入するか、bash.exe の絶対パスを\n' +
      '  環境変数 VK_BASH に設定してください。',
  };
}

/**
 * Windows のパスを、Git Bash（MSYS2）へ引数として渡せる形へ整える。
 *
 * MSYS2 の bash はバックスラッシュをエスケープ文字として解釈しうるため、
 * `C:\Users\foo\sync.sh` をそのまま渡すと壊れる場合がある。スラッシュ区切り
 * （`C:/Users/foo/sync.sh`）なら MSYS2 側がドライブレターごと解釈できる。
 *
 * 非 Windows では何もしない（POSIX のパスに `\` が含まれていても、それは
 * ファイル名の一部として正当なため、置き換えてはいけない）。
 * @param {string} filePath
 * @param {string} [platform]
 * @returns {string}
 */
export function toBashPath(filePath, platform = process.platform) {
  if (platform !== 'win32') return filePath;
  return String(filePath).replace(/\\/g, '/');
}
