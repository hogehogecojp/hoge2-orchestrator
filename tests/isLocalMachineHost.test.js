/**
 * VK Terminals host がこのマシン自身を指すかどうかの判定テスト。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'os';

import { isLocalMachineHost } from '../src/engine/local-machine-host.js';

test('isLocalMachineHost: 非ループバックでも自マシン IP なら true を返す', () => {
  assert.equal(
    isLocalMachineHost('100.121.46.76', ['127.0.0.1', '100.121.46.76']),
    true,
  );
});

test('isLocalMachineHost: ループバックは localAddresses に依らず true を返す', () => {
  assert.equal(isLocalMachineHost('127.0.0.1', []), true);
  assert.equal(isLocalMachineHost('localhost', []), true);
  assert.equal(isLocalMachineHost('::1', []), true);
  assert.equal(isLocalMachineHost('[::1]', []), true);
});

test('isLocalMachineHost: 別マシンの IP は false を返す', () => {
  assert.equal(
    isLocalMachineHost('203.0.113.10', ['127.0.0.1', '100.121.46.76']),
    false,
  );
});

test('isLocalMachineHost: IPv6 の角括弧とゾーン ID を正規化して比較する', () => {
  assert.equal(
    isLocalMachineHost('[fd7a:115c:a1e0::7537:2e4d]', ['fd7a:115c:a1e0::7537:2e4d']),
    true,
  );
  assert.equal(
    isLocalMachineHost('fe80::1%en0', ['fe80::1']),
    true,
  );
  assert.equal(
    isLocalMachineHost('[fe80::1%en0]', ['fe80::1%lo0']),
    true,
  );
});

test('isLocalMachineHost: 大文字と前後空白を正規化して比較する', () => {
  assert.equal(
    isLocalMachineHost('  EXAMPLE.LOCAL  ', ['example.local']),
    true,
  );
  assert.equal(
    isLocalMachineHost('  FD7A:115C:A1E0::7537:2E4D  ', ['fd7a:115c:a1e0::7537:2e4d']),
    true,
  );
});

// --- 自マシンの「ホスト名」で書かれた apiHost（issue #256-1）---

test('isLocalMachineHost: 自マシンのホスト名（.local / MagicDNS 名）は true を返す', () => {
  // apiHost には IP だけでなく `mymac.local`（mDNS）や `mymac.tailXXXX.ts.net`
  // （Tailscale MagicDNS）も書ける。アドレスとしか照合しないと自分のマシンを
  // 「別マシン」と誤判定し、doctor の claude 要件が任意へ落ちて #247 が再発する。
  const localAddresses = ['127.0.0.1', '100.64.0.2'];
  // os.hostname() は環境により短縮名／FQDN のどちらも返しうるので、両方を検証する。
  for (const localHostnames of [['mymac'], ['mymac.local']]) {
    for (const host of ['mymac.local', 'mymac.tail1234.ts.net', '  MyMac.Local  ', 'mymac']) {
      assert.equal(
        isLocalMachineHost(host, localAddresses, localHostnames),
        true,
        `${host}（自マシン名 ${localHostnames[0]}）は手元扱い`,
      );
    }
  }
});

test('isLocalMachineHost: 先頭ラベルが違う別マシンのホスト名は false を返す', () => {
  for (const host of ['other.local', 'other.tail1234.ts.net', 'mymac2.local']) {
    assert.equal(
      isLocalMachineHost(host, ['127.0.0.1'], ['mymac.local']),
      false,
      `${host} は別マシン扱い`,
    );
  }
});

test('isLocalMachineHost: 先頭ラベルが同じでも外部ドメインの名前は false を返す', () => {
  // ここが緩いと、接続先に別マシンの FQDN を書いた構成で判定が手元に倒れ、
  // engine（resolveTaskPaneCwd）が手元のリポジトリの絶対パスを接続先へ渡してしまう。
  // 接続先に同じ絶対パスがあると、意図しないクローンで Claude Code が起動する。
  // `mymac.evil-ts.net` は MagicDNS の判定が endsWith('ts.net')（ドット無し）に書き換わると
  // 通ってしまう。ラベル境界を見ていることをテストで固定する。
  for (const host of ['mymac.example.com', 'mymac.attacker.tld', 'mymac.ts.net.evil.example', 'mymac.evil-ts.net']) {
    assert.equal(
      isLocalMachineHost(host, ['127.0.0.1'], ['mymac.local']),
      false,
      `${host} は別マシン扱い`,
    );
  }
  // コンテナ等で os.hostname() が `localhost` になる環境。`localhost.` で始まる
  // 外部ドメインを手元と読ませない。
  assert.equal(isLocalMachineHost('localhost.evil.example', ['127.0.0.1'], ['localhost']), false);
  // 接続先が別マシンの FQDN（手元 `ubuntu` / 接続先 `ubuntu.vps.example.com`）の再現。
  assert.equal(isLocalMachineHost('ubuntu.vps.example.com', ['127.0.0.1'], ['ubuntu']), false);
});

test('isLocalMachineHost: 自マシン名が社内 FQDN でも .local 名の接続先は true を返す', () => {
  // ローカルスコープの制限は host（apiHost）側にだけ掛ける。自マシン名の側にも掛けると、
  // os.hostname() が社内ドメインの FQDN を返す環境で正当な構成が落ちる。
  const localHostnames = ['mymac.corp.example.com'];
  assert.equal(isLocalMachineHost('mymac.local', ['127.0.0.1'], localHostnames), true);
  assert.equal(isLocalMachineHost('mymac', ['127.0.0.1'], localHostnames), true);
  assert.equal(isLocalMachineHost('mymac.tail1234.ts.net', ['127.0.0.1'], localHostnames), true);
  // 完全一致は従来どおり通る（社内 FQDN をそのまま書いた場合）。
  assert.equal(isLocalMachineHost('mymac.corp.example.com', ['127.0.0.1'], localHostnames), true);
  // 一方で、同じ社内ドメインの別ホスト名は手元ではない。
  assert.equal(isLocalMachineHost('other.corp.example.com', ['127.0.0.1'], localHostnames), false);
});

test('isLocalMachineHost: 末尾ドット付きの FQDN 表記も同じマシンとして扱う', () => {
  // `mymac.local.` は正規の書き方。末尾ドットを残すと完全一致に失敗し、
  // ローカルスコープ判定でも suffix が `local.` になって許可リストを外れる。
  assert.equal(isLocalMachineHost('mymac.local.', ['127.0.0.1'], ['mymac.local']), true);
  assert.equal(isLocalMachineHost('mymac.local.', ['127.0.0.1'], ['mymac']), true);
  assert.equal(isLocalMachineHost('mymac.local.', ['127.0.0.1'], ['mymac.local.']), true);
  // 絞り込みは効いたままであること。
  assert.equal(isLocalMachineHost('mymac.example.com.', ['127.0.0.1'], ['mymac.local']), false);
});

test('isLocalMachineHost: IP アドレス表記には先頭ラベル比較を掛けない', () => {
  // 先頭ラベル比較を無条件に掛けると `203.0.113.10` と `203.0.113.99` が
  // 「どちらも 203」で一致してしまう。ドット区切りの数値は名前ではないので除外する。
  assert.equal(
    isLocalMachineHost('203.0.113.10', ['127.0.0.1'], ['203.0.113.99']),
    false,
  );
});

test('isLocalMachineHost: 既定では os.hostname() を自マシン名として使う（engine の実行経路）', () => {
  // engine（resolveTaskPaneCwd）は localAddresses も localHostnames も渡さず呼ぶ。
  // 既定値の側でホスト名を集めないと、engine ではこの修正が効かない。
  const selfHostname = hostname();
  assert.equal(isLocalMachineHost(selfHostname), true);
  // 先頭ラベルだけを書いた場合（`mymac.local` に対する `mymac`）も手元と判定する。
  assert.equal(isLocalMachineHost(String(selfHostname).split('.')[0]), true);
});

// --- ループバック範囲・全アドレス束縛（issue #256-2）---

test('isLocalMachineHost: 127.0.0.0/8 と IPv4 射影ループバックは true を返す', () => {
  // doctor 側（LOOPBACK_V4_PATTERN）と解釈を揃える。127.0.1.1 は Debian 系が
  // 自ホスト名へ割り当てる表記で、これを別マシンと読むと 2 か所で結論が割れる。
  for (const host of ['127.0.1.1', '127.255.255.254', '::ffff:127.0.0.1', '::FFFF:127.0.1.1']) {
    assert.equal(isLocalMachineHost(host, []), true, `${host} は手元扱い`);
  }
});

test('isLocalMachineHost: オクテットが範囲外の値はループバック扱いしない', () => {
  // `/^127\./` のような文字列パターンは各オクテットの範囲を見ないため 127.0.0.256 まで
  // 通してしまう。この値は IP リテラルではなくホスト名として名前解決され、任意の宛先へ
  // 行きうるので「ループバックのつもりで別マシン」という取り違えが成立する。
  for (const host of ['127.0.0.256', '127.0.0.1.5', '127.0.0']) {
    assert.equal(isLocalMachineHost(host, []), false, `${host} はループバック扱いしない`);
  }
});

test('isLocalMachineHost: 正規でない書き方の IPv6 ループバックも true を返す', () => {
  // 文字列の見た目で比べると同じアドレスの別表記を取りこぼし、「手元なのに別マシン」と
  // 読んで claude 要件が任意へ落ちる（issue #247 が再発する向き）。
  for (const host of ['0:0:0:0:0:0:0:1', '::0001', '::ffff:7f00:1', '::ffff:127.0.1.1', '[0:0:0:0:0:0:0:1]']) {
    assert.equal(isLocalMachineHost(host, []), true, `${host} は手元扱い`);
  }
  // 別アドレスまで巻き込まないこと。
  for (const host of ['::2', '::ffff:203.0.113.10', 'fd7a:115c:a1e0::1']) {
    assert.equal(isLocalMachineHost(host, []), false, `${host} は別マシン扱い`);
  }
});

test('isLocalMachineHost: 全アドレス束縛（0.0.0.0 / ::）は true を返す', () => {
  // どの NIC で受けても待ち受けているのは手元のプロセス。
  for (const host of ['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0']) {
    assert.equal(isLocalMachineHost(host, []), true, `${host} は手元扱い`);
  }
});

test('isLocalMachineHost: 空文字は false のまま（安全側の既定）', () => {
  // doctor は「判断できない値は必須側へ倒す」ため空文字を true にするが、それは
  // doctor 固有のフェイルセーフ。共有ヘルパ側は false（＝手元と断定しない）に保つ。
  // 現状 engine が空文字を渡す経路は無い（resolveVkTerminalsApiHost() が 127.0.0.1 へ
  // フォールバックする）が、渡された場合の安全側の既定としてここで固定する。
  assert.equal(isLocalMachineHost('', ['127.0.0.1']), false);
  assert.equal(isLocalMachineHost('   ', ['127.0.0.1']), false);
  assert.equal(isLocalMachineHost(undefined, ['127.0.0.1']), false);
});
