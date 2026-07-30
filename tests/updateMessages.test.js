/**
 * アップデート文言カタログのユニットテスト。
 *
 * 同じ状況を伝える文が起動時のログと設定画面で食い違うとサポート時に別の問題として
 * 扱われてしまう。文言は 1 か所（src/engine/update-messages.js）に集約しているので、
 * ここでは「状況ごとに 1 つだけ選ばれること（優先順位）」と「環境による出し分け」を固定する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  STALE_CHECK_DAYS,
  formatCheckedAt,
  formatDiagnostics,
  formatMenuEntry,
  formatNoticeForLog,
  formatUpdateReport,
  formatVersionLine,
  isStaleCheck,
  resolveDisplayNotice,
  resolveDisplayState,
  resolveManualCommand,
  selectUpdateNotice,
} from '../src/engine/update-messages.js';

// テストのタイムゾーン差で表記が揺れないよう、ローカル時刻の部品から作る。
const CHECKED_AT = new Date(2026, 6, 30, 9, 12, 0);
const NOW = new Date(2026, 6, 30, 9, 12, 0);

describe('formatCheckedAt', () => {
  it('2026年7月30日 9:12 の形式にする', () => {
    assert.equal(formatCheckedAt(CHECKED_AT), '2026年7月30日 9:12');
  });

  it('分は 2 桁に揃える', () => {
    assert.equal(formatCheckedAt(new Date(2026, 0, 1, 0, 5, 0)), '2026年1月1日 0:05');
  });

  it('未確認・不正な値は null', () => {
    assert.equal(formatCheckedAt(null), null);
    assert.equal(formatCheckedAt(''), null);
    assert.equal(formatCheckedAt('not a date'), null);
  });
});

describe('formatVersionLine（版と確認時刻を 1 行に集約）', () => {
  it('最新のとき', () => {
    assert.equal(
      formatVersionLine({ current: '1.5.0', latest: '1.5.0', updateAvailable: false, lastCheckedAt: CHECKED_AT }),
      'お使いの版は 1.5.0 で、最新です。2026年7月30日 9:12 に確認しました。'
    );
  });

  it('新しい版があるとき', () => {
    assert.equal(
      formatVersionLine({ current: '1.4.2', latest: '1.5.0', updateAvailable: true, lastCheckedAt: CHECKED_AT }),
      '新しい版 1.5.0 があります（お使いの版は 1.4.2）。2026年7月30日 9:12 に確認しました。'
    );
  });

  it('今回の確認に失敗したときは、最後に確認できた時刻を伝える', () => {
    assert.equal(
      formatVersionLine({ current: '1.4.2', checkFailed: true, lastCheckedAt: new Date(2026, 6, 23, 9, 12) }),
      '最後に確認できたのは 2026年7月23日 9:12 です。それ以降、新しい版があるかを確認できていません。'
    );
  });

  it('一度も確認できていないとき', () => {
    assert.equal(
      formatVersionLine({ current: '1.4.2', checkFailed: true, lastCheckedAt: null }),
      '新しい版があるかを、まだ一度も確認できていません。'
    );
  });

  // 「断言する／版を落とす」の二者択一だと、確認から長く経っているときに置き場所が無い。
  // 検証できない断言（最新です）だけを落とし、いちばん有用な事実（版）は残す形を持つ。
  it('長く確認できていないときは「最新です」を付けない（版と確認時刻は残す）', () => {
    assert.equal(
      formatVersionLine({
        current: '1.5.0',
        latest: '1.5.0',
        updateAvailable: false,
        lastCheckedAt: new Date(2026, 5, 30, 13, 23),
        staleCheck: true,
      }),
      'お使いの版は 1.5.0 です。2026年6月30日 13:23 に確認しました。'
    );
  });

  it('長く確認できていなくても「新しい版がある」は残す（確認できた事実の記録）', () => {
    assert.equal(
      formatVersionLine({
        current: '1.5.0',
        latest: '1.6.0',
        updateAvailable: true,
        lastCheckedAt: new Date(2026, 5, 30, 13, 23),
        staleCheck: true,
      }),
      '新しい版 1.6.0 があります（お使いの版は 1.5.0）。2026年6月30日 13:23 に確認しました。'
    );
  });

  it('長く未確認の形でもバージョン番号が画面から消えない', () => {
    const line = formatVersionLine({ current: '1.5.0', staleCheck: true, lastCheckedAt: CHECKED_AT });
    assert.match(line, /1\.5\.0/);
  });
});

describe('selectUpdateNotice（状況ごとに 1 つだけ選ぶ）', () => {
  const base = {
    channel: 'git',
    autoUpdate: true,
    latest: '1.5.0',
    updateAvailable: true,
    lastCheckedAt: CHECKED_AT,
    now: NOW,
  };

  it('最新で問題がなければお知らせを出さない（平常時の高さを最小に保つ）', () => {
    assert.equal(
      selectUpdateNotice({ ...base, updateAvailable: false, latest: '1.5.0' }),
      null
    );
  });

  it('自動更新 OFF が最優先（未コミット変更や通信不可より先）', () => {
    const notice = selectUpdateNotice({
      ...base,
      autoUpdate: false,
      decisionReason: 'dirty',
      offline: true,
    });
    assert.equal(notice.code, 'auto-update-off');
    assert.equal(notice.tone, 'info');
    assert.equal(notice.lines[0], '自動でのアップデートを OFF にしています。');
  });

  it('自動更新 OFF でも新しい版が無ければお知らせを出さない（恒久的に居座らせない）', () => {
    assert.equal(
      selectUpdateNotice({ ...base, autoUpdate: false, updateAvailable: false, latest: '1.5.0' }),
      null
    );
  });

  it('未コミット変更は非 main や通信不可より優先し、warning にする', () => {
    const notice = selectUpdateNotice({ ...base, decisionReason: 'dirty', offline: true });
    assert.equal(notice.code, 'dirty');
    assert.equal(notice.tone, 'warning', '人が退避しないと直らないので warning');
    assert.equal(notice.lines[0], '保存していない変更があるため、アップデートを見送りました。');
  });

  it('main 以外のブランチは info（main に切り替えれば直る）', () => {
    const notice = selectUpdateNotice({
      ...base,
      decisionReason: 'non-main-branch',
      branch: 'feature/xxx',
      offline: true,
    });
    assert.equal(notice.code, 'non-main-branch');
    assert.equal(notice.tone, 'info');
    assert.equal(notice.lines[0], 'main 以外のブランチ（feature/xxx）で作業中のため、アップデートを見送りました。');
  });

  it('zip 環境では未コミット変更・非 main のお知らせを出さない（git の話をしない）', () => {
    const dirty = selectUpdateNotice({ ...base, channel: 'zip', decisionReason: 'dirty' });
    assert.equal(dirty.code, 'zip-update-available');
    const nonMain = selectUpdateNotice({ ...base, channel: 'zip', decisionReason: 'non-main-branch' });
    assert.equal(nonMain.code, 'zip-update-available');
  });

  it('オフラインは info（次回の起動で再確認する）', () => {
    const notice = selectUpdateNotice({ ...base, offline: true, distUnreachable: true });
    assert.equal(notice.code, 'offline');
    assert.equal(notice.tone, 'info');
  });

  it('配布元に繋がらないときは配布元のお知らせを出す', () => {
    const notice = selectUpdateNotice({ ...base, distUnreachable: true });
    assert.equal(notice.code, 'dist-unreachable');
    assert.equal(notice.lines[0], 'アップデートの配布元に接続できませんでした。');
  });

  // ここが重要な回帰テスト。
  // 確認に失敗したときは必ず offline / distUnreachable のどちらかが立ち、成功したときは
  // 確認時刻が現在時刻へ更新される。したがって「長く確認できていない」を offline とは
  // 別の分岐として後ろに置くと、その文言は永久に表示されない（実際にその状態だった）。
  // そのため到達可能性そのものを検証する。
  it(`オフラインが ${STALE_CHECK_DAYS} 日以上続いていれば warning へ切り替わる（到達可能であること）`, () => {
    const notice = selectUpdateNotice({
      ...base,
      offline: true,
      updateAvailable: false,
      lastCheckedAt: new Date(2026, 6, 20, 9, 12), // 10 日前
      now: NOW,
    });
    assert.equal(notice.code, 'stale-check');
    assert.equal(notice.tone, 'warning', '人がネットワークを直す必要があるので warning');
    assert.equal(notice.lines[0], `${STALE_CHECK_DAYS} 日以上、新しい版があるかを確認できていません。`);
    assert.equal(notice.lines[1], 'ネットワークの接続をご確認ください。');
  });

  it(`配布元に繋がらない状態が ${STALE_CHECK_DAYS} 日以上続いていても warning へ切り替わる`, () => {
    const notice = selectUpdateNotice({
      ...base,
      distUnreachable: true,
      updateAvailable: false,
      lastCheckedAt: new Date(2026, 6, 20, 9, 12),
      now: NOW,
    });
    assert.equal(notice.code, 'stale-check');
    assert.equal(notice.tone, 'warning');
  });

  it('短期のオフラインは info のまま（放っておけば直る）', () => {
    const notice = selectUpdateNotice({
      ...base,
      offline: true,
      updateAvailable: false,
      lastCheckedAt: new Date(2026, 6, 29, 9, 12), // 1 日前
      now: NOW,
    });
    assert.equal(notice.code, 'offline');
    assert.equal(notice.tone, 'info');
  });

  it('確認できたのなら「長く未確認」にはならない（確認時刻が現在に更新されるため）', () => {
    const notice = selectUpdateNotice({
      ...base,
      offline: false,
      distUnreachable: false,
      updateAvailable: false,
      lastCheckedAt: NOW,
      now: NOW,
    });
    assert.equal(notice, null);
  });

  it('zip 環境で新しい版があるときは終了→起動で完結すると伝える', () => {
    const notice = selectUpdateNotice({ ...base, channel: 'zip' });
    assert.equal(notice.code, 'zip-update-available');
    assert.equal(notice.lines[0], 'アプリを終了して、もう一度起動すると、新しい版 1.5.0 に切り替わります。');
    assert.equal(notice.lines[1], '実行中のタスクがあるときは、終わってから終了してください。');
  });

  it('git 環境で新しい版があれば「次の起動で自動的に切り替わる」と伝える', () => {
    const notice = selectUpdateNotice({ ...base, channel: 'git' });
    assert.equal(notice.code, 'git-update-available');
    assert.equal(notice.tone, 'info');
    assert.equal(notice.lines[0], '次にアプリを起動したときに、自動で新しい版 1.5.0 に切り替わります。');
  });

  it('入手経路が分からないまま新しい版があれば warning で入れ直しを促す', () => {
    const notice = selectUpdateNotice({ ...base, channel: 'unknown' });
    assert.equal(notice.code, 'channel-unresolved');
    assert.equal(notice.tone, 'warning');
  });

  it('入手経路が分からない利用者に git の用語や記号を出さない', () => {
    const notice = selectUpdateNotice({ ...base, channel: 'unknown' });
    const text = notice.lines.join(' ');
    // ここに落ちる典型は zip の利用者。表示は文字がそのまま出るのでバッククォートも書かない。
    assert.doesNotMatch(text, /git/i, `git の用語が漏れている: ${text}`);
    assert.doesNotMatch(text, /`/, `装飾されない記号が入っている: ${text}`);
  });

  it('どの文言にも表示で装飾されない記号（バッククォート）を入れない', () => {
    const situations = [
      { ...base, autoUpdate: false },
      { ...base, decisionReason: 'dirty' },
      { ...base, decisionReason: 'non-main-branch', branch: 'feature/x' },
      { ...base, offline: true },
      { ...base, distUnreachable: true },
      { ...base, offline: true, lastCheckedAt: new Date(2026, 6, 20, 9, 12) },
      { ...base, channel: 'zip' },
      { ...base, channel: 'git' },
      { ...base, channel: 'unknown' },
    ];
    for (const situation of situations) {
      const notice = selectUpdateNotice(situation);
      if (!notice) continue;
      assert.doesNotMatch(notice.lines.join(' '), /`/, `バッククォートが含まれる: ${notice.code}`);
    }
  });

  it('channel: off も自動更新 OFF として扱う', () => {
    assert.equal(selectUpdateNotice({ ...base, channel: 'off' }).code, 'auto-update-off');
  });
});

describe('resolveManualCommand（環境による出し分け）', () => {
  it('git 環境で新しい版があるときだけコマンドを出す', () => {
    assert.equal(
      resolveManualCommand({ channel: 'git', updateAvailable: true }),
      'git pull --ff-only && npm install'
    );
  });

  it('git 環境でも最新ならコマンドは出さない', () => {
    assert.equal(resolveManualCommand({ channel: 'git', updateAvailable: false }), null);
  });

  it('未コミット変更のときは変更を確認するコマンドを出す', () => {
    assert.equal(
      resolveManualCommand({ channel: 'git', updateAvailable: true, noticeCode: 'dirty' }),
      'git status'
    );
  });

  it('zip 環境には git のコマンドを出さない', () => {
    assert.equal(resolveManualCommand({ channel: 'zip', updateAvailable: true }), null);
    assert.equal(resolveManualCommand({ channel: 'unknown', updateAvailable: true }), null);
    assert.equal(resolveManualCommand({ channel: 'zip', updateAvailable: true, noticeCode: 'dirty' }), null);
  });
});

describe('isStaleCheck', () => {
  it('未確認（記録なし）は長期未確認として扱わない', () => {
    assert.equal(isStaleCheck({ lastCheckedAt: null, now: NOW }), false);
  });

  it('7 日以内なら false', () => {
    assert.equal(isStaleCheck({ lastCheckedAt: new Date(2026, 6, 25, 9, 12), now: NOW }), false);
  });

  it('7 日を超えていれば true', () => {
    assert.equal(isStaleCheck({ lastCheckedAt: new Date(2026, 6, 20, 9, 12), now: NOW }), true);
  });
});

// 経過時間は「見た瞬間」の性質なので、確認した瞬間の判定を記録に焼いたままでは足りない。
// 確認が走らない構成（オーケストレーターを起動しない GUI セッション、確認間隔を長くした場合、
// スリープ中など）では記録が更新されず、1 か月前の確認結果で「最新です」と出し続けてしまう。
// 経過時間は「見た瞬間」の性質なので、確認した瞬間の判定を記録に焼いたままでは足りない。
// 確認が走らない構成（オーケストレーターを起動しない GUI セッション、確認間隔を長くした場合、
// スリープ中など）では記録が更新されず、1 か月前の確認結果を今の状況として出し続けてしまう。
//
// ここは「記録のお知らせ（warning / info / なし）」×「長く未確認かどうか」の 6 通りを
// 網羅する。同じ穴を 3 度掘らないため、組み合わせを表として固定する。
describe('resolveDisplayNotice（表示する時点での見直し）', () => {
  const STALE = new Date(2026, 5, 27, 13, 23); // 33 日前
  const FRESH = new Date(2026, 6, 29, 13, 23); // 1 日前

  const WARNING = { code: 'dirty', tone: 'warning', lines: ['保存していない変更があります。'] };
  const INFO = { code: 'offline', tone: 'info', lines: ['新しい版があるかを確認できませんでした。'] };

  const CASES = [
    // [説明, 記録のお知らせ, 確認時刻, 期待する code]
    ['warning ＋ 長く未確認 → 記録の warning が勝つ（具体的で緊急度が高い）', WARNING, STALE, 'dirty'],
    ['warning ＋ 確認は新しい → 記録の warning', WARNING, FRESH, 'dirty'],
    ['info ＋ 長く未確認 → 長く未確認が勝つ', INFO, STALE, 'stale-check'],
    ['info ＋ 確認は新しい → 記録の info', INFO, FRESH, 'offline'],
    ['なし ＋ 長く未確認 → 長く未確認を合成する', null, STALE, 'stale-check'],
    ['なし ＋ 確認は新しい → 何も出さない', null, FRESH, null],
  ];

  for (const [label, notice, lastCheckedAt, expected] of CASES) {
    it(label, () => {
      const result = resolveDisplayNotice({ notice, lastCheckedAt, now: NOW });
      assert.equal(result?.code ?? null, expected);
    });
  }

  // これが回帰テストの本体。判定を `if (notice) return notice;` で短絡させると、
  // 「3 日前に確認成功 → 起動時の確認が失敗して offline(info) を記録（確認時刻は更新しない）
  // → GUI を開いたまま 30 日」で経過時間の評価に入れなくなる。
  it('記録が info なら、表示時点の経過時間の評価が効く（短絡させない）', () => {
    const result = resolveDisplayNotice({ notice: INFO, lastCheckedAt: STALE, now: NOW });
    assert.equal(result.code, 'stale-check');
    assert.equal(result.tone, 'warning');
  });

  it('記録された stale-check はそのまま通る（warning なので勝つ側）', () => {
    const recorded = { code: 'stale-check', tone: 'warning', lines: ['7 日以上…'] };
    assert.equal(resolveDisplayNotice({ notice: recorded, lastCheckedAt: STALE, now: NOW }), recorded);
  });

  it('一度も確認できていない状態は「長く未確認」にしない', () => {
    assert.equal(resolveDisplayNotice({ notice: null, lastCheckedAt: null, now: NOW }), null);
  });

  it('確認できなかったときの文言と同じものを使う（同じ状況で文が違わない）', () => {
    const fromCheck = selectUpdateNotice({
      channel: 'zip',
      offline: true,
      updateAvailable: false,
      lastCheckedAt: STALE,
      now: NOW,
    });
    const fromDisplay = resolveDisplayNotice({ notice: null, lastCheckedAt: STALE, now: NOW });
    assert.deepEqual(fromDisplay, fromCheck);
  });
});

describe('resolveDisplayState（お知らせと経過時間を一緒に返す）', () => {
  const STALE = new Date(2026, 5, 27, 13, 23);
  const WARNING = { code: 'dirty', tone: 'warning', lines: ['保存していない変更があります。'] };

  // 経過時間はお知らせの勝敗とは別の事実。記録された warning が勝った場合も成り立つので、
  // 呼び出し側が notice.code だけを見ているとバージョン行が裏付けの無い断言を出したままになる。
  it('warning が勝っても、長く未確認であることは伝える', () => {
    const state = resolveDisplayState({ notice: WARNING, lastCheckedAt: STALE, now: NOW });
    assert.equal(state.notice, WARNING);
    assert.equal(state.staleCheck, true);
  });

  it('確認が新しければ staleCheck は false', () => {
    const state = resolveDisplayState({ notice: null, lastCheckedAt: CHECKED_AT, now: NOW });
    assert.equal(state.notice, null);
    assert.equal(state.staleCheck, false);
  });

  it('resolveDisplayNotice は同じ判定の notice だけを返す（判定を 2 か所に持たない）', () => {
    for (const notice of [WARNING, { code: 'offline', tone: 'info', lines: ['x'] }, null]) {
      for (const lastCheckedAt of [STALE, CHECKED_AT]) {
        const input = { notice, lastCheckedAt, now: NOW };
        assert.deepEqual(resolveDisplayNotice(input), resolveDisplayState(input).notice);
      }
    }
  });
});

describe('formatMenuEntry（サイドバーは 1 項目・平常時は出さない）', () => {
  it('平常時は項目を出さない', () => {
    assert.equal(formatMenuEntry({ updateAvailable: false, notice: null }), null);
  });

  it('確認から長く経っていれば、記録にお知らせが無くても項目を出す', () => {
    assert.deepEqual(
      formatMenuEntry({
        updateAvailable: false,
        latest: null,
        notice: null,
        lastCheckedAt: new Date(2026, 5, 30, 13, 23),
        now: NOW,
      }),
      { icon: '⚠️', label: '新しい版を確認できていません' }
    );
  });

  it('確認が新しければ項目を出さない', () => {
    assert.equal(
      formatMenuEntry({ updateAvailable: false, notice: null, lastCheckedAt: CHECKED_AT, now: NOW }),
      null
    );
  });

  it('新しい版があるときは版を含めて知らせる', () => {
    assert.deepEqual(
      formatMenuEntry({ updateAvailable: true, latest: '1.5.0', notice: null }),
      { icon: '⬆️', label: '新しい版 1.5.0 があります' }
    );
  });

  it('アイコンとラベルを分けて返す（ラベルに絵文字を埋めない）', () => {
    const entry = formatMenuEntry({ updateAvailable: true, latest: '1.5.0' });
    // 絵文字を label に含めると、常に描かれるアイコン枠のぶんテキスト左端がずれる。
    assert.doesNotMatch(entry.label, /\p{Extended_Pictographic}/u);
    assert.match(entry.icon, /\p{Extended_Pictographic}/u);
  });

  it('人が対応しないと直らない状態（warning）は「止まっています」を優先する', () => {
    assert.deepEqual(
      formatMenuEntry({
        updateAvailable: true,
        latest: '1.5.0',
        notice: { code: 'dirty', tone: 'warning' },
      }),
      { icon: '⚠️', label: 'アップデートが止まっています' }
    );
  });

  it('確認できていない状態は「止まっています」と混同させない（止まっているのは確認）', () => {
    assert.deepEqual(
      formatMenuEntry({
        updateAvailable: false,
        latest: null,
        notice: { code: 'stale-check', tone: 'warning' },
      }),
      { icon: '⚠️', label: '新しい版を確認できていません' }
    );
  });

  it('info のお知らせだけなら「新しい版」側を出す', () => {
    assert.deepEqual(
      formatMenuEntry({
        updateAvailable: true,
        latest: '1.5.0',
        notice: { code: 'zip-update-available', tone: 'info' },
      }),
      { icon: '⬆️', label: '新しい版 1.5.0 があります' }
    );
  });

  it('サイドバーの既定幅に収まる長さに収める', () => {
    const entry = formatMenuEntry({ updateAvailable: true, latest: '1.5.0' });
    assert.ok(entry.label.length <= 20, `ラベルが長すぎる: ${entry.label}`);
  });
});

describe('formatUpdateReport / formatDiagnostics', () => {
  it('doctor 様式（記号 + 次にやること）で組み立てる', () => {
    const text = formatUpdateReport({
      channel: 'git',
      current: '1.4.2',
      latest: '1.5.0',
      updateAvailable: true,
      decision: { action: 'update', reason: 'newer-release' },
      blockers: [],
      manifest: { changelogUrl: 'https://example.com/CHANGELOG.md' },
      lastCheckedAt: CHECKED_AT,
      notice: null,
    });
    assert.match(text, /VK Orchestrator アップデート/);
    assert.match(text, /新しい版 1\.5\.0 があります/);
    assert.match(text, /git pull --ff-only && npm install/);
    assert.match(text, /https:\/\/example\.com\/CHANGELOG\.md/);
  });

  it('実行できない理由は次にやることと一緒に出す', () => {
    const text = formatUpdateReport({
      channel: 'zip',
      current: '1.4.2',
      latest: '1.5.0',
      updateAvailable: true,
      blockers: [{ code: 'busy-gui', message: 'アプリが起動中です。', hint: '終了してください。' }],
    });
    assert.match(text, /アプリが起動中です。/);
    assert.match(text, /終了してください。/);
    assert.doesNotMatch(text, /git pull/, 'zip 環境に git の話を出さない');
  });

  it('問い合わせ用の版一覧は各コンポーネントを 1 行ずつ並べる', () => {
    const text = formatDiagnostics({
      current: '1.4.2',
      latest: '1.5.0',
      channel: 'zip',
      vkTerminals: '1.48.0',
      vkAgents: 'v0.14.0',
      node: '22.1.0',
      platform: 'darwin',
    });
    assert.match(text, /VK Orchestrator: 1\.4\.2/);
    assert.match(text, /VK Terminals: 1\.48\.0/);
    assert.match(text, /vk-agents（同梱）: v0\.14\.0/);
    assert.equal(text.split('\n').length, 7);
  });

  it('起動時ログには設定画面と同じ文字列を流す', () => {
    const notice = selectUpdateNotice({
      channel: 'zip',
      latest: '1.5.0',
      updateAvailable: true,
      lastCheckedAt: CHECKED_AT,
      now: NOW,
    });
    assert.equal(formatNoticeForLog(notice), notice.lines.join(' '));
    assert.equal(formatNoticeForLog(null), null);
  });
});
