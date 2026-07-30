/**
 * レビュー完了マーカー未付与による自動マージ保留の可視化（#251）のテスト。
 *
 * 自動マージの最終判定は、PR にレビュー完了マーカー（`agent-review-passed` ラベル＋
 * 現 head SHA と一致する `agent-review-passed-sha:` コメント）が無いと保留する。
 * 従来はログに出るだけだったため、メタ issue へ 1 回だけ通知し、停止理由ラベル
 * `blocked:review-incomplete`（タスクカードの要対応バッジ）を付ける。
 *
 * ラベルの有無が冪等性の唯一の真実なので、
 *   - ラベルが無いときだけ「付与 + 通知」
 *   - ラベルが既にあるときは何もしない（毎ループ通知しない）
 *   - マーカーが付いた / PR がマージ・close された時点で除去
 *   - マーカーの有無を判定できなかったときは付けも外しもしない（fail-closed）
 * を検証する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_LABELS, getLabelsConfig } from '../src/config.js';
import {
  BLOCKED_REASON_REVIEW_INCOMPLETE,
  blockedReasonFromLabels,
  collectStaleBlockedIssues,
  decideBlockedLabelForReviewIncomplete,
  shouldDisplayBlockedReason,
} from '../src/engine/blocked-reason.js';
import {
  BLOCKED_REASON_DISPLAY_LABELS,
  BLOCKED_REASON_EMPHASIS,
  BLOCKED_REASON_PRIORITY,
  BLOCKED_REASON_TONES,
} from '../src/engine/task-domain.js';
import {
  buildReviewIncompleteComment,
  createReviewIncompleteBlockedSync,
} from '../src/engine/review-gate-blocked.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BLOCKED_LABEL = 'blocked:review-incomplete';
const PR_URL = 'https://github.com/vektor-inc/example/pull/79';
const PR_REF = { owner: 'vektor-inc', repo: 'example', number: 79 };
const HEAD_SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const openPR = { state: 'open', merged: false, mergeable: true, mergeableState: 'clean' };

// GitHub API を叩かずに付け外し・通知の呼び出し順を記録するハーネス。
// issue.labels を実際に書き換えるので、同じ issue で 2 周回して冪等性を確認できる。
function createHarness({ labels = [], failOn = null } = {}) {
  const issue = { number: 251, labels: [...labels] };
  const calls = [];
  const warnings = [];
  const sync = createReviewIncompleteBlockedSync({
    addBlockedReasonLabel: async (issueNumber, reason) => {
      if (failOn === 'add') throw new Error('add failed');
      calls.push(['add', issueNumber, reason]);
      issue.labels.push({ name: BLOCKED_LABEL });
    },
    removeBlockedReasonLabel: async (issueNumber, reason) => {
      calls.push(['remove', issueNumber, reason]);
      issue.labels = issue.labels.filter(
        (label) => (typeof label === 'string' ? label : label?.name) !== BLOCKED_LABEL
      );
    },
    addComment: async (issueNumber, body) => {
      if (failOn === 'comment') throw new Error('comment failed');
      calls.push(['comment', issueNumber, body]);
    },
    getBlockedLabel: () => BLOCKED_LABEL,
    logger: { warn: (message) => warnings.push(message) },
  });
  const run = (params = {}) => sync({
    issue,
    prState: openPR,
    prUrl: PR_URL,
    prRef: PR_REF,
    headSha: HEAD_SHA,
    tag: '[automerge] issue #251',
    ...params,
  });
  return { issue, calls, warnings, run };
}

describe('停止理由ラベルの定義', () => {
  it('既定ラベル名と bare 名が揃っている', () => {
    assert.equal(BLOCKED_REASON_REVIEW_INCOMPLETE, 'review-incomplete');
    assert.equal(DEFAULT_LABELS.blocked[BLOCKED_REASON_REVIEW_INCOMPLETE], BLOCKED_LABEL);
    assert.equal(getLabelsConfig().blocked[BLOCKED_REASON_REVIEW_INCOMPLETE], BLOCKED_LABEL);
  });

  it('設定から上書きできる（既存の停止理由と同じ仕組みに乗る）', () => {
    const labels = getLabelsConfig({ labels: { blocked: { 'review-incomplete': 'needs-review' } } });
    assert.equal(labels.blocked['review-incomplete'], 'needs-review');
    assert.equal(labels.blocked.conflict, 'blocked:conflict');
  });
});

describe('decideBlockedLabelForReviewIncomplete', () => {
  it('判定表を網羅する', () => {
    const cases = [
      ['マーカー無し + ラベル無し → 付与して通知',
        { prState: openPR, reviewPassed: false }, { action: 'add', notify: true }],
      ['マーカー無し + ラベルあり → 何もしない（再通知しない）',
        { prState: openPR, reviewPassed: false, hasBlockedLabel: true }, { action: 'none', notify: false }],
      ['マーカーあり + ラベルあり → 除去',
        { prState: openPR, reviewPassed: true, hasBlockedLabel: true }, { action: 'remove', notify: false }],
      ['マーカーあり + ラベル無し → 何もしない',
        { prState: openPR, reviewPassed: true }, { action: 'none', notify: false }],
      ['判定不能(null) + ラベル無し → 付けない',
        { prState: openPR, reviewPassed: null }, { action: 'none', notify: false }],
      ['判定不能(null) + ラベルあり → 外さない',
        { prState: openPR, reviewPassed: null, hasBlockedLabel: true }, { action: 'none', notify: false }],
      ['PR マージ済み + ラベルあり → 除去',
        { prState: { state: 'closed', merged: true }, reviewPassed: false, hasBlockedLabel: true }, { action: 'remove', notify: false }],
      ['PR close 済み + ラベルあり → 除去',
        { prState: { state: 'closed', merged: false }, reviewPassed: false, hasBlockedLabel: true }, { action: 'remove', notify: false }],
      ['バッジ表示対象外ステータス → 付けない（掃除と付与の往復で通知が増えるため）',
        { prState: openPR, reviewPassed: false, statusAllowsBlockedLabel: false }, { action: 'none', notify: false }],
      ['バッジ表示対象外ステータスでも除去はする',
        { prState: openPR, reviewPassed: true, hasBlockedLabel: true, statusAllowsBlockedLabel: false }, { action: 'remove', notify: false }],
    ];
    for (const [name, input, expected] of cases) {
      assert.deepEqual(decideBlockedLabelForReviewIncomplete(input), expected, name);
    }
  });

  it('引数無しでも例外を投げず何もしないを返す', () => {
    assert.deepEqual(decideBlockedLabelForReviewIncomplete(), { action: 'none', notify: false });
  });
});

describe('syncReviewIncompleteBlockedLabel', () => {
  it('マーカー無しで保留したとき、ラベルが無ければ通知 + ラベル付与を 1 回だけ行う', async () => {
    const h = createHarness();
    await h.run({ reviewPassed: false });
    await h.run({ reviewPassed: false });
    await h.run({ reviewPassed: false });

    assert.deepEqual(
      h.calls.map(([kind]) => kind),
      ['add', 'comment'],
      '2 周目以降は付与も通知もしない'
    );
    assert.equal(h.calls[0][2], BLOCKED_REASON_REVIEW_INCOMPLETE);
    assert.equal(h.calls[0][1], 251);
  });

  it('ラベルが既にあるときは再通知しない', async () => {
    const h = createHarness({ labels: [{ name: 'status:waiting-merge' }, { name: BLOCKED_LABEL }] });
    await h.run({ reviewPassed: false });
    assert.deepEqual(h.calls, []);
  });

  it('マーカーが付いたらラベルを除去する（通知はしない）', async () => {
    const h = createHarness({ labels: [{ name: BLOCKED_LABEL }] });
    await h.run({ reviewPassed: true });
    assert.deepEqual(h.calls, [['remove', 251, BLOCKED_REASON_REVIEW_INCOMPLETE]]);
    assert.deepEqual(h.issue.labels, []);
  });

  it('マーカーが付いてもラベルが無ければ API を叩かない', async () => {
    const h = createHarness();
    await h.run({ reviewPassed: true });
    assert.deepEqual(h.calls, []);
  });

  it('マーカー確認が失敗して有無を判定できないときは付けも外しもしない', async () => {
    const without = createHarness();
    await without.run({ reviewPassed: null });
    assert.deepEqual(without.calls, [], 'ラベル無し: 付けない');

    const withLabel = createHarness({ labels: [{ name: BLOCKED_LABEL }] });
    await withLabel.run({ reviewPassed: null });
    assert.deepEqual(withLabel.calls, [], 'ラベルあり: 外さない');
  });

  it('PR がマージ・close されたらラベルが残らない', async () => {
    for (const prState of [{ state: 'closed', merged: true }, { state: 'closed', merged: false }]) {
      const h = createHarness({ labels: [{ name: BLOCKED_LABEL }] });
      await h.run({ prState });
      assert.deepEqual(h.calls, [['remove', 251, BLOCKED_REASON_REVIEW_INCOMPLETE]], JSON.stringify(prState));
    }
  });

  it('コメント投稿に失敗してもラベルは残り、次ループで再通知しない', async () => {
    const h = createHarness({ failOn: 'comment' });
    await h.run({ reviewPassed: false });
    assert.deepEqual(h.calls, [['add', 251, BLOCKED_REASON_REVIEW_INCOMPLETE]]);
    assert.equal(h.warnings.length, 1);

    await h.run({ reviewPassed: false });
    assert.deepEqual(h.calls, [['add', 251, BLOCKED_REASON_REVIEW_INCOMPLETE]], '再通知しない');
  });

  it('ラベル付与に失敗しても例外を外へ出さず、次ループで再試行できる', async () => {
    const h = createHarness({ failOn: 'add' });
    await assert.doesNotReject(() => h.run({ reviewPassed: false }));
    assert.deepEqual(h.calls, [], 'ラベルが付いていないのでコメントも投稿しない');
    assert.equal(h.warnings.length, 1);
    assert.deepEqual(h.issue.labels, []);
  });

  it('設定でラベル名を変えても、その名前で有無を判定する', async () => {
    const calls = [];
    const issue = { number: 251, labels: [{ name: 'needs-review' }] };
    const sync = createReviewIncompleteBlockedSync({
      addBlockedReasonLabel: async () => calls.push('add'),
      removeBlockedReasonLabel: async () => calls.push('remove'),
      addComment: async () => calls.push('comment'),
      getBlockedLabel: () => 'needs-review',
      logger: { warn: () => {} },
    });
    await sync({ issue, prState: openPR, reviewPassed: false, tag: '[automerge]' });
    assert.deepEqual(calls, [], '改名済みラベルを付与済みとして認識する');
  });
});

describe('buildReviewIncompleteComment', () => {
  const body = buildReviewIncompleteComment({
    prUrl: PR_URL,
    prRef: PR_REF,
    headSha: HEAD_SHA,
    blockedLabel: BLOCKED_LABEL,
  });

  it('何が起きているか・PR・復帰手順・再開条件が入っている', () => {
    assert.match(body, /自動マージを保留/);
    assert.ok(body.includes(PR_URL));
    assert.ok(body.includes(BLOCKED_LABEL));
    assert.ok(body.includes('agent-review-passed'));
    assert.ok(body.includes(`agent-review-passed-sha: ${HEAD_SHA}`));
    assert.match(body, /次の巡回/);
  });

  it('人の対応待ちであることが分かる文面になっている', () => {
    assert.match(body, /対応待ち/);
    assert.ok(!body.includes('Comment by vk-agents'), 'decision-record 書式では書かない');
    assert.ok(!body.includes('Status:'), 'decision-record 書式では書かない');
  });

  it('解消後にどう見えるか（バッジが消える）と手動マージへの逃げ道を案内する', () => {
    assert.match(body, /^- タスクカードの「要対応: レビュー未完了」バッジも次の巡回で消えます。/m);
    assert.match(body, /バッジが出ていなければ、このコメントへの対応は完了しています/);
    assert.match(body, /^- このタスクの自動マージをやめて手動でマージする場合は、この issue の `automerge` ラベルを外して/m);
  });

  it('末尾の補足は 1 文段落を並べず箇条書きにまとめる', () => {
    const lines = body.split('\n');
    const bulletIndexes = lines.reduce(
      (acc, line, index) => (line.startsWith('- ') ? [...acc, index] : acc),
      []
    );
    assert.equal(bulletIndexes.length, 2, '補足は 2 項目');
    assert.equal(bulletIndexes[1] - bulletIndexes[0], 1, '項目間に空行を挟まず 1 ブロックにする');
    assert.equal(lines[bulletIndexes[0] - 1], '', '箇条書きの前は空行で区切る');
    assert.equal(bulletIndexes[1], lines.length - 1, '本文は箇条書きで終わる');
  });

  it('gh コマンド例は PR URL ではなく解決済みの owner/repo/番号で組み立てる', () => {
    assert.ok(body.includes('gh pr edit 79 --repo vektor-inc/example --add-label agent-review-passed'));
    assert.ok(body.includes('gh pr comment 79 --repo vektor-inc/example'));
    assert.ok(body.includes('gh label create agent-review-passed --repo vektor-inc/example'));
  });

  // コピペすると絶対に一致しないマーカーを投稿できてしまうため、
  // コミット ID の形式が確かめられないときはコマンド例を一切出さない。
  it('コミット ID が不正・未取得ならコマンド例を出さず、確認方法を案内する', () => {
    for (const headSha of [null, undefined, '', '   ', '<SHA>', 'not-a-sha', 'abc', 'ABCDEF1234567', `${HEAD_SHA}0`]) {
      const fallback = buildReviewIncompleteComment({
        prUrl: PR_URL,
        prRef: PR_REF,
        headSha,
        blockedLabel: BLOCKED_LABEL,
      });
      const label = JSON.stringify(headSha);
      assert.ok(!fallback.includes('```sh'), `${label}: コマンドブロックを出さない`);
      assert.ok(!fallback.includes('gh pr comment'), `${label}: 投稿コマンドを出さない`);
      assert.ok(!fallback.includes('gh CLI なら次の 2 コマンド'), `${label}: コマンド案内の一文も出さない`);
      assert.ok(!fallback.includes('<SHA>'), `${label}: プレースホルダを本文に残さない`);
      assert.ok(
        fallback.includes('gh pr view 79 --repo vektor-inc/example --json headRefOid'),
        `${label}: コミット ID の確認方法を案内する`
      );
      // Conversation タブの最下部は最新コミットとは限らないため、Commits タブを案内する。
      assert.ok(fallback.includes('Commits タブの最下段のコミット'), `${label}: 確認先が正確`);
      assert.ok(!fallback.includes('PR ページの一番下'), `${label}: 迷う案内を残さない`);
      assert.match(fallback, /PR 画面だけでも行えます/, `${label}: 画面での代替手順で締める`);
    }
  });

  it('短縮 SHA（7 桁以上）はそのままコマンド例に使う', () => {
    const short = buildReviewIncompleteComment({
      prUrl: PR_URL,
      prRef: PR_REF,
      headSha: '1f2e3d4',
      blockedLabel: BLOCKED_LABEL,
    });
    assert.ok(short.includes('agent-review-passed-sha: 1f2e3d4'));
    assert.ok(short.includes('```sh'));
  });

  it('前後の空白付きコミット ID は詰めて使う', () => {
    const padded = buildReviewIncompleteComment({
      prUrl: PR_URL,
      prRef: PR_REF,
      headSha: `\n ${HEAD_SHA} `,
      blockedLabel: BLOCKED_LABEL,
    });
    assert.ok(padded.includes(`--body "agent-review-passed-sha: ${HEAD_SHA}"`));
  });

  it('PR の owner/repo/番号を解決できない場合もコマンド例抜きで実行できる手順で終わる', () => {
    const fallback = buildReviewIncompleteComment({
      prUrl: PR_URL,
      headSha: HEAD_SHA,
      blockedLabel: BLOCKED_LABEL,
    });
    assert.ok(fallback.includes(PR_URL));
    assert.ok(!fallback.includes('gh pr edit'), 'リポジトリを指定できないコマンドは出さない');
    assert.ok(!fallback.includes('gh CLI なら次の 2 コマンド'));
    assert.ok(fallback.includes('gh pr view <PR 番号> --json headRefOid'));
    assert.match(fallback, /PR 画面だけでも行えます/);
  });
});

describe('バッジの表示語彙と優先順', () => {
  it('停止理由バッジの tone は理由によらず danger で統一する', () => {
    assert.equal(BLOCKED_REASON_DISPLAY_LABELS[BLOCKED_REASON_REVIEW_INCOMPLETE], '要対応: レビュー未完了');
    assert.equal(BLOCKED_REASON_TONES[BLOCKED_REASON_REVIEW_INCOMPLETE], 'danger');
    assert.equal(BLOCKED_REASON_TONES.conflict, 'danger');
    assert.equal(BLOCKED_REASON_EMPHASIS[BLOCKED_REASON_REVIEW_INCOMPLETE], 'attention');
  });

  it('優先順は明示した配列で決まり、設定のキー記述順に依存しない', () => {
    assert.deepEqual([...BLOCKED_REASON_PRIORITY], ['conflict', 'review-incomplete']);
    const labels = ['status:waiting-merge', 'blocked:conflict', BLOCKED_LABEL];
    const conflictFirst = { blocked: { conflict: 'blocked:conflict', 'review-incomplete': BLOCKED_LABEL } };
    const reviewFirst = { blocked: { 'review-incomplete': BLOCKED_LABEL, conflict: 'blocked:conflict' } };
    assert.equal(blockedReasonFromLabels(labels, { labelsConfig: conflictFirst }), 'conflict');
    assert.equal(blockedReasonFromLabels(labels, { labelsConfig: reviewFirst }), 'conflict', '書き順を変えても同じ');
  });

  it('片方だけ立っているときはその理由を返す', () => {
    const labelsConfig = { blocked: DEFAULT_LABELS.blocked };
    assert.equal(
      blockedReasonFromLabels([BLOCKED_LABEL], { labelsConfig }),
      BLOCKED_REASON_REVIEW_INCOMPLETE
    );
    assert.equal(blockedReasonFromLabels(['blocked:conflict'], { labelsConfig }), 'conflict');
  });

  it('レビュー未完了は waiting-merge でだけバッジ表示する', () => {
    assert.equal(
      shouldDisplayBlockedReason({ status: 'waiting-merge', blockedReason: BLOCKED_REASON_REVIEW_INCOMPLETE }),
      true
    );
    assert.equal(
      shouldDisplayBlockedReason({ status: 'waiting-input', blockedReason: BLOCKED_REASON_REVIEW_INCOMPLETE }),
      false
    );
  });
});

describe('タスク登録リポジトリへ登録するラベル定義', () => {
  it('停止理由ラベルの色を優先度ラベルと同じ黄色にしない', () => {
    // ensure-task-queue-label.mjs は import すると gh を実行するため、定義行だけを読んで検証する。
    const source = readFileSync(
      join(__dirname, '..', 'src', 'engine', 'ensure-task-queue-label.mjs'),
      'utf8'
    );
    const line = source.split('\n').find((l) => l.includes(`name: '${BLOCKED_LABEL}'`));
    assert.ok(line, '定義行がある');
    assert.match(line, /color: 'd93f0b'/);
    assert.ok(!line.includes('fbca04'), 'priority:medium と同じ黄色は使わない');
  });
});

describe('取り残しラベルの掃除', () => {
  it('waiting-merge 以外へ移った issue の blocked:review-incomplete も掃除対象になる', () => {
    const labelsConfig = {
      status: { waitingMerge: 'status:waiting-merge', ready: 'status:ready' },
      blocked: DEFAULT_LABELS.blocked,
    };
    const issues = [
      { number: 1, labels: ['status:waiting-merge', BLOCKED_LABEL] },
      { number: 2, labels: ['status:ready', BLOCKED_LABEL] },
    ];
    assert.deepEqual(collectStaleBlockedIssues(issues, { labelsConfig }), [
      { number: 2, blockedLabels: [BLOCKED_LABEL] },
    ]);
  });
});

describe('tryAutoMerge の配線（src/engine/index.js）', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'engine', 'index.js'), 'utf8');

  it('マーカー確認が例外で失敗した経路ではラベル同期を呼ばずに return する', () => {
    const gate = source.slice(source.indexOf('reviewPassed = await github.hasReviewGateMarker'));
    const catchBlock = gate.slice(gate.indexOf('} catch (err) {'), gate.indexOf('await syncReviewIncompleteBlockedLabel'));
    assert.ok(catchBlock.includes('return;'), '判定できないまま先へ進まない');
    assert.ok(
      !catchBlock.includes('syncReviewIncompleteBlockedLabel'),
      'マーカーの有無が不明なときはラベルを付けも外しもしない'
    );
  });

  it('マージ検知ループでも PR 状態に応じてラベルを同期する（マージ済みに残さない）', () => {
    const loop = source.slice(source.indexOf('async function checkWaitingMergeIssues'));
    const body = loop.slice(0, loop.indexOf("if (action === 'complete-merge')"));
    assert.ok(body.includes('await syncReviewIncompleteBlockedLabel('), 'close 前に同期している');
  });
});
