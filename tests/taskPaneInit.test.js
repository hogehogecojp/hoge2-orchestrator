/**
 * 作業ペイン初期化の共通ヘルパー（src/engine/task-pane-init.js）のユニットテスト。
 *
 * 通常起動（startTask）とコンフリクト差し戻し（ensureConflictHandbackPane）で
 * ペインの初期化内容（タイトル・元 issue・PR URL）がずれたのが #258 の根本原因。
 * 両経路が同じヘルパーを通ることと、そのヘルパーが 3 点を揃えることを担保する。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  attachPrUrlToPane,
  openInitializedTaskPane,
  resolveTargetIssueForTitle,
} from '../src/engine/task-pane-init.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const META_ISSUE = {
  number: 581,
  title: '[vk-terminals] [ デザイン改善 ] 設定パネルの一部ボタン',
  body: 'https://github.com/vektor-inc/vk-terminals/issues/275',
  html_url: 'https://github.com/vektor-inc/task-queue/issues/581',
};
const RESOLVED = {
  owner: 'vektor-inc',
  repo: 'vk-terminals',
  number: 275,
  isSelf: false,
};
const PR_URL = 'https://github.com/vektor-inc/vk-terminals/pull/289';
const TITLE_URL = 'https://github.com/vektor-inc/vk-terminals/issues/275';

function createLogger() {
  const warnings = [];
  return { logger: { warn: (m) => warnings.push(m), log: () => {} }, warnings };
}

// -------------------------------------------------------
// (c) 元 issue の解決
// -------------------------------------------------------
describe('resolveTargetIssueForTitle', () => {
  it('元 issue を解決して { number, title, url } を返す', async () => {
    const calls = [];
    const target = await resolveTargetIssueForTitle(RESOLVED, {
      getIssueState: async (...args) => {
        calls.push(args);
        return { title: '移動先のタブに入力欄も説明も無い', htmlUrl: 'https://github.com/vektor-inc/vk-terminals/issues/275' };
      },
    });

    assert.deepEqual(target, {
      number: 275,
      title: '移動先のタブに入力欄も説明も無い',
      url: 'https://github.com/vektor-inc/vk-terminals/issues/275',
    });
    // タスク起動・差し戻しをブロックしないよう単発試行にする（リトライしない）
    assert.deepEqual(calls[0], ['vektor-inc', 'vk-terminals', 275, { retryDelays: [] }]);
  });

  it('メタ issue 自身が対象（isSelf）なら API を叩かず null を返す', async () => {
    let called = false;
    const target = await resolveTargetIssueForTitle(
      { owner: 'vektor-inc', repo: 'task-queue', number: 581, isSelf: true },
      { getIssueState: async () => { called = true; return {}; } }
    );

    assert.equal(target, null);
    assert.equal(called, false);
  });

  it('取得に失敗したら warn を出して null（メタ issue フォールバック）を返す', async () => {
    const { logger, warnings } = createLogger();
    const target = await resolveTargetIssueForTitle(RESOLVED, {
      getIssueState: async () => { throw new Error('rate limited'); },
      logTag: '[set-title]',
      logger,
    });

    assert.equal(target, null);
    assert.ok(warnings.some((w) => /元 issue 情報の取得失敗/.test(w)), JSON.stringify(warnings));
  });
});

// -------------------------------------------------------
// (a) PR URL の送り直し
// -------------------------------------------------------
describe('attachPrUrlToPane', () => {
  it('PR URL をペインへ送る', async () => {
    const calls = [];
    const sent = await attachPrUrlToPane({
      setTerminalPrUrl: async (...args) => { calls.push(args); return { ok: true }; },
      port: 13847,
      termId: 4,
      prUrl: PR_URL,
    });

    assert.equal(sent, true);
    assert.deepEqual(calls, [[13847, 4, PR_URL]]);
  });

  // 「空かどうか」の判定は trim 後、送信は未 trim だと、前後に空白の付いた値が
  // 空白込みで保存され、trim して比較する readPanePrUrl() と表現が食い違う。
  it('前後の空白を落として送る（判定と送信の基準を揃える）', async () => {
    const calls = [];
    await attachPrUrlToPane({
      setTerminalPrUrl: async (...args) => { calls.push(args); return { ok: true }; },
      port: 13847,
      termId: 4,
      prUrl: `  ${PR_URL}\n`,
    });

    assert.deepEqual(calls, [[13847, 4, PR_URL]]);
  });

  it('PR URL が無い・空文字なら送らない（PR ボタンを消してしまわない）', async () => {
    const calls = [];
    const setTerminalPrUrl = async (...args) => { calls.push(args); return { ok: true }; };

    for (const prUrl of [null, undefined, '', '   ']) {
      assert.equal(await attachPrUrlToPane({ setTerminalPrUrl, port: 13847, termId: 4, prUrl }), false);
    }
    assert.equal(calls.length, 0);
  });

  it('送信に失敗しても throw せず warn で握る（差し戻し本体を止めない）', async () => {
    const { logger, warnings } = createLogger();
    const sent = await attachPrUrlToPane({
      setTerminalPrUrl: async () => { throw new Error('ECONNREFUSED'); },
      port: 13847,
      termId: 4,
      prUrl: PR_URL,
      logTag: '[automerge] issue #581:',
      logger,
    });

    assert.equal(sent, false);
    assert.ok(warnings.some((w) => /PR URL 送信失敗/.test(w)), JSON.stringify(warnings));
  });
});

// -------------------------------------------------------
// 通常起動・差し戻し共通のペイン初期化
// -------------------------------------------------------
function createPaneHarness({ getIssueState, setTerminalPrUrl, createPane } = {}) {
  const paneCalls = [];
  const prUrlCalls = [];
  const order = [];
  const { logger, warnings } = createLogger();

  return {
    paneCalls,
    prUrlCalls,
    order,
    warnings,
    deps: {
      port: 13847,
      logger,
      // ペイン作成は termId と「実際にペインへ設定できたヘッダーリンク」を返す契約（#263）。
      createInitializedTaskPane: createPane ?? (async (args) => {
        paneCalls.push(args);
        order.push('create-pane');
        return { termId: 4, titleUrl: TITLE_URL };
      }),
      getIssueState: getIssueState ?? (async () => ({
        title: '移動先のタブに入力欄も説明も無い',
        htmlUrl: 'https://github.com/vektor-inc/vk-terminals/issues/275',
      })),
      setTerminalPrUrl: setTerminalPrUrl ?? (async (...args) => {
        prUrlCalls.push(args);
        order.push('set-pr-url');
        return { ok: true };
      }),
    },
  };
}

describe('openInitializedTaskPane', () => {
  it('差し戻し経路: 元 issue の resolvedTarget と PR URL を揃えてペインを初期化する', async () => {
    const h = createPaneHarness();

    const { termId, titleUrl } = await openInitializedTaskPane({
      issue: META_ISSUE,
      resolved: RESOLVED,
      cwd: '/tmp/worktree',
      prUrl: PR_URL,
      createdLogTag: '差し戻しペインを作成',
      titleLogTag: '差し戻しペインの',
      readyLogTag: '差し戻しペインの',
      ...h.deps,
    });

    assert.equal(termId, 4);
    // 設定できたヘッダーリンクを呼び出し側へ返す（state の paneTitleUrl に残すため。#263）
    assert.equal(titleUrl, TITLE_URL);
    assert.equal(h.paneCalls.length, 1);
    assert.deepEqual(h.paneCalls[0].resolvedTarget, {
      number: 275,
      title: '移動先のタブに入力欄も説明も無い',
      url: 'https://github.com/vektor-inc/vk-terminals/issues/275',
    });
    assert.equal(h.paneCalls[0].cwd, '/tmp/worktree');
    assert.deepEqual(h.prUrlCalls, [[13847, 4, PR_URL]]);
    // PR URL はペイン生成後にしか送れない（termId が要る）
    assert.deepEqual(h.order, ['create-pane', 'set-pr-url']);
  });

  it('通常起動経路: PR 未検知（prUrl 無し）なら PR URL は送らず、resolvedTarget だけ揃える', async () => {
    const h = createPaneHarness();

    const { termId } = await openInitializedTaskPane({
      issue: META_ISSUE,
      resolved: RESOLVED,
      cwd: '/tmp/repo',
      createdLogTag: '→ 新規ペイン作成',
      titleLogTag: '[set-title]',
      readyLogTag: '[ready]',
      ...h.deps,
    });

    assert.equal(termId, 4);
    assert.ok(h.paneCalls[0].resolvedTarget, '元 issue を解決して渡す');
    assert.equal(h.prUrlCalls.length, 0);
  });

  it('元 issue の取得に失敗しても resolvedTarget=null でペイン作成を続行する', async () => {
    const h = createPaneHarness({ getIssueState: async () => { throw new Error('404'); } });

    const { termId } = await openInitializedTaskPane({
      issue: META_ISSUE,
      resolved: RESOLVED,
      cwd: '/tmp/worktree',
      prUrl: PR_URL,
      ...h.deps,
    });

    assert.equal(termId, 4);
    assert.equal(h.paneCalls[0].resolvedTarget, null, 'メタ issue 表示へフォールバック');
    assert.deepEqual(h.prUrlCalls, [[13847, 4, PR_URL]], 'タイトル解決の失敗は PR URL 送信を止めない');
  });

  // PR URL の送信失敗がタイトル系の接頭辞（[set-title] 等）で出ると、ログから原因を
  // 辿るときに「タイトルの問題」と読み違える。
  it('PR URL の送信に失敗しても termId を返し、PR 用の接頭辞で warn する', async () => {
    const h = createPaneHarness({ setTerminalPrUrl: async () => { throw new Error('ECONNREFUSED'); } });

    const { termId } = await openInitializedTaskPane({
      issue: META_ISSUE,
      resolved: RESOLVED,
      cwd: '/tmp/worktree',
      prUrl: PR_URL,
      titleLogTag: '[automerge]: 差し戻しペインの',
      prUrlLogTag: '[automerge]: 差し戻しペインへの',
      ...h.deps,
    });

    assert.equal(termId, 4);
    const warned = h.warnings.filter((w) => /PR URL 送信失敗/.test(w));
    assert.equal(warned.length, 1, JSON.stringify(h.warnings));
    assert.match(warned[0], /差し戻しペインへの PR URL 送信失敗/);
  });

  it('ペイン作成の失敗は握らず呼び出し元へ伝える', async () => {
    const h = createPaneHarness({ createPane: async () => { throw new Error('create-pane failed'); } });

    await assert.rejects(
      () => openInitializedTaskPane({
        issue: META_ISSUE,
        resolved: RESOLVED,
        cwd: '/tmp/worktree',
        prUrl: PR_URL,
        ...h.deps,
      }),
      /create-pane failed/
    );
    assert.equal(h.prUrlCalls.length, 0);
  });
});

// -------------------------------------------------------
// 再発防止の蓋: createInitializedTaskPane を直接呼ぶ箇所を作らせない
//
// #258 は「通常起動と差し戻しでペインの初期化内容がずれた」ことが根本原因。
// 初期化内容が揃うこと自体は openInitializedTaskPane の振る舞いテスト（上）で担保済みで、
// ここで見るのは「その一本道を迂回する呼び出しが増えていないか」だけ。
// -------------------------------------------------------
describe('ペイン初期化の配線（src/engine/index.js）', () => {
  it('createInitializedTaskPane を直接呼ぶ箇所は無い（初期化はヘルパーに一本化）', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'engine', 'index.js'), 'utf8');

    // 定義そのものを取り除いてから呼び出しを数える。依存注入としての参照
    // （`createInitializedTaskPane,`）は括弧が続かないので拾わない。
    const declaration = /async function createInitializedTaskPane\s*\(/;
    assert.match(source, declaration, 'createInitializedTaskPane の定義が見つかりません');

    const directCalls = source.replace(declaration, 'async function __declared__(')
      .match(/createInitializedTaskPane\s*\(/g) ?? [];
    assert.deepEqual(directCalls, [], '呼び出し側は openInitializedTaskPane を使う');
  });
});
