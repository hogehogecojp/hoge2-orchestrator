/**
 * resolveNpmLauncher / resolveBashLauncher / toBashPath のユニットテスト。
 *
 * platform / execPath / env / ファイルの有無をすべて依存注入し、実環境（実際の Node の
 * 配置や Git のインストール状況）に触れずに検証する。開発機の状態でテストの結果が変わると
 * 「macOS の CI では通るが Windows の手元では落ちる」の裏返しを作ってしまうため。
 *
 * カバーするケース:
 *   - 非 Windows は従来どおり 'npm' / 'bash' をそのまま返す（既存の呼び出しと 1 文字も変えない）
 *   - Windows は npm-cli.js を Node で直接実行する形に変換する
 *   - Windows で npm-cli.js が見つからない場合は fallback フラグと案内を返し、例外にしない
 *   - Windows の bash は PATH の git.exe から導出 → 既知の場所 → VK_BASH の順で解決する
 *   - Windows で bash が見つからない場合は command: null と案内を返す
 *   - toBashPath は Windows でだけ区切りをスラッシュへ倒す
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  resolveNpmLauncher,
  resolveBashLauncher,
  toBashPath,
} from '../src/platform/external-commands.js';

// 指定した絶対パスだけが存在する fileExists を作る（実ファイルシステムを見に行かない）。
function fileExistsFor(...present) {
  const set = new Set(present);
  return (p) => set.has(p);
}

const WIN_NODE = 'C:\\Program Files\\nodejs\\node.exe';
const WIN_NPM_CLI = join('C:\\Program Files\\nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js');

describe('resolveNpmLauncher', () => {
  it('非 Windows では npm をそのまま返す（従来の呼び出しと同じ）', () => {
    for (const platform of ['darwin', 'linux']) {
      const r = resolveNpmLauncher({ platform, execPath: '/usr/local/bin/node' });
      assert.deepEqual(r, { command: 'npm', prefixArgs: [] });
    }
  });

  it('Windows では node.exe で npm-cli.js を直接実行する形に変換する', () => {
    const r = resolveNpmLauncher({
      platform: 'win32',
      execPath: WIN_NODE,
      fileExists: fileExistsFor(WIN_NPM_CLI),
    });
    assert.equal(r.command, WIN_NODE);
    assert.deepEqual(r.prefixArgs, [WIN_NPM_CLI]);
    // 解決できたときは fallback / hint を生やさない（呼び出し側が余計な警告を出さないため）。
    assert.equal(r.fallback, undefined);
    assert.equal(r.hint, undefined);
  });

  it('Windows で npm-cli.js が見つからなければ fallback と案内を返す（例外にしない）', () => {
    const r = resolveNpmLauncher({
      platform: 'win32',
      execPath: WIN_NODE,
      fileExists: () => false,
    });
    assert.equal(r.command, 'npm');
    assert.deepEqual(r.prefixArgs, []);
    assert.equal(r.fallback, true);
    assert.match(r.hint, /npm の本体/);
    // 探した場所を伝える（利用者が自分の環境と突き合わせられるようにする）。
    assert.ok(r.hint.includes(WIN_NPM_CLI));
  });

  it('Node の版を切り替えても、今動いている node.exe の隣の npm を選ぶ', () => {
    // nvm-windows / fnm は node.exe ごとディレクトリを差し替えるので、execPath 起点で
    // 解決していれば版の切り替えに自動で追従する。
    const fnmNode = 'C:\\Users\\me\\AppData\\Roaming\\fnm\\node-versions\\v20.18.2\\installation\\node.exe';
    const fnmNpm = join(
      'C:\\Users\\me\\AppData\\Roaming\\fnm\\node-versions\\v20.18.2\\installation',
      'node_modules', 'npm', 'bin', 'npm-cli.js',
    );
    const r = resolveNpmLauncher({
      platform: 'win32',
      execPath: fnmNode,
      // 公式インストーラ側の npm も存在するが、選ばれるのは execPath の隣であること。
      fileExists: fileExistsFor(fnmNpm, WIN_NPM_CLI),
    });
    assert.deepEqual(r.prefixArgs, [fnmNpm]);
  });
});

describe('resolveBashLauncher', () => {
  it('非 Windows では bash をそのまま返す（PATH 解決に任せる）', () => {
    for (const platform of ['darwin', 'linux']) {
      assert.deepEqual(resolveBashLauncher({ platform, env: {} }), { command: 'bash' });
    }
  });

  it('Windows では PATH の git.exe から bash.exe を導出する', () => {
    // Git for Windows が PATH に載せるのは <Git>\cmd だけで、bash.exe がある <Git>\bin は載らない。
    const r = resolveBashLauncher({
      platform: 'win32',
      env: { PATH: ['C:\\Windows\\system32', 'C:\\Tools\\Git\\cmd'].join(';') },
      fileExists: fileExistsFor('C:\\Tools\\Git\\cmd\\git.exe', 'C:\\Tools\\Git\\bin\\bash.exe'),
    });
    assert.equal(r.command, 'C:\\Tools\\Git\\bin\\bash.exe');
  });

  it('Windows で PATH から導出できなければ既定のインストール先を探す', () => {
    const r = resolveBashLauncher({
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\system32' },
      fileExists: fileExistsFor('C:\\Program Files\\Git\\bin\\bash.exe'),
    });
    assert.equal(r.command, 'C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('Windows でユーザー単位インストール（LOCALAPPDATA）も探す', () => {
    const localAppData = 'C:\\Users\\me\\AppData\\Local';
    const bash = join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe');
    const r = resolveBashLauncher({
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\system32', LOCALAPPDATA: localAppData },
      fileExists: fileExistsFor(bash),
    });
    assert.equal(r.command, bash);
  });

  it('VK_BASH の明示指定は探索より優先する（既定以外へ入れている場合の逃げ道）', () => {
    const r = resolveBashLauncher({
      platform: 'win32',
      env: { VK_BASH: 'D:\\msys64\\usr\\bin\\bash.exe', PATH: 'C:\\Tools\\Git\\cmd' },
      fileExists: fileExistsFor(
        'D:\\msys64\\usr\\bin\\bash.exe',
        'C:\\Tools\\Git\\cmd\\git.exe',
        'C:\\Tools\\Git\\bin\\bash.exe',
      ),
    });
    assert.equal(r.command, 'D:\\msys64\\usr\\bin\\bash.exe');
  });

  it('VK_BASH が存在しないパスなら無視して探索へ進む（設定ミスで詰ませない）', () => {
    const r = resolveBashLauncher({
      platform: 'win32',
      env: { VK_BASH: 'D:\\nope\\bash.exe', PATH: 'C:\\Windows\\system32' },
      fileExists: fileExistsFor('C:\\Program Files\\Git\\bin\\bash.exe'),
    });
    assert.equal(r.command, 'C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('Windows で bash が見つからなければ command: null と導入案内を返す', () => {
    const r = resolveBashLauncher({
      platform: 'win32',
      env: { PATH: 'C:\\Windows\\system32' },
      fileExists: () => false,
    });
    assert.equal(r.command, null);
    assert.match(r.hint, /Git for Windows/);
    assert.match(r.hint, /VK_BASH/);
  });
});

describe('toBashPath', () => {
  it('Windows では区切りをスラッシュへ倒す（MSYS2 の bash が解釈できる形）', () => {
    assert.equal(
      toBashPath('C:\\Users\\me\\vendor\\scripts\\sync.sh', 'win32'),
      'C:/Users/me/vendor/scripts/sync.sh',
    );
  });

  it('非 Windows では何もしない（POSIX ではバックスラッシュもファイル名の一部）', () => {
    assert.equal(toBashPath('/home/me/odd\\name.sh', 'linux'), '/home/me/odd\\name.sh');
  });
});
