/**
 * VK Terminals HTTP API 呼び出しのタイムアウト（issue #218）のユニットテスト。
 *
 * VK Terminals が無応答（Tailscale IP 未接続・GUI ハング・別マシンの API へ到達不能）だと
 * `fetch` は既定で永久に待つため、打ち切り時間が無い関数は呼び出し側（約 2 秒間隔の
 * ポーリング tick や `up` の起動フロー）ごと固まる。ここでは全 API 呼び出しが
 * `AbortSignal.timeout()` 由来の signal を渡していること、および既定値と
 * `timeoutMs` オプションでの上書きが効くことを検証する。
 *
 * 検証方法: `AbortSignal.timeout` を差し替えて「実際に何 ms で組み立てたか」を記録する。
 * 実時間の経過を待たずに既定値・上書き値をそのまま突き合わせられるため、
 * タイミング依存でフレーキーにならない。
 *
 * **このファイルは独立したテストファイルであることが前提。** `AbortSignal.timeout` は
 * グローバルの静的メソッドなので、差し替えている間は同じプロセスで走る他のコードにも影響する
 * （node --test はファイル単位で別プロセスに分けるため、他の *.test.js には波及しない）。
 * ここへ別関心のテストを相乗りさせたり、この差し替えを他ファイルへ持ち出したりしないこと。
 * afterEach で必ず元に戻している。
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkHealth,
  createNewPane,
  fetchHealth,
  getStates,
  postMenu,
  sendToTerminal,
  setExternalWaiting,
  setPaneLock,
  setTerminalPrUrl,
  setTerminalTitle,
} from '../src/terminals/index.js';

const PORT   = 13847;
const TERMID = 'term-1';

let originalFetch;
let originalTimeout;
let originalTimeoutScale;
/** @type {Array<{url:string, init:object|undefined}>} */
let requests;
/** @type {number[]} AbortSignal.timeout() に渡された ms の記録（呼ばれた順） */
let timeoutArgs;

/** 全エンドポイントに ok:true を返す既定モック。states だけ terminals を返す。 */
function okResponse(url) {
  const u = String(url);
  if (u.endsWith('/api/states')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ terminals: { [TERMID]: { termId: TERMID, apiTitle: 'T', apiUrl: 'U' } } }),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, termId: 'term-9' }),
  };
}

beforeEach(() => {
  originalFetch   = global.fetch;
  originalTimeout = AbortSignal.timeout;
  originalTimeoutScale = process.env.VK_TERMINALS_TIMEOUT_SCALE;
  delete process.env.VK_TERMINALS_TIMEOUT_SCALE;
  requests   = [];
  timeoutArgs = [];

  AbortSignal.timeout = (ms) => {
    timeoutArgs.push(ms);
    // 実際の signal を返す（呼び出し側が signal として使えることまで担保する）。
    // テスト中に発火してほしくないので大きめの値へ置き換える。
    return originalTimeout.call(AbortSignal, 60_000);
  };

  global.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return okResponse(url);
  };
});

afterEach(() => {
  global.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  if (originalTimeoutScale === undefined) delete process.env.VK_TERMINALS_TIMEOUT_SCALE;
  else process.env.VK_TERMINALS_TIMEOUT_SCALE = originalTimeoutScale;
});

// 各 API の「関数 / 既定 timeout / 呼び出し方」表。
// 既定値の根拠は backend-vk-terminals.js の JSDoc を参照。
const CASES = [
  {
    name:        'fetchHealth',
    endpoint:    '/api/health',
    defaultMs:   3_000,
    call:        (options) => fetchHealth(PORT, options),
  },
  {
    name:        'checkHealth',
    endpoint:    '/api/health',
    defaultMs:   3_000,
    call:        (options) => checkHealth(PORT, options),
  },
  {
    name:        'getStates',
    endpoint:    '/api/states',
    defaultMs:   5_000,
    call:        (options) => getStates(PORT, options),
  },
  {
    name:        'createNewPane',
    endpoint:    '/api/new-pane',
    defaultMs:   10_000,
    call:        (options) => createNewPane(PORT, '/work/dir', { noClaude: true, ...options }),
  },
  {
    name:        'sendToTerminal',
    endpoint:    '/api/send',
    defaultMs:   3_000,
    call:        (options) => sendToTerminal(PORT, TERMID, 'hello', options),
  },
  {
    name:        'setTerminalTitle',
    endpoint:    '/api/set-title',
    defaultMs:   3_000,
    call:        (options) => setTerminalTitle(PORT, TERMID, 'title', null, options),
  },
  {
    name:        'setExternalWaiting',
    endpoint:    '/api/set-status',
    defaultMs:   3_000,
    call:        (options) => setExternalWaiting(PORT, TERMID, true, options),
  },
  {
    name:        'setPaneLock',
    endpoint:    '/api/set-lock',
    defaultMs:   3_000,
    call:        (options) => setPaneLock(PORT, TERMID, { close: false }, options),
  },
  {
    name:        'postMenu',
    endpoint:    '/api/menu',
    defaultMs:   3_000,
    call:        (options) => postMenu(PORT, { source: 'test', title: 'Test', items: [] }, options),
  },
];

