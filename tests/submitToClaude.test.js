/**
 * submitToClaude のユニットテスト。
 *
 * `global.fetch` をモックして、HTTP I/O を伴わない形で Enter 再送リトライの
 * 挙動を検証する。
 *
 * 想定エンドポイントは下記 2 つ:
 *   - POST /api/send   : 本文 / Enter 送信
 *   - GET  /api/states : baseline 取得 & 出力進行確認
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { submitToClaude, reconfirmBodyEcho } from '../src/terminals/index.js';

// --------------------------------------------------------------------------
// fetch モックの仕込み
// --------------------------------------------------------------------------

const PORT   = 13847;
const TERMID = 'term-1';
const CLEAR_INPUT_SEQUENCE = '\x01\x0b';

let originalFetch;
/**
 * scenario:
 *   - statesQueue: /api/states が呼ばれるたびに先頭から取り出して返す
 *                  ({ lastOutputTime, lastLines } or 'error' → fetch を reject)
 *   - sendCalls:   /api/send で受け取った body のログ
 *   - inputBuffer: VK Terminals 側の入力欄を模した蓄積バッファ
 *   - submittedInputs: Enter で確定された入力行
 *   - statesCalls: /api/states の呼び出し回数
 */
let scenario;

function mockFetch() {
  originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);

    if (u.endsWith('/api/states')) {
      scenario.statesCalls += 1;
      // 送信状況（=これまでに送られた本文/Enter の回数）でターミナル状態を差し替える。
      //   - Enter 未送信 & 本文 0 回:  beforeBody     （本文未送信時）
      //   - Enter 未送信 & 本文 1 回:  afterBody       （本文送信済み・Enter 未送信、baseline 取得タイミング）
      //   - Enter 未送信 & 本文 2 回以上: afterBodyRetry（本文再送後。未定義なら afterBody にフォールバック
      //                                    = 「再送しても画面は変わらない」動作になる）
      //   - Enter 送信済み（何回でも）:  afterEnter     （Enter 送信後の確認ポーリング）
      const bodySends  = scenario.sendCalls.filter(c => c.input !== '\r' && c.input !== CLEAR_INPUT_SEQUENCE).length;
      const enterSends = scenario.sendCalls.filter(c => c.input === '\r').length;
      const phase =
        enterSends > 0 ? 'afterEnter'
        : bodySends === 0 ? 'beforeBody'
        : bodySends === 1 ? 'afterBody'
        : 'afterBodyRetry';
      const value = scenario.statesByPhase[phase] ?? scenario.statesByPhase.afterBody;
      if (value === 'error') {
        throw new Error('mock api/states error');
      }
      return {
        ok: true,
        json: async () => ({
          terminals: {
            [TERMID]: {
              termId:         TERMID,
              waiting:        false,
              lastOutputTime: value.lastOutputTime,
              lastLines:      value.lastLines,
            },
          },
        }),
      };
    }

    if (u.endsWith('/api/send')) {
      const body = init && init.body ? JSON.parse(init.body) : {};
      scenario.sendCalls.push(body);
      if (body.input === CLEAR_INPUT_SEQUENCE) {
        scenario.inputBuffer = '';
      } else if (body.input === '\r') {
        scenario.submittedInputs.push(scenario.inputBuffer);
        scenario.inputBuffer = '';
      } else {
        scenario.inputBuffer += body.input;
      }
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    }

    throw new Error(`unexpected fetch url in test: ${u}`);
  };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

function resetScenario(overrides = {}) {
  scenario = {
    statesByPhase: {
      beforeBody: { lastOutputTime: 100,   lastLines: 'idle'         },
      afterBody:  { lastOutputTime: 1_000, lastLines: 'prompt:hello' },
      afterEnter: { lastOutputTime: 2_000, lastLines: 'after-enter'  },
    },
    statesCalls: 0,
    sendCalls:   [],
    inputBuffer: '',
    submittedInputs: [],
    ...overrides,
  };
}

// テストを高速化するための共通オプション
const FAST_OPTIONS = {
  confirmTimeoutMs: 200,
  pollIntervalMs:   50,
  maxRetries:       2,
};

// --------------------------------------------------------------------------
// テスト
// --------------------------------------------------------------------------

