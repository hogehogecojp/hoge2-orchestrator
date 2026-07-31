import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isWaitingInputByAgent } from '../src/engine/decision-record.js';
import {
  DEFAULT_REPLY_FORWARD_RETRY_MAX,
  createReplyForwardScanner,
  decideReplyForward,
  normalizeReplyForwardRetryMax,
} from '../src/engine/reply-forward.js';

const silentLogger = {
  log() {},
  warn() {},
};

// 起動時にペインへ設定したヘッダーリンク（state.paneTitleUrl）と、別タスクのペインが
// 持っているヘッダーリンク。照合はこの 2 値の突き合わせだけで行う（#267）。
const PANE_TITLE_URL = 'https://github.com/vektor-inc/task-queue/issues/221#vk-task-221';
const OTHER_TASK_TITLE_URL = 'https://github.com/vektor-inc/task-queue/issues/999#vk-task-999';

// 実運用（src/engine/index.js）では getStates が必ず注入されるため、既定でも「注入されて
// いる」状態を実態として扱う。ただしペイン側は識別情報を持たせない（照合に中立＝
// UNVERIFIABLE）ことで、照合を主眼にしないテストが従来どおり転送経路を通るようにする。
// 照合そのものを見るテストは個別に getStates / saved.paneTitleUrl を渡す。
const defaultGetStates = async () => ({
  terminals: { 'pane-1': { termId: 'term-1' } },
});

function makeDeps(overrides = {}) {
  const calls = {
    submitToClaude: [],
    reconfirmBodyEcho: [],
    updateTask: [],
    setStatus: [],
    addTargetComment: [],
  };
  let saved = {
    termId: 'term-1',
    ...overrides.saved,
  };
  const reply = overrides.reply ?? { id: 111, body: '再開してください' };

  const deps = {
    githubIntegration: true,
    port: 13847,
    maxAttempts: overrides.maxAttempts ?? 3,
    getStates: defaultGetStates,
    fetchWaitingInputIssues: async () => [{ number: 221 }],
    getTask: async () => saved,
    gatherTargetState: async () => ({
      comments: [],
      pr: null,
      prState: null,
      target: {
        owner: 'vektor-inc',
        repo: 'task-queue',
        number: 221,
        isSelf: true,
      },
    }),
    ensurePRRecorded: async () => {},
    findReplyAfterWaitingInput: () => reply,
    submitToClaude: async (...args) => {
      calls.submitToClaude.push(args);
      if (overrides.submitError) throw overrides.submitError;
      return overrides.submitResult ?? { bodyConfirmed: true };
    },
    reconfirmBodyEcho: async (...args) => {
      calls.reconfirmBodyEcho.push(args);
      return overrides.reconfirmResult ?? false;
    },
    updateTask: async (issueNumber, patch) => {
      calls.updateTask.push([issueNumber, patch]);
      saved = { ...saved, ...patch };
    },
    setStatus: async (...args) => {
      calls.setStatus.push(args);
    },
    addTargetComment: async (...args) => {
      calls.addTargetComment.push(args);
    },
    logger: silentLogger,
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (key in deps) deps[key] = value;
  }

  return {
    calls,
    getSaved: () => saved,
    scanner: createReplyForwardScanner(deps),
  };
}

describe('decideReplyForward', () => {
  const cases = [
    [
      '転送済み',
      { replyId: 111, saved: { lastForwardedCommentId: 111 }, maxAttempts: 3 },
      { type: 'already-forwarded', attempt: 0, notifyExhausted: false },
    ],
    [
      '新しい返信の初回',
      { replyId: 111, saved: null, maxAttempts: 3 },
      { type: 'forward', attempt: 1, notifyExhausted: false },
    ],
    [
      '同じ返信の再送',
      { replyId: 111, saved: { replyForward: { commentId: 111, attempts: 1 } }, maxAttempts: 3 },
      { type: 'forward', attempt: 2, notifyExhausted: false },
    ],
    [
      '上限到達後の初回通知',
      { replyId: 111, saved: { replyForward: { commentId: 111, attempts: 3 } }, maxAttempts: 3 },
      { type: 'exhausted', attempt: 4, notifyExhausted: true },
    ],
    [
      '上限到達を通知済み',
      { replyId: 111, saved: { replyForward: { commentId: 111, attempts: 3, exhaustedNotified: true } }, maxAttempts: 3 },
      { type: 'exhausted', attempt: 4, notifyExhausted: false },
    ],
    [
      '別返信なら残った回数を引き継がない',
      { replyId: 222, saved: { replyForward: { commentId: 111, attempts: 3 } }, maxAttempts: 3 },
      { type: 'forward', attempt: 1, notifyExhausted: false },
    ],
  ];

  for (const [name, input, expected] of cases) {
    it(name, () => {
      assert.deepEqual(decideReplyForward(input), expected);
    });
  }
});

