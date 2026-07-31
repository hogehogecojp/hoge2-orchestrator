/**
 * buildPaneTitle のユニットテスト（issue #23）。
 *
 * ペインヘッダーに表示するタイトル・リンクを、元の作業対象 issue のもの／
 * task-queue メタ issue のもののどちらにするかを決める純粋関数。
 * 副作用が無いため build-command.js から直接 import して検証する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPaneTitle, stripControlChars } from '../src/engine/build-command.js';

const META_ISSUE = {
  number: 42,
  title: '[vk-blocks-pro] ボタンの余白を修正',
  html_url: 'https://github.com/vektor-inc/task-queue/issues/42',
};

// 期待値の変更（安藤レビュー / #263）: リンク先へタスク一意のフラグメントを足すようになった。
// 元 issue の URL だけだと、同じ元 issue を指すメタ issue が 2 つある場合に 2 つのペインの
// ヘッダーが同値になり、ペイン照合の identity として使えないため。
test('buildPaneTitle: resolvedTarget があれば元 issue の #番号 タイトルと、タスク一意の url を返す', () => {
  const resolvedTarget = {
    number: 123,
    title: 'ボタンの余白を修正',
    url: 'https://github.com/vektor-inc/vk-blocks-pro/issues/123',
  };
  const { titleText, url } = buildPaneTitle(META_ISSUE, resolvedTarget);
  assert.equal(titleText, '#123 ボタンの余白を修正', '表示テキストは変えない');
  assert.equal(url, 'https://github.com/vektor-inc/vk-blocks-pro/issues/123#vk-task-42');
});

// フラグメントなので、クリック時に開くページは元 issue のままで変わらない
// （存在しないアンカーはブラウザに無視され、ページ先頭が表示される）。
test('buildPaneTitle: 付与するのはフラグメントのみで、遷移先のページは元 issue のまま', () => {
  const resolvedTarget = {
    number: 123,
    title: 'ボタンの余白を修正',
    url: 'https://github.com/vektor-inc/vk-blocks-pro/issues/123',
  };
  const { url } = buildPaneTitle(META_ISSUE, resolvedTarget);
  const parsed = new URL(url);
  assert.equal(
    `${parsed.origin}${parsed.pathname}`,
    'https://github.com/vektor-inc/vk-blocks-pro/issues/123',
    'フラグメント以外は元 issue の URL と一致する'
  );
  assert.equal(parsed.hash, '#vk-task-42', 'メタ issue 番号でタスクを一意にする');
});

// メタ issue 経路は元々メタ issue 単位で一意なので、フラグメントを足す必要が無い。
test('buildPaneTitle: メタ issue 経路の url にはフラグメントを付けない', () => {
  const { url } = buildPaneTitle(META_ISSUE, null);
  assert.equal(url, 'https://github.com/vektor-inc/task-queue/issues/42');
  assert.ok(!url.includes('#'), '元々タスク一意なので加工しない');
});

test('buildPaneTitle: resolvedTarget が null ならメタ issue の #番号 タイトルと html_url を返す', () => {
  const { titleText, url } = buildPaneTitle(META_ISSUE, null);
  assert.equal(titleText, '#42 [vk-blocks-pro] ボタンの余白を修正');
  assert.equal(url, 'https://github.com/vektor-inc/task-queue/issues/42');
});

// -------------------------------------------------------
// 多層防御: 外部由来の issue タイトルに制御文字が混ざっていても
// titleText からは除去される（issue #25）。URL 側は触らない。
// -------------------------------------------------------
test('buildPaneTitle: resolvedTarget 経路で titleText の制御文字（C0/DEL/C1）を除去する', () => {
  const resolvedTarget = {
    number: 123,
    // ESC・BEL・NUL・C1(\x9f) を織り交ぜた悪意ある／壊れたタイトル
    title: 'ボタン\x1b]0;evil\x07の\x00余白\x9fを修正',
    url: 'https://github.com/vektor-inc/vk-blocks-pro/issues/123',
  };
  const { titleText, url } = buildPaneTitle(META_ISSUE, resolvedTarget);
  assert.equal(titleText, '#123 ボタン]0;evilの余白を修正');
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(titleText), `制御文字が残存: ${JSON.stringify(titleText)}`);
  // URL は制御文字除去の対象外（github.com 由来でスキーム検証済みのため触らない）。
  // 加工するのはタスク一意のフラグメント付与だけで、元の URL 部分はそのまま残す。
  assert.equal(url, 'https://github.com/vektor-inc/vk-blocks-pro/issues/123#vk-task-42');
});

test('buildPaneTitle: メタ issue 経路で titleText の制御文字（C0/DEL/C1）を除去する', () => {
  const metaIssue = {
    number: 42,
    title: '[vk-blocks-pro] ボタン\x1bの\x07余白\x7fを修正\x9f',
    html_url: 'https://github.com/vektor-inc/task-queue/issues/42',
  };
  const { titleText, url } = buildPaneTitle(metaIssue, null);
  assert.equal(titleText, '#42 [vk-blocks-pro] ボタンの余白を修正');
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(titleText), `制御文字が残存: ${JSON.stringify(titleText)}`);
  assert.equal(url, 'https://github.com/vektor-inc/task-queue/issues/42');
});

// -------------------------------------------------------
// 共通ヘルパー stripControlChars の単体テスト（buildPaneTitleSequence と共有）
// -------------------------------------------------------
test('stripControlChars: C0/DEL/C1 を除去し、通常文字は残す', () => {
  assert.equal(stripControlChars('あ\x00い\x1fう\x7fえ\x80お\x9fか'), 'あいうえおか');
  assert.equal(stripControlChars('safe text 123'), 'safe text 123');
});

test('stripControlChars: 文字列以外も文字列化して扱う', () => {
  assert.equal(stripControlChars(123), '123');
});