describe('submitToClaude', () => {
  beforeEach(() => {
    resetScenario();
    mockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  it('(a) 本文送信で lastLines が変わり、Enter 送信でも変わる → 1 回で成功（再送なし）', async () => {
    // デフォルトのシナリオ: beforeBody(idle) → afterBody(prompt) → afterEnter(after-enter)
    // baseline は afterBody(prompt:hello, 1_000) で取られ、
    // Enter 後ポーリングは afterEnter(after-enter, 2_000) で AND 判定 progressed=true
    const result = await submitToClaude(PORT, TERMID, 'hello', 10, FAST_OPTIONS);

    assert.equal(result.ok, true, '送信結果が ok で返る');
    assert.equal(result.bodyConfirmed, true, 'エコーを確認できたので bodyConfirmed=true');

    // /api/send は 入力欄クリア + 本文 + Enter の計 3 回
    // （クリアは issue #189 で初回送信前にも常時前置きするようになった。空欄では no-op）
    assert.equal(scenario.sendCalls.length, 3, '再送なしで Enter は 1 回だけ送られる');
    assert.equal(scenario.sendCalls[0].input, CLEAR_INPUT_SEQUENCE);
    assert.equal(scenario.sendCalls[1].input, 'hello');
    assert.equal(scenario.sendCalls[2].input, '\r');
  });

  it('(b) 本文送信で lastLines が変わるが Enter 送信では変わらない → maxRetries 分再送される（旧コードでは失敗するケース）', async () => {
    // afterEnter を afterBody と同一にすることで「Enter が効いていない」状況を再現。
    //
    //   新コード（baseline = afterBody）:
    //     afterBody と afterEnter が同値 → progressed=false → maxRetries 分再送 (期待)
    //
    //   旧コード（baseline = beforeBody）:
    //     beforeBody='idle' / afterEnter='prompt:hello' → lastLines が違う
    //     → OR 判定で progressed=true となり、Enter は再送されない（FAIL）
    scenario.statesByPhase.afterEnter = { ...scenario.statesByPhase.afterBody };

    const result = await submitToClaude(PORT, TERMID, 'hello', 10, FAST_OPTIONS);

    assert.equal(result.ok, true, '最終的に return される（プロセスは落とさない）');

    // /api/send の内訳:
    //   1 回目: 入力欄クリア（issue #189 で初回送信前にも前置き）
    //   2 回目: 本文
    //   3 回目: 最初の Enter
    //   4 回目: 再送 1 回目
    //   5 回目: 再送 2 回目（maxRetries=2）
    // 合計 5 回。Enter は計 3 回（最初の Enter + 再送 maxRetries=2）。
    assert.equal(scenario.sendCalls.length, 1 + 1 + 1 + FAST_OPTIONS.maxRetries,
      'maxRetries の回数だけ Enter が再送される');
    assert.equal(scenario.sendCalls[0].input, CLEAR_INPUT_SEQUENCE);
    assert.equal(scenario.sendCalls[1].input, 'hello');
    for (let i = 2; i < scenario.sendCalls.length; i++) {
      assert.equal(scenario.sendCalls[i].input, '\r', `${i} 回目の send は Enter`);
    }
  });

  it('(c) baseline 取得が API エラー → 確認スキップで成功扱い（再送なし）', async () => {
    // baseline 取得タイミング（=本文送信後・Enter 前）の応答だけエラーにする
    scenario.statesByPhase.afterBody = 'error';

    const result = await submitToClaude(PORT, TERMID, 'hello', 10, FAST_OPTIONS);

    assert.equal(result.ok, true);
    // クリア + 本文 + Enter のみ。再送は走らない（baseline=null なら confirmOutputProgressed は true）
    assert.equal(scenario.sendCalls.length, 3, '再送なしで終わる');
    assert.equal(scenario.sendCalls[2].input, '\r');
  });

  it('(d) confirm: false を渡すと従来通り即 return（baseline 取得もスキップ）', async () => {
    // baseline 取得が呼ばれていれば statesCalls が増える
    const result = await submitToClaude(PORT, TERMID, 'hello', 10, {
      ...FAST_OPTIONS,
      confirm: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.bodyConfirmed, null, 'confirm:false では確認しないので bodyConfirmed=null');
    assert.equal(scenario.statesCalls, 0, 'confirm:false では /api/states が呼ばれない');
    assert.equal(scenario.sendCalls.length, 3, 'クリア + 本文 + Enter の 3 回のみ');
    assert.equal(scenario.sendCalls[0].input, CLEAR_INPUT_SEQUENCE,
      'confirm:false でも初回送信前のクリアは行う');
  });

  it('(e) [RED] コールドスタートのバナーが本文を飲み込み、Enterでバナーが消えるだけで出力は進む → 本文が再送されるべき（現行コードは見逃す）', async () => {
    // コールドスタート再現シナリオ:
    //   beforeBody / afterBody: 起動バナーが表示されたまま（本文 'hello' はどこにもエコーされない
    //   = 入力欄が出る前にペインへ送った本文が飲み込まれた状態）
    //   afterEnter: バナーが消えてプロンプトが再描画される（lastOutputTime も lastLines も変わる
    //   ため、現行の AND 判定では「出力が進んだ」と誤判定してしまう）が、ここにも 'hello' は
    //   一度も現れない＝本文は結局どこにも入力されていない。
    scenario.statesByPhase = {
      beforeBody: { lastOutputTime: 100, lastLines: 'Fable 5 is back and better than ever!' },
      afterBody:  { lastOutputTime: 100, lastLines: 'Fable 5 is back and better than ever!' },
      afterEnter: { lastOutputTime: 900, lastLines: '> ' },
    };

    const result = await submitToClaude(PORT, TERMID, 'hello', 10, FAST_OPTIONS);

    const bodySends = scenario.sendCalls.filter(c => c.input === 'hello');
    assert.ok(
      bodySends.length >= 2,
      '本文が一度も画面にエコーされないまま出力だけ進んだ場合、Enter だけでなく本文ごと再送されるべき' +
      `（実際の本文送信回数: ${bodySends.length}）`
    );
    // 本文再送を使い切ってもエコーを確認できなかったので、呼び出し側が取りこぼしに
    // 気づけるよう bodyConfirmed=false を返す（#4 の握りつぶし防止）。
    assert.equal(result.bodyConfirmed, false,
      '再送を使い切ってもエコー未確認なら bodyConfirmed=false を返す');
  });

  it('(f) 本文が飲み込まれても 1 回の再送でエコーが確認できれば、それ以上は再送しない', async () => {
    // beforeBody/afterBody: バナー表示中で本文は飲み込まれる（エコーなし）。
    // afterBodyRetry: 本文を再送した結果、今度はプロンプトに 'hello' がエコーされる。
    // afterEnter: Enter 確定でさらに出力が進む。
    scenario.statesByPhase = {
      beforeBody:     { lastOutputTime: 100,   lastLines: 'Fable 5 is back and better than ever!' },
      afterBody:      { lastOutputTime: 100,   lastLines: 'Fable 5 is back and better than ever!' },
      afterBodyRetry: { lastOutputTime: 500,   lastLines: 'prompt:hello' },
      afterEnter:     { lastOutputTime: 2_000, lastLines: 'after-enter' },
    };

    const result = await submitToClaude(PORT, TERMID, 'hello', 10, FAST_OPTIONS);

    assert.equal(result.ok, true);
    assert.equal(result.bodyConfirmed, true, '再送でエコーを確認できたので bodyConfirmed=true');
    const bodySends = scenario.sendCalls.filter(c => c.input === 'hello');
    assert.equal(bodySends.length, 2, '飲み込まれた本文は 1 回だけ再送され、エコー確認後は再送を止める');
    // 本文(2回) + クリア(初回送信前・再送前の計 2 回) + Enter(1回) の計 5 回のみ。
    // Enter 側は afterEnter で AND 判定 progressed=true のため再送なし。
    assert.equal(scenario.sendCalls.length, 5, 'エコー確認後は Enter も 1 回で成功し、余計な再送が起きない');
    assert.equal(scenario.sendCalls[0].input, CLEAR_INPUT_SEQUENCE, '初回の本文送信の直前にも入力行をクリアする');
    assert.equal(scenario.sendCalls[2].input, CLEAR_INPUT_SEQUENCE, '本文再送の直前に入力行をクリアする');
  });

  it('本文再送時は入力行をクリアしてから再送し、Enter で確定される行を重複連結しない', async () => {
    const body = '/vk-kore https://github.com/vektor-inc/vk-blocks-pro/issues/123 wp-env-port=9100 headless=1';
    scenario.statesByPhase = {
      beforeBody: { lastOutputTime: 100, lastLines: 'Fable 5 is back and better than ever!' },
      afterBody:  { lastOutputTime: 100, lastLines: 'Fable 5 is back and better than ever!' },
      afterEnter: { lastOutputTime: 2_000, lastLines: 'after-enter' },
    };

    const result = await submitToClaude(PORT, TERMID, body, 10, FAST_OPTIONS);

    assert.equal(result.ok, true);
    assert.equal(result.bodyConfirmed, false, 'エコー未確認のまま本文再送を使い切る');
    assert.deepEqual(
      scenario.submittedInputs,
      [body],
      '入力欄が追記型でも、Enter で確定されるコマンドは本文1回分だけになる'
    );
  });

  it('(g) 全トークンが4文字未満の本文 → エコー確認をスキップし本文再送しない（bodyConfirmed=true）', async () => {
    // 'ok a b' はすべて 4 文字未満 → pickEchoFragment は null を返し、
    // confirmBodyEchoed は「判定不能」としてフォールスルーで true。
    // バナー表示中で本文がエコーされていなくても、短トークンの偶然一致による
    // 誤判定を避けるため本文再送は起こさない。
    scenario.statesByPhase = {
      beforeBody: { lastOutputTime: 100,   lastLines: 'Fable 5 is back and better than ever!' },
      afterBody:  { lastOutputTime: 100,   lastLines: 'Fable 5 is back and better than ever!' },
      afterEnter: { lastOutputTime: 2_000, lastLines: 'after-enter' },
    };

    const result = await submitToClaude(PORT, TERMID, 'ok a b', 10, FAST_OPTIONS);

    assert.equal(result.ok, true);
    assert.equal(result.bodyConfirmed, true, 'エコー確認をスキップしたので bodyConfirmed=true');
    const bodySends = scenario.sendCalls.filter(c => c.input === 'ok a b');
    assert.equal(bodySends.length, 1, '4 文字以上のトークンが無い本文は再送しない');
    // クリア(1回) + 本文(1回) + Enter(1回) の計 3 回。
    assert.equal(scenario.sendCalls.length, 3, 'エコー確認スキップ時は本文再送が発火しない');
  });

  // ------------------------------------------------------------------------
  // issue #189: 投入前に入力欄へ残留文字があると、送信本文がその後ろに連結され
  // `<残留文字>/vk-kore ...` という行が確定される。先頭の `/` が行頭からずれるため
  // Claude Code がスラッシュコマンドとして発火しない。
  // ------------------------------------------------------------------------

  it('(h) [RED] 入力欄に残留文字がある状態で投入しても、確定される行は本文だけになる', async () => {
    const body = '/vk-kore https://github.com/vektor-inc/vk-blocks-pro/issues/189 wp-env-port=9100 headless=1';
    // ユーザーが手で打ちかけた文字がペインの入力欄に残っている状態を模擬する。
    scenario.inputBuffer = 'ゴミ';
    scenario.statesByPhase = {
      beforeBody: { lastOutputTime: 100,   lastLines: '> ' },
      afterBody:  { lastOutputTime: 1_000, lastLines: `> ${body}` },
      afterEnter: { lastOutputTime: 2_000, lastLines: 'after-enter' },
    };

    const result = await submitToClaude(PORT, TERMID, body, 10, FAST_OPTIONS);

    assert.equal(result.ok, true);
    assert.deepEqual(
      scenario.submittedInputs,
      [body],
      '残留文字が本文の前に連結されず、スラッシュコマンドが行頭から始まる'
    );
    assert.equal(scenario.sendCalls[0].input, CLEAR_INPUT_SEQUENCE,
      '初回の本文送信の前にも入力欄をクリアする');
  });

  it('(i) [RED] 残留文字が前置連結された行はエコー確認を通さず、クリア＋再送が発火する', async () => {
    const body = '/vk-kore https://github.com/vektor-inc/vk-blocks-pro/issues/189 wp-env-port=9100 headless=1';
    // 画面には `> ゴミ/vk-kore ...` という汚染行が出ている。断片一致だけの判定では
    // bodyConfirmed=true になり、クリア＝再送ループがスキップされてしまう。
    scenario.statesByPhase = {
      beforeBody:     { lastOutputTime: 100,   lastLines: '> ' },
      afterBody:      { lastOutputTime: 1_000, lastLines: `> ゴミ${body}` },
      afterBodyRetry: { lastOutputTime: 1_500, lastLines: `> ${body}` },
      afterEnter:     { lastOutputTime: 2_000, lastLines: 'after-enter' },
    };

    const result = await submitToClaude(PORT, TERMID, body, 10, FAST_OPTIONS);

    const bodySends = scenario.sendCalls.filter(c => c.input === body);
    assert.equal(bodySends.length, 2, '汚染行を検知して本文を 1 回だけ再送する');
    assert.equal(result.bodyConfirmed, true, '再送後の綺麗な行でエコーを確認できる');
  });

  it('(j) 装飾（枠線・プロンプト記号）だけが前置された行は汚染とみなさない（fail-open）', async () => {
    const body = '/vk-kore https://github.com/vektor-inc/vk-blocks-pro/issues/189 wp-env-port=9100 headless=1';
    scenario.statesByPhase = {
      beforeBody: { lastOutputTime: 100,   lastLines: '│ > ' },
      afterBody:  { lastOutputTime: 1_000, lastLines: `╭──────────╮\n│ > ${body}\n╰──────────╯` },
      afterEnter: { lastOutputTime: 2_000, lastLines: 'after-enter' },
    };

    const result = await submitToClaude(PORT, TERMID, body, 10, FAST_OPTIONS);

    assert.equal(result.bodyConfirmed, true, '入力欄装飾のみの前置は汚染ではない');
    const bodySends = scenario.sendCalls.filter(c => c.input === body);
    assert.equal(bodySends.length, 1, '装飾だけなら本文再送は起きない');
  });

  it('(k) 汚染行と綺麗な行が混在する場合は汚染とみなさない（fail-open）', async () => {
    const body = '/vk-kore https://github.com/vektor-inc/vk-blocks-pro/issues/189 wp-env-port=9100 headless=1';
    // 上のログ行（過去の転記）には本文が別の文脈で現れているが、入力欄の行は綺麗。
    scenario.statesByPhase = {
      beforeBody: { lastOutputTime: 100, lastLines: '> ' },
      afterBody:  {
        lastOutputTime: 1_000,
        lastLines: `  ユーザーの依頼: ${body}\n> ${body}`,
      },
      afterEnter: { lastOutputTime: 2_000, lastLines: 'after-enter' },
    };

    const result = await submitToClaude(PORT, TERMID, body, 10, FAST_OPTIONS);

    assert.equal(result.bodyConfirmed, true, '綺麗な行が 1 本でもあれば汚染とみなさない');
    const bodySends = scenario.sendCalls.filter(c => c.input === body);
    assert.equal(bodySends.length, 1, '再送は起きない');
  });

  it('(k2) 実データ相当: ステータス行と入力プロンプトが 1 行に潰れ ANSI 残骸が前に付いても汚染としない', async () => {
    const body = '/vk-kore https://github.com/vektor-inc/vk-blocks-pro/issues/189 wp-env-port=9100 headless=1';
    // VK Terminals の states.json で実際に観測される形。行幅で切られた結果、ステータス行の
    // 末尾に途中で切れた ANSI（ESC が落ちた `3;153;153m`）とプロンプト `❯` + NBSP が
    // 同じ行に並ぶ。境界文字（`❯`・NBSP）を挟んでいるので残留文字ではない。
    scenario.statesByPhase = {
      beforeBody: { lastOutputTime: 100, lastLines: '❯ ' },
      afterBody:  {
        lastOutputTime: 1_000,
        lastLines: `  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to inte…3;153;153m❯ ${body}`,
      },
      afterEnter: { lastOutputTime: 2_000, lastLines: 'after-enter' },
    };

    const result = await submitToClaude(PORT, TERMID, body, 10, FAST_OPTIONS);

    assert.equal(result.bodyConfirmed, true, '境界文字を挟んだ前置は残留文字ではない');
    const bodySends = scenario.sendCalls.filter(c => c.input === body);
    assert.equal(bodySends.length, 1, '実データ相当の画面で再送が誤発火しない');
  });

  it('(l) 本文の先頭トークンが行内に見つからない（折り返し等）場合は従来の断片一致にフォールバックする', async () => {
    const body = '/vk-kore https://github.com/vektor-inc/vk-blocks-pro/issues/189 wp-env-port=9100 headless=1';
    // 先頭トークンが折り返しで分断され、行単位では特定できない。末尾トークン
    // （headless=1）は画面に出ているので、従来どおり「エコーされた」と判定する。
    scenario.statesByPhase = {
      beforeBody: { lastOutputTime: 100, lastLines: '> ' },
      afterBody:  {
        lastOutputTime: 1_000,
        lastLines: '> /vk-ko\nre https://github.com/vektor-inc/vk-blocks-pro/issues/189 wp-env-port=9100 headless=1',
      },
      afterEnter: { lastOutputTime: 2_000, lastLines: 'after-enter' },
    };

    const result = await submitToClaude(PORT, TERMID, body, 10, FAST_OPTIONS);

    assert.equal(result.bodyConfirmed, true, '判定不能なら fail-open（従来の includes 判定）');
    const bodySends = scenario.sendCalls.filter(c => c.input === body);
    assert.equal(bodySends.length, 1, 'fail-open なので再送は起きない');
  });

  it('(m) clearBeforeSend:false では初回クリアを撃たない（生きたダイアログへ制御文字を送らない）', async () => {
    const result = await submitToClaude(PORT, TERMID, 'hello', 10, {
      ...FAST_OPTIONS,
      clearBeforeSend: false,
    });

    assert.equal(result.ok, true);
    assert.equal(scenario.sendCalls.length, 2, '本文 + Enter の 2 回のみ');
    assert.equal(scenario.sendCalls[0].input, 'hello', '1 回目の send がいきなり本文');
    assert.equal(scenario.sendCalls[1].input, '\r');
    assert.ok(
      !scenario.sendCalls.some(c => c.input === CLEAR_INPUT_SEQUENCE),
      'クリアシーケンスは一度も送られない'
    );
  });

  it('(n) clearBeforeSend:false でも本文再送の直前のクリアは従来どおり撃つ', async () => {
    // 再送ループのクリアは「追記型の入力欄で再送を置換にする」ために不可欠なので、
    // clearBeforeSend の対象外（初回クリアだけを外すオプションである）ことを固定する。
    scenario.statesByPhase = {
      beforeBody:     { lastOutputTime: 100,   lastLines: 'Fable 5 is back and better than ever!' },
      afterBody:      { lastOutputTime: 100,   lastLines: 'Fable 5 is back and better than ever!' },
      afterBodyRetry: { lastOutputTime: 500,   lastLines: 'prompt:hello' },
      afterEnter:     { lastOutputTime: 2_000, lastLines: 'after-enter' },
    };

    await submitToClaude(PORT, TERMID, 'hello', 10, { ...FAST_OPTIONS, clearBeforeSend: false });

    const clears = scenario.sendCalls.filter(c => c.input === CLEAR_INPUT_SEQUENCE);
    assert.equal(clears.length, 1, '再送前のクリアだけが撃たれる');
    assert.equal(scenario.sendCalls[0].input, 'hello', '初回はクリアなしで本文から始まる');
    assert.equal(scenario.sendCalls[1].input, CLEAR_INPUT_SEQUENCE, '再送の直前はクリアする');
  });

  it('(o) 行幅で切られた未終端 OSC が本文の直前に残っていても汚染とみなさない', async () => {
    const body = '/vk-kore https://github.com/vektor-inc/vk-blocks-pro/issues/189 wp-env-port=9100 headless=1';
    // OSC（ペインタイトル設定）が終端子ごと切り詰められ、ペイロードが可視テキストとして
    // 本文の直前に地続きで残ったケース。ESC だけを制御文字として落とすと
    // `]0;pane-title` が残留文字に見えてしまう（偽陽性）。
    scenario.statesByPhase = {
      beforeBody: { lastOutputTime: 100, lastLines: '> ' },
      afterBody:  {
        lastOutputTime: 1_000,
        lastLines: `> \x1b]0;vk-terminals pane-title${body}`,
      },
      afterEnter: { lastOutputTime: 2_000, lastLines: 'after-enter' },
    };

    const result = await submitToClaude(PORT, TERMID, body, 10, FAST_OPTIONS);

    assert.equal(result.bodyConfirmed, true, '未終端 OSC の残骸は残留文字とみなさない');
    const bodySends = scenario.sendCalls.filter(c => c.input === body);
    assert.equal(bodySends.length, 1, '偽陽性の再送が起きない');
  });

  it('AND 判定: lastOutputTime だけ進んで lastLines が同じ場合は progressed と見なさない', async () => {
    // baseline (afterBody) と Enter 後 (afterEnter) で lastOutputTime だけ進んで lastLines は同じ
    // → カーソル blink 相当。AND 判定なので progressed=false で再送が走るのが正解。
    scenario.statesByPhase.afterEnter = {
      lastOutputTime: scenario.statesByPhase.afterBody.lastOutputTime + 5_000,
      lastLines:      scenario.statesByPhase.afterBody.lastLines,
    };

    await submitToClaude(PORT, TERMID, 'hello', 10, FAST_OPTIONS);

    // OR 判定のままだと再送 0 回で終わる。AND 判定であれば maxRetries 分再送される。
    // 内訳は クリア(1) + 本文(1) + 最初の Enter(1) + Enter 再送(maxRetries)。
    assert.equal(scenario.sendCalls.length, 1 + 1 + 1 + FAST_OPTIONS.maxRetries,
      'AND 判定なのでカーソル blink 相当のケースでは再送が発火する');
  });

  // ------------------------------------------------------------------------
  // issue #218: `/api/send` に打ち切り時間（AbortSignal.timeout）を入れた結果、
  // VK Terminals 側が一時的に詰まると初回の本文送信が abort で reject しうる。
  // 「無限ハング」を「タスク起動ごとクラッシュ」に置き換えないことを検証する。
  // ------------------------------------------------------------------------

  /**
   * 本文送信（クリア・Enter 以外）を先頭 `times` 回だけ abort させる fetch ラッパを被せる。
   * `times: Infinity` なら本文送信は一度も成功しない。
   */
  function failBodySends(times = 1) {
    const mocked = global.fetch;
    let bodySendAttempts = 0;
    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith('/api/send')) {
        const body = init?.body ? JSON.parse(init.body) : {};
        const isBodySend = body.input !== '\r' && body.input !== CLEAR_INPUT_SEQUENCE;
        if (isBodySend && ++bodySendAttempts <= times) {
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          throw err;
        }
      }
      return mocked(url, init);
    };
  }

  /** `/api/states` を全フェーズで失敗させる（getTerminalBaseline が常に null を返す状態）。 */
  function statesAlwaysError() {
    for (const phase of ['beforeBody', 'afterBody', 'afterBodyRetry', 'afterEnter']) {
      scenario.statesByPhase[phase] = 'error';
    }
  }

  /** 実際に VK Terminals へ届いた本文送信（クリア・Enter を除く）の回数。 */
  function deliveredBodySends() {
    return scenario.sendCalls.filter(
      c => c.input !== '\r' && c.input !== CLEAR_INPUT_SEQUENCE
    ).length;
  }

  it('初回の本文送信が打ち切り(abort)で失敗しても throw せず、本文再送で回復する', async () => {
    failBodySends(1);

    const result = await submitToClaude(PORT, TERMID, 'hello', 10, FAST_OPTIONS);

    assert.equal(result.ok, true, 'abort を握って回復し、最終結果は ok で返る');
    assert.equal(result.bodyConfirmed, true, '本文再送でエコーを確認できる');
    assert.equal(deliveredBodySends(), 1, '成功した本文送信は再送分の 1 回（初回は abort で届いていない）');
  });

  it('confirm:false では回復手段が無いため、初回の本文送信の失敗はそのまま throw する', async () => {
    failBodySends(1);

    await assert.rejects(
      () => submitToClaude(PORT, TERMID, 'hello', 10, { ...FAST_OPTIONS, confirm: false }),
      /aborted due to timeout/,
    );
  });

  // 初回送信 abort と /api/states 取得失敗の co-failure。confirmBodyEchoed は baseline=null を
  // fail-open(true) で返す契約なので、素で使うと再送ループが一度も回らないまま
  // bodyConfirmed=true になり、本文未達なのに成功扱いになる（＝startTask の #172 ロールバックが
  // 発火せず、watchdog の idle 判定まで固着する）。本文送信が一度も成功していない間は
  // fail-open させないことを検証する。
  it('states 取得も失敗し本文送信が一度も成功しない場合は bodyConfirmed=false に倒す', async () => {
    statesAlwaysError();
    failBodySends(Infinity);

    const result = await submitToClaude(PORT, TERMID, 'hello', 10, FAST_OPTIONS);

    assert.equal(result.bodyConfirmed, false,
      '本文未達が確定しているので baseline 取得失敗でも fail-open してはいけない');
    assert.equal(deliveredBodySends(), 0, '本文は一度も届いていない');
    assert.deepEqual(scenario.submittedInputs, [''],
      '確定されたのは空の入力欄（本文が入らないまま Enter だけ通っている）');
  });

  it('states 取得は失敗し続けても、本文が再送で届いていれば bodyConfirmed=true を返す', async () => {
    statesAlwaysError();
    failBodySends(1);

    const result = await submitToClaude(PORT, TERMID, 'hello', 10, FAST_OPTIONS);

    // baseline を取れない＝検証不能なので fail-open(true) は正しい。ただしその前提として
    // 「本文が実際に届いている」ことが必要。ここが 0 回のまま true になるのが #218 の偽陽性。
    assert.equal(result.bodyConfirmed, true, '検証不能かつ本文は届いているので fail-open が正しい');
    assert.ok(deliveredBodySends() >= 1, 'bodyConfirmed=true を返す前に本文が実際に届いている');
    assert.deepEqual(scenario.submittedInputs, ['hello'], '確定された入力は本文そのもの');
  });
});

// --------------------------------------------------------------------------
// issue #172: コールドスタートで起動バナーが数回 churn した後にエコーが出現する
// ケース。バナー描画が長引くと、旧デフォルト（delayMs=500 / maxRetries=2）では
// 本文の再送回数が足りずエコーを確認できずに bodyConfirmed=false で終わっていた。
// デフォルトを delayMs=1000 / maxRetries=3 に引き上げることで、バナー churn を
// 跨いでエコーを確認できるようになることを検証する。
//
// 独立した fetch モックを使い、「本文が N 回届くまではバナーが churn（エコー無し）、
// N 回目でようやくプロンプトに本文がエコーされる」状況を再現する。
// --------------------------------------------------------------------------
describe('submitToClaude コールドスタート banner churn (issue #172)', () => {
  // 実運用に近い、十分長い（4 文字以上のトークンを含む）本文。
  const BODY = '/vk-kore https://github.com/vektor-inc/vk-blocks-pro/issues/999 wp-env-port=9200';
  // エコーが現れるのに必要な「本文の総送信回数」。
  //   - 旧デフォルト maxRetries=2 → 本文送信は初回 + 2 = 計 3 回。ここに届かず false。
  //   - 新デフォルト maxRetries=3 → 本文送信は初回 + 3 = 計 4 回。ここで初めて true。
  const ECHO_APPEARS_AFTER_BODY_SENDS = 4;

  let savedFetch;
  let bodySends;
  let enterSends;

  function states(lastOutputTime, lastLines) {
    return {
      ok: true,
      json: async () => ({
        terminals: {
          [TERMID]: { termId: TERMID, waiting: false, lastOutputTime, lastLines },
        },
      }),
    };
  }

  beforeEach(() => {
    savedFetch = global.fetch;
    bodySends  = 0;
    enterSends = 0;
    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith('/api/send')) {
        const body = init && init.body ? JSON.parse(init.body) : {};
        if (body.input === '\r') enterSends += 1;
        else if (body.input === CLEAR_INPUT_SEQUENCE) { /* 入力行クリアは送信回数に数えない */ }
        else bodySends += 1;
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (u.endsWith('/api/states')) {
        // Enter 送信後は出力が進む（Enter 確定チェックを通す）。
        if (enterSends > 0) return states(9_000 + enterSends, 'after-enter');
        // 本文が規定回数届くまではバナーが churn し続け、本文はエコーされない。
        if (bodySends >= ECHO_APPEARS_AFTER_BODY_SENDS) {
          return states(5_000 + bodySends, `> ${BODY}`);
        }
        return states(1_000 + bodySends, `Banner churn phase ${bodySends} ...`);
      }
      throw new Error(`unexpected fetch url in test: ${u}`);
    };
  });

  afterEach(() => {
    global.fetch = savedFetch;
  });

  it('[RED] デフォルト設定（maxRetries 未指定）でバナー churn を跨いでエコーを確認できる', async () => {
    // delayMs は小さくして高速化（本挙動は maxRetries に依存するため、これで妥当）。
    // maxRetries / confirm 系は「デフォルト値」を使わせたいので敢えて渡さない。
    // 旧デフォルト maxRetries=2 だと本文送信が 3 回どまり → エコー未確認 → bodyConfirmed=false（RED）。
    // 新デフォルト maxRetries=3 なら本文送信が 4 回に届き → エコー確認 → bodyConfirmed=true（GREEN）。
    const result = await submitToClaude(PORT, TERMID, BODY, 5);

    assert.equal(result.bodyConfirmed, true,
      'デフォルト maxRetries でバナー churn 後のエコーを確認できるべき');
    assert.ok(bodySends >= ECHO_APPEARS_AFTER_BODY_SENDS,
      `本文がエコー出現に必要な回数まで再送されるべき（実際: ${bodySends}）`);
  });

  it('旧デフォルト相当 maxRetries=2 ではエコーを確認できない（false）— 不具合の再現', async () => {
    const result = await submitToClaude(PORT, TERMID, BODY, 5, {
      maxRetries: 2, confirmTimeoutMs: 200, pollIntervalMs: 30,
    });
    assert.equal(result.bodyConfirmed, false,
      'maxRetries=2 では本文送信が 3 回どまりでエコーを確認できない');
  });

  it('新デフォルト相当 maxRetries=3 ならエコーを確認できる（true）— 修正後の期待', async () => {
    const result = await submitToClaude(PORT, TERMID, BODY, 5, {
      maxRetries: 3, confirmTimeoutMs: 200, pollIntervalMs: 30,
    });
    assert.equal(result.bodyConfirmed, true,
      'maxRetries=3 なら本文送信が 4 回に届きエコーを確認できる');
  });
});