describe('normalizeReplyForwardRetryMax', () => {
  it('未設定・非数値・負数は既定値へフォールバックする', () => {
    for (const value of [NaN, -1, '-1', 'abc', '', '   ', null, undefined]) {
      assert.equal(
        normalizeReplyForwardRetryMax(value),
        DEFAULT_REPLY_FORWARD_RETRY_MAX,
        String(value)
      );
    }
  });

  it('0 は再試行なしとして許容し、正の小数は切り捨てる', () => {
    assert.equal(normalizeReplyForwardRetryMax(0), 0);
    assert.equal(normalizeReplyForwardRetryMax('0'), 0);
    assert.equal(normalizeReplyForwardRetryMax(2.9), 2);
    assert.equal(normalizeReplyForwardRetryMax('4'), 4);
  });
});

describe('replyForwardScanner', () => {
  it('並行再入をスキップして送信上限と上限到達通知1回を守る', async () => {
    const logs = [];
    const targetState = {
      comments: [],
      pr: null,
      prState: null,
      target: {
        owner: 'vektor-inc',
        repo: 'task-queue',
        number: 221,
        isSelf: true,
      },
    };
    const deferred = () => {
      let resolve;
      const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    };
    let gatherEntered = deferred();
    let releaseGather = deferred();
    const { scanner, calls } = makeDeps({
      maxAttempts: 1,
      submitResult: { bodyConfirmed: false },
      reconfirmResult: false,
      gatherTargetState: async () => {
        gatherEntered.resolve();
        await releaseGather.promise;
        return targetState;
      },
      logger: {
        log: (message) => logs.push(message),
        warn() {},
      },
    });

    const runConcurrently = async () => {
      const first = scanner();
      await gatherEntered.promise;
      const second = scanner();
      await new Promise((resolve) => setImmediate(resolve));
      releaseGather.resolve();
      await Promise.all([first, second]);
      gatherEntered = deferred();
      releaseGather = deferred();
    };

    await runConcurrently();
    await runConcurrently();

    assert.equal(calls.submitToClaude.length, 1);
    assert.equal(calls.addTargetComment.length, 1);
    assert.equal(
      logs.filter((message) => message.includes('前回の返信転送処理が継続中のためスキップ')).length,
      2
    );
  });

  it('走査が例外終了しても再入ガードを解放する', async () => {
    let failUpdate = true;
    const { scanner, calls } = makeDeps({
      updateTask: async () => {
        if (failUpdate) {
          failUpdate = false;
          throw new Error('state unavailable');
        }
      },
    });

    await assert.rejects(scanner(), /state unavailable/);
    await assert.doesNotReject(scanner());

    assert.equal(calls.submitToClaude.length, 1);
  });

  it('本文未達の1巡目は転送カーソルを記録せず waiting-input を維持する', async () => {
    const { scanner, calls, getSaved } = makeDeps({
      submitResult: { bodyConfirmed: false },
      reconfirmResult: false,
    });

    await scanner();

    assert.equal(getSaved().lastForwardedCommentId, undefined);
    assert.deepEqual(calls.setStatus, []);
    assert.deepEqual(getSaved().replyForward, {
      commentId: 111,
      attempts: 1,
      exhaustedNotified: false,
    });
  });

  it('本文未達なら同じ返信を次巡回でも再転送する', async () => {
    const { scanner, calls, getSaved } = makeDeps({
      submitResult: { bodyConfirmed: false },
      reconfirmResult: false,
    });

    await scanner();
    await scanner();

    assert.equal(calls.submitToClaude.length, 2);
    assert.equal(calls.submitToClaude[0][2], '再開してください');
    assert.equal(calls.submitToClaude[1][2], '再開してください');
    assert.equal(getSaved().replyForward.attempts, 2);
  });

  it('上限到達後は転送・復帰せず、通知は2巡しても1回だけ行う', async () => {
    const { scanner, calls, getSaved } = makeDeps({
      saved: {
        replyForward: {
          commentId: 111,
          attempts: 3,
          exhaustedNotified: false,
        },
      },
    });

    await scanner();
    await scanner();

    assert.equal(calls.submitToClaude.length, 0);
    assert.equal(calls.setStatus.length, 0);
    assert.equal(calls.addTargetComment.length, 1);
    assert.equal(getSaved().lastForwardedCommentId, undefined);
    assert.equal(getSaved().replyForward.exhaustedNotified, true);
  });

  it('前の返信の上限到達 state が残っていても新しい返信は初回として転送する', async () => {
    const { scanner, calls, getSaved } = makeDeps({
      saved: {
        replyForward: {
          commentId: 111,
          attempts: 3,
          exhaustedNotified: true,
        },
      },
      reply: { id: 222, body: '新しい指示です' },
    });

    await scanner();

    assert.equal(calls.submitToClaude.length, 1);
    assert.equal(calls.submitToClaude[0][2], '新しい指示です');
    assert.equal(getSaved().lastForwardedCommentId, 222);
    assert.equal(getSaved().replyForward, null);
  });

  it('本文エコーを再確認できたら成功扱いにして試行 state をクリアする', async () => {
    const { scanner, calls, getSaved } = makeDeps({
      submitResult: { bodyConfirmed: false },
      reconfirmResult: true,
    });

    await scanner();

    assert.equal(calls.submitToClaude.length, 1);
    assert.equal(calls.reconfirmBodyEcho.length, 1);
    assert.equal(getSaved().lastForwardedCommentId, 111);
    assert.equal(getSaved().replyForward, null);
    assert.deepEqual(calls.setStatus, [[221, 'status:in-progress']]);
  });

  it('正常転送ではカーソルを記録して in-progress へ復帰する', async () => {
    const { scanner, calls, getSaved } = makeDeps();

    await scanner();

    assert.equal(calls.submitToClaude.length, 1);
    assert.equal(getSaved().lastForwardedCommentId, 111);
    assert.equal(getSaved().replyForward, null);
    assert.deepEqual(calls.setStatus, [[221, 'status:in-progress']]);
  });

  it('転送済み返信は再送せず in-progress 復帰だけを再試行する', async () => {
    const { scanner, calls } = makeDeps({
      saved: { lastForwardedCommentId: 111 },
    });

    await scanner();

    assert.equal(calls.submitToClaude.length, 0);
    assert.deepEqual(calls.setStatus, [[221, 'status:in-progress']]);
  });

  it('termId 不明なら転送も状態更新も行わない', async () => {
    const { scanner, calls } = makeDeps({
      saved: { termId: null },
    });

    await scanner();

    assert.equal(calls.submitToClaude.length, 0);
    assert.equal(calls.updateTask.length, 0);
    assert.equal(calls.setStatus.length, 0);
  });

  it('本文送信後の Enter 送信で throw しても試行回数は巻き戻さず waiting-input を維持する', async () => {
    const { scanner, calls, getSaved } = makeDeps({
      submitError: new Error('Enter send failed'),
    });

    await scanner();

    assert.equal(getSaved().lastForwardedCommentId, undefined);
    assert.deepEqual(getSaved().replyForward, {
      commentId: 111,
      attempts: 1,
      exhaustedNotified: false,
    });
    assert.equal(calls.setStatus.length, 0);
  });

  it('送信の throw が続いても上限到達後は再送せず、通知を1回だけ行う', async () => {
    const { scanner, calls, getSaved } = makeDeps({
      maxAttempts: 2,
      submitError: new Error('Enter send failed'),
    });

    await scanner();
    await scanner();
    await scanner();
    await scanner();

    assert.equal(calls.submitToClaude.length, 2);
    assert.equal(calls.addTargetComment.length, 1);
    assert.equal(calls.setStatus.length, 0);
    assert.equal(getSaved().lastForwardedCommentId, undefined);
    assert.deepEqual(getSaved().replyForward, {
      commentId: 111,
      attempts: 2,
      exhaustedNotified: true,
    });
  });

  it('上限到達通知は自己回復用の waiting-input decision-record である', async () => {
    const { scanner, calls } = makeDeps({
      saved: {
        replyForward: {
          commentId: 111,
          attempts: 3,
          exhaustedNotified: false,
        },
      },
    });

    await scanner();

    const body = calls.addTargetComment[0][1];
    assert.match(body, /^Comment by vk-agents\nStatus: waiting-input\n/);
    assert.match(
      body,
      /この issue へ投稿した返信を作業ペインの入力欄に手動で貼り付けるか、同じ内容をこの issue に新しいコメントとして投稿してください。/
    );
    assert.equal(isWaitingInputByAgent(body), true);
  });

  it('外部対象の上限到達通知は対象 issue 側へ投稿する', async () => {
    const target = {
      owner: 'vektor-inc',
      repo: 'vk-blocks-pro',
      number: 1234,
      isSelf: false,
    };
    const { scanner, calls } = makeDeps({
      saved: {
        replyForward: {
          commentId: 111,
          attempts: 3,
          exhaustedNotified: false,
        },
      },
      gatherTargetState: async () => ({
        comments: [],
        pr: null,
        prState: null,
        target,
      }),
    });

    await scanner();

    assert.deepEqual(calls.addTargetComment[0][0], target);
  });

  it('上限到達コメントの投稿失敗は走査外へ投げず waiting-input を維持する', async () => {
    const { scanner, calls, getSaved } = makeDeps({
      saved: {
        replyForward: {
          commentId: 111,
          attempts: 3,
          exhaustedNotified: false,
        },
      },
      addTargetComment: async () => {
        throw new Error('GitHub unavailable');
      },
    });

    await assert.doesNotReject(scanner());

    assert.equal(getSaved().replyForward.exhaustedNotified, false);
    assert.equal(calls.updateTask.length, 0);
    assert.equal(calls.setStatus.length, 0);
  });

  it('別タスクへ再採番されたペインには返信を転送せず、カーソルも試行回数も進めない', async () => {
    const warnings = [];
    const { scanner, calls, getSaved } = makeDeps({
      saved: { paneTitleUrl: PANE_TITLE_URL },
      getStates: async () => ({
        terminals: { 'pane-1': { termId: 'term-1', apiUrl: OTHER_TASK_TITLE_URL } },
      }),
      logger: {
        log() {},
        warn: (message) => warnings.push(message),
      },
    });

    await scanner();

    // 返信本文はペインの Claude へプロンプトとして届く＝実行される入力なので、
    // 掴み違いが確定した時点で送らない。
    assert.equal(calls.submitToClaude.length, 0);
    // 見送りで再送予算を減らさない（照合は試行回数の記録より前で行う）。
    assert.equal(calls.updateTask.length, 0);
    assert.equal(getSaved().replyForward, undefined);
    // カーソルを進めると次ループで再試行されず、返信が永久に届かなくなる。
    assert.equal(getSaved().lastForwardedCommentId, undefined);
    assert.equal(calls.setStatus.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /別タスク/);
  });

  it('見送りログのペイン由来の値から ANSI・制御文字を落とす', async () => {
    const warnings = [];
    const { scanner } = makeDeps({
      saved: { paneTitleUrl: PANE_TITLE_URL },
      getStates: async () => ({
        terminals: {
          // ペインの値は VK Terminals 由来の外部入力。ログはコンソールに出るうえ issue へ
          // 貼られる運用があり、画面消去やカーソル移動のシーケンスが混じると表示が崩れる
          // （#253 と同じ経路）。ここが唯一の検知点なので、生で出ていないことを直接見る。
          'pane-1': { termId: 'term-1', apiUrl: `\x1b[2J${OTHER_TASK_TITLE_URL}\x07\r` },
        },
      }),
      logger: {
        log() {},
        warn: (message) => warnings.push(message),
      },
    });

    await scanner();

    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /[\x00-\x1f\x7f]/);
    assert.match(warnings[0], /別タスク/);
    // 値そのものは（制御文字を除いて）読める形で残す。落として無地にしてしまうと、
    // どのペインを掴んでいたのか追えなくなる。
    assert.ok(warnings[0].includes(`pane=${OTHER_TASK_TITLE_URL}`));
    // 期待値の側はこちらが state に持っている値なので、加工せずそのまま出す。
    assert.ok(warnings[0].includes(`期待=${PANE_TITLE_URL}`));
  });

  it('別タスクのペインでも次巡回で正しいペインへ戻れば初回として転送する', async () => {
    let apiUrl = OTHER_TASK_TITLE_URL;
    const { scanner, calls, getSaved } = makeDeps({
      saved: { paneTitleUrl: PANE_TITLE_URL },
      getStates: async () => ({
        terminals: { 'pane-1': { termId: 'term-1', apiUrl } },
      }),
    });

    await scanner();
    apiUrl = PANE_TITLE_URL;
    await scanner();

    assert.equal(calls.submitToClaude.length, 1);
    // 見送った巡回で予算を消費していれば attempts は 2 になる。1 であることが消費なしの証跡。
    assert.deepEqual(calls.updateTask[0][1], {
      replyForward: { commentId: 111, attempts: 1, exhaustedNotified: false },
    });
    assert.equal(getSaved().lastForwardedCommentId, 111);
  });

  it('ヘッダーリンクが一致するペインへは従来どおり転送する', async () => {
    const { scanner, calls, getSaved } = makeDeps({
      saved: { paneTitleUrl: PANE_TITLE_URL },
      getStates: async () => ({
        terminals: { 'pane-1': { termId: 'term-1', apiUrl: PANE_TITLE_URL } },
      }),
    });

    await scanner();

    assert.equal(calls.submitToClaude.length, 1);
    assert.equal(getSaved().lastForwardedCommentId, 111);
    assert.deepEqual(calls.setStatus, [[221, 'status:in-progress']]);
  });

  it('paneTitleUrl を持たない既存タスクは照合不能として従来どおり転送する', async () => {
    const { scanner, calls } = makeDeps({
      // saved.paneTitleUrl 無し（この変更より前に起動したタスク）。ペイン側は値を持つ。
      getStates: async () => ({
        terminals: { 'pane-1': { termId: 'term-1', apiUrl: OTHER_TASK_TITLE_URL } },
      }),
    });

    await scanner();

    assert.equal(calls.submitToClaude.length, 1);
  });

  it('ペイン側が担当 PR しか持たない場合も転送する（PR URL は照合材料にしない）', async () => {
    const { scanner, calls } = makeDeps({
      saved: { paneTitleUrl: PANE_TITLE_URL },
      getStates: async () => ({
        terminals: {
          // ensurePRRecorded がこのイテレーションで書きうる値を期待値に使わないため、
          // 担当 PR が何であれ転送は止めない（ヘッダーが無ければ照合不能）。
          'pane-1': { termId: 'term-1', apiPrUrl: 'https://github.com/vektor-inc/example/pull/9' },
        },
      }),
    });

    await scanner();

    assert.equal(calls.submitToClaude.length, 1);
  });

  it('states 取得失敗では転送を見送り、試行回数を消費しない', async () => {
    const warnings = [];
    const { scanner, calls, getSaved } = makeDeps({
      saved: { paneTitleUrl: PANE_TITLE_URL },
      getStates: async () => {
        throw new Error('VK Terminals unavailable');
      },
      logger: {
        log() {},
        warn: (message) => warnings.push(message),
      },
    });

    await scanner();

    assert.equal(calls.submitToClaude.length, 0);
    assert.equal(calls.updateTask.length, 0);
    assert.equal(getSaved().lastForwardedCommentId, undefined);
    assert.match(warnings[0], /次ループで再試行/);
  });

  it('states の形式が不正でも転送を見送る', async () => {
    const { scanner, calls } = makeDeps({
      saved: { paneTitleUrl: PANE_TITLE_URL },
      getStates: async () => ({ terminals: null }),
    });

    await scanner();

    assert.equal(calls.submitToClaude.length, 0);
    assert.equal(calls.updateTask.length, 0);
  });

  it('getStates が未注入なら見送り、再試行では解消しないと分かる warn を出す', async () => {
    const warnings = [];
    const { scanner, calls } = makeDeps({
      saved: { paneTitleUrl: PANE_TITLE_URL },
      getStates: null,
      logger: {
        log() {},
        warn: (message) => warnings.push(message),
      },
    });

    await scanner();

    assert.equal(calls.submitToClaude.length, 0);
    assert.equal(calls.updateTask.length, 0);
    assert.match(warnings[0], /再試行では解消しません/);
  });

  it('termId のペインが一覧に無ければ従来どおり転送を試みる', async () => {
    const { scanner, calls, getSaved } = makeDeps({
      saved: { paneTitleUrl: PANE_TITLE_URL },
      // 一致するペインが無い＝誤配送の相手がいない。ここで見送ると送信失敗による
      // 試行回数の消費 → 上限到達コメント（手動での貼り付け案内）へ到達できなくなる。
      getStates: async () => ({
        terminals: { 'pane-9': { termId: 'term-9', apiUrl: OTHER_TASK_TITLE_URL } },
      }),
      submitError: new Error('terminal not found'),
    });

    await scanner();

    assert.equal(calls.submitToClaude.length, 1);
    assert.deepEqual(getSaved().replyForward, {
      commentId: 111,
      attempts: 1,
      exhaustedNotified: false,
    });
  });

  it('別タスクのペインでも転送済み返信の in-progress 復帰再試行は止めない', async () => {
    const { scanner, calls } = makeDeps({
      saved: { lastForwardedCommentId: 111, paneTitleUrl: PANE_TITLE_URL },
      getStates: async () => ({
        terminals: { 'pane-1': { termId: 'term-1', apiUrl: OTHER_TASK_TITLE_URL } },
      }),
    });

    await scanner();

    // ペインへは何も書き込まない経路（#154 の固着回復）なので照合対象外。
    assert.equal(calls.submitToClaude.length, 0);
    assert.deepEqual(calls.setStatus, [[221, 'status:in-progress']]);
  });

  it('別タスクのペインでも上限到達コメントの投稿は止めない', async () => {
    const { scanner, calls } = makeDeps({
      saved: {
        paneTitleUrl: PANE_TITLE_URL,
        replyForward: { commentId: 111, attempts: 3, exhaustedNotified: false },
      },
      getStates: async () => ({
        terminals: { 'pane-1': { termId: 'term-1', apiUrl: OTHER_TASK_TITLE_URL } },
      }),
    });

    await scanner();

    assert.equal(calls.submitToClaude.length, 0);
    // GitHub へのコメント投稿はペインへ書き込まないため照合対象外。
    assert.equal(calls.addTargetComment.length, 1);
  });

  it('上限到達通知後の state 更新失敗は走査外へ投げず waiting-input を維持する', async () => {
    let posted = 0;
    const { scanner, calls, getSaved } = makeDeps({
      saved: {
        replyForward: {
          commentId: 111,
          attempts: 3,
          exhaustedNotified: false,
        },
      },
      addTargetComment: async () => {
        posted += 1;
      },
      updateTask: async () => {
        throw new Error('state unavailable');
      },
    });

    await assert.doesNotReject(scanner());

    assert.equal(posted, 1);
    assert.equal(getSaved().replyForward.exhaustedNotified, false);
    assert.equal(calls.setStatus.length, 0);
  });
});