for (const { name, endpoint, defaultMs, call } of CASES) {
  test(`${name}: fetch に AbortSignal.timeout 由来の signal を渡す`, async () => {
    await call(undefined);

    const req = requests.find(r => r.url.endsWith(endpoint));
    assert.ok(req, `${endpoint} が呼ばれる`);
    assert.ok(req.init?.signal instanceof AbortSignal, `${name} は timeout 用の AbortSignal を渡す`);
  });

  test(`${name}: timeoutMs の既定値は ${defaultMs}ms`, async () => {
    await call(undefined);

    assert.deepEqual(timeoutArgs, [defaultMs]);
  });

  test(`${name}: timeoutMs オプションで打ち切り時間を上書きできる`, async () => {
    process.env.VK_TERMINALS_TIMEOUT_SCALE = '2';
    await call({ timeoutMs: 1_234 });

    assert.deepEqual(timeoutArgs, [1_234]);
  });

  test(`${name}: 全体倍率 2 で既定の打ち切り時間だけを 2 倍にする`, async () => {
    process.env.VK_TERMINALS_TIMEOUT_SCALE = '2';
    await call(undefined);

    assert.deepEqual(timeoutArgs, [defaultMs * 2]);
  });
}

// setTerminalPrUrl は set-title の前に getStates で現在の apiTitle / apiUrl を取り直すため、
// 1 回の呼び出しで 2 本の HTTP リクエストが走る。片方だけに timeout が付いていると
// 合計待ち時間が無限になりうるので、両方に同じ打ち切り時間が伝播することを確認する。
test('setTerminalPrUrl: 内部の getStates と set-title の両方に signal を渡す', async () => {
  await setTerminalPrUrl(PORT, TERMID, 'https://example.test/pr/1');

  const states = requests.find(r => r.url.endsWith('/api/states'));
  const title  = requests.find(r => r.url.endsWith('/api/set-title'));
  assert.ok(states?.init?.signal instanceof AbortSignal, 'getStates 側に signal を渡す');
  assert.ok(title?.init?.signal instanceof AbortSignal, 'set-title 側に signal を渡す');
});

test('setTerminalPrUrl: timeoutMs の既定値は 3000ms で、内部の getStates にも伝播する', async () => {
  await setTerminalPrUrl(PORT, TERMID, 'https://example.test/pr/1');

  assert.deepEqual(timeoutArgs, [3_000, 3_000]);
});

test('setTerminalPrUrl: 全体倍率は一度だけ掛け、解決済みの値を内部の getStates に伝播する', async () => {
  process.env.VK_TERMINALS_TIMEOUT_SCALE = '2';
  await setTerminalPrUrl(PORT, TERMID, 'https://example.test/pr/1');

  assert.deepEqual(timeoutArgs, [6_000, 6_000]);
});

test('setTerminalPrUrl: timeoutMs を上書きすると内部の getStates にも同じ値が伝播する', async () => {
  process.env.VK_TERMINALS_TIMEOUT_SCALE = '2';
  await setTerminalPrUrl(PORT, TERMID, 'https://example.test/pr/1', { timeoutMs: 1_234 });

  assert.deepEqual(timeoutArgs, [1_234, 1_234]);
});

test('setTerminalPrUrl: timeoutMs を渡しても prMerged の既定 false は変わらない', async () => {
  await setTerminalPrUrl(PORT, TERMID, 'https://example.test/pr/1', { timeoutMs: 1_234 });

  const title = requests.find(r => r.url.endsWith('/api/set-title'));
  assert.equal(JSON.parse(title.init.body).prMerged, false);
});

test('小数倍率を掛けた打ち切り時間はミリ秒の整数へ四捨五入する', async () => {
  process.env.VK_TERMINALS_TIMEOUT_SCALE = '1.2345';
  await getStates(PORT);

  assert.deepEqual(timeoutArgs, [6_173]);
});

test('不正な倍率でも既定の打ち切り時間は変わらない', async () => {
  process.env.VK_TERMINALS_TIMEOUT_SCALE = 'abc';
  await getStates(PORT);

  assert.deepEqual(timeoutArgs, [5_000]);
});

test('極小の正数を指定しても解決後の打ち切り時間は必ず 1ms 以上になる', async () => {
  process.env.VK_TERMINALS_TIMEOUT_SCALE = '1e-9';
  await fetchHealth(PORT);

  assert.equal(timeoutArgs.length, 1);
  assert.ok(timeoutArgs[0] >= 1);
});

// 上のテスト群は「何 ms で signal を組み立てたか」までを見る。ここでは実物の
// AbortSignal.timeout に戻して「打ち切りが本当に効いて reject する」ところまで通し、
// 呼び出し側（try/catch で warn する各スキャナ）が受け取るエラーの形（name）を固定する。
test('打ち切り時間を超えた fetch は TimeoutError で reject する', async () => {
  AbortSignal.timeout = originalTimeout;
  global.fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });

  // AbortSignal.timeout の内部タイマーは unref 済みで、それ単体ではイベントループを
  // 生かし続けない。ここでは応答しない fetch を待つだけで他に保留タスクが無いため、
  // ref 付きタイマーを挟んでループを維持する（無いと abort 前にループが枯れて
  // 「Promise resolution is still pending」で落ちる）。
  // setTimeout（一発）ではなく setInterval にしているのは、abort が想定より遅延したときに
  // keep-alive が先に切れて「テスト失敗」ではなくこのクラッシュへ退行するのを避けるため。
  // 反応が無ければ node --test 側のテストタイムアウトで落ちるので上限は要らない。
  const keepEventLoopAlive = setInterval(() => {}, 50);
  try {
    await assert.rejects(() => getStates(PORT, { timeoutMs: 20 }), { name: 'TimeoutError' });
  } finally {
    clearInterval(keepEventLoopAlive);
  }
});

test('createNewPane: timeoutMs はリクエストボディに混ざらない（後方互換）', async () => {
  await createNewPane(PORT, '/work/dir', { noClaude: true, stashed: true, timeoutMs: 1_234 });

  const req = requests.find(r => r.url.endsWith('/api/new-pane'));
  assert.deepEqual(JSON.parse(req.init.body), { cwd: '/work/dir', noClaude: true, stashed: true });
});