// --------------------------------------------------------------------------
// reconfirmBodyEcho（偽陽性ガード）: 再ディスパッチ発動直前のエコー再確認。
// bodyConfirmed=false からの再ディスパッチを、真に未達のときだけ通す fail-closed 判定。
//   - 照合対象が無い（本文が空 / 4 文字以上トークン無し）→ true（スキップ）
//   - states 取得失敗（baseline=null）→ false（fail-closed で再ディスパッチへ）
//   - エコー一致 → true / エコー不一致 → false
// --------------------------------------------------------------------------
describe('reconfirmBodyEcho（偽陽性ガード）', () => {
  const FRAG = '/vk-kore https://github.com/vektor-inc/vk-blocks-pro/issues/999';

  let savedFetch;
  let statesCalls;

  function installStates(behavior) {
    savedFetch = global.fetch;
    statesCalls = 0;
    global.fetch = async (url) => {
      const u = String(url);
      if (!u.endsWith('/api/states')) throw new Error(`unexpected fetch url in test: ${u}`);
      statesCalls += 1;
      return behavior();
    };
  }
  function termStates(lastLines) {
    return { ok: true, json: async () => ({ terminals: { [TERMID]: { termId: TERMID, lastOutputTime: 1, lastLines } } }) };
  }

  afterEach(() => { if (savedFetch) global.fetch = savedFetch; savedFetch = undefined; });

  it('照合対象が無い本文（4文字以上トークン無し）は true を返し、states も引かない', async () => {
    installStates(() => { throw new Error('should not be called'); });
    const result = await reconfirmBodyEcho(PORT, TERMID, 'ok a b');
    assert.equal(result, true, '照合対象が無ければスキップ扱いで true');
    assert.equal(statesCalls, 0, 'echoFragment=null のときは states を引かない');
  });

  it('states 取得が API エラー（baseline=null）なら false（fail-closed で再ディスパッチへ）', async () => {
    installStates(() => { throw new Error('mock api/states error'); });
    const result = await reconfirmBodyEcho(PORT, TERMID, FRAG);
    assert.equal(result, false, 'baseline 取得失敗は fail-closed で false');
  });

  it('states にターミナルが居ない（baseline=null）なら false（fail-closed）', async () => {
    installStates(() => ({ ok: true, json: async () => ({ terminals: {} }) }));
    const result = await reconfirmBodyEcho(PORT, TERMID, FRAG);
    assert.equal(result, false, '対象ターミナル不在も baseline=null で false');
  });

  it('lastLines に本文の一部がエコーされていれば true', async () => {
    installStates(() => termStates(`> ${FRAG}`));
    const result = await reconfirmBodyEcho(PORT, TERMID, FRAG);
    assert.equal(result, true, 'エコーを積極的に確認できたら true');
  });

  it('lastLines にエコーが無ければ false（真に未達 → 再ディスパッチへ）', async () => {
    installStates(() => termStates('Fable 5 is back and better than ever!'));
    const result = await reconfirmBodyEcho(PORT, TERMID, FRAG);
    assert.equal(result, false, 'エコー不一致は false');
  });

  it('[RED] 残留文字が前置連結された行しか無ければ false（汚染検知 → 再ディスパッチへ）', async () => {
    installStates(() => termStates(`> ゴミ${FRAG}`));
    const result = await reconfirmBodyEcho(PORT, TERMID, FRAG);
    assert.equal(result, false, '断片は含まれていても行頭が汚染されていれば未達扱い');
  });
});
