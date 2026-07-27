/**
 * handlePaneMissing（pane 消失時の自動再開）のユニットテスト。
 *
 * done-gate 系のテストと同様、GitHub / state / cleanup への副作用は全て fake を
 * 依存注入して検証する。カバーするケース:
 *   - pane 消失 ＋ PR 未生成 → status:ready へ自動再開（cleanup・state リセット・コメント込み）
 *   - 再開上限超過 → 従来どおり failTask（status:failed 経路）に倒す
 *   - PR あり → 何もしない（通常ルートに任せる）
 * ほか、PR 確認失敗時の見送り・ready 遷移失敗時のリトライ順序も確認する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handlePaneMissing, handleUndeliveredBody, normalizeResumeMax } from '../src/engine/pane-resume.js';

// console.log / warn を黙らせるためのスタブ
const silentLogger = { log: () => {}, warn: () => {} };

// タスク登録リポジトリ側 issue の fake（対象 issue の解決は resolveTarget の fake が担う）
const issue = {
  number: 246,
  title: 'https://github.com/owner/repo/issues/42 を対応',
  body: '対象: https://github.com/owner/repo/issues/42',
};

// 呼び出し記録付きの deps 一式を組み立てる。overrides で個別に差し替える。
function makeDeps(overrides = {}) {
  const calls = {
    findPRForIssue: [],
    cleanupForIssue: [],
    updateTask: [],
    setStatus: [],
    addComment: [],
    failTask: [],
  };
  const deps = {
    findPRForIssue: async (owner, repo, number) => {
      calls.findPRForIssue.push([owner, repo, number]);
      return null;
    },
    resolveTarget: () => ({ owner: 'owner', repo: 'repo', number: 42, isSelf: false }),
    cleanupForIssue: async (args) => {
      calls.cleanupForIssue.push(args);
      return { containers: 1 };
    },
    formatCleanupSummary: () => '- コンテナ削除: 1 件',
    updateTask: async (issueNumber, patch) => {
      calls.updateTask.push([issueNumber, patch]);
    },
    setStatus: async (issueNumber, label) => {
      calls.setStatus.push([issueNumber, label]);
    },
    addComment: async (issueNumber, body) => {
      calls.addComment.push([issueNumber, body]);
    },
    failTask: async (reason) => {
      calls.failTask.push(reason);
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('handlePaneMissing', () => {
  it('PR 未生成なら cleanup・state リセットのうえ status:ready へ自動再開する', async () => {
    const { deps, calls } = makeDeps();
    const saved = { termId: 22, wpPort: 8888, repo: 'owner/repo' };

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'resumed', resumeCount: 1 });

    // PR の有無は対象 issue（resolveTarget の結果）で確認している
    assert.deepEqual(calls.findPRForIssue, [['owner', 'repo', 42]]);

    // wp-env の掃除が wpPort 付きで走っている
    assert.equal(calls.cleanupForIssue.length, 1);
    assert.deepEqual(calls.cleanupForIssue[0], { issueNumber: 246, wpPort: 8888 });

    // 再開回数の記録 → termId / paneMissingTicks / wpPort の明示リセットの順で state を更新
    assert.equal(calls.updateTask.length, 2);
    assert.deepEqual(calls.updateTask[0], [246, { resumeCount: 1 }]);
    assert.deepEqual(calls.updateTask[1], [246, { termId: null, paneMissingTicks: 0, wpPort: null }]);

    // status:ready へ再キュー
    assert.deepEqual(calls.setStatus, [[246, 'status:ready']]);

    // 「N/上限回目」形式の自動再開コメント（クリーンアップ結果込み）
    assert.equal(calls.addComment.length, 1);
    assert.equal(calls.addComment[0][0], 246);
    assert.match(calls.addComment[0][1], /🔁 作業ペイン消失を検知したため自動再開しました（1\/3回目）/);
    assert.match(calls.addComment[0][1], /コンテナ削除: 1 件/);

    // failed 経路には入らない
    assert.equal(calls.failTask.length, 0);
  });

  it('再開上限を超過したら従来どおり failTask（status:failed 経路）に倒す', async () => {
    const { deps, calls } = makeDeps();
    // 既に上限（3 回）まで再開済みのタスク
    const saved = { termId: 22, wpPort: 8888, resumeCount: 3 };

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'failed' });

    // failed 化は failTask（markTaskFailed 相当）に委譲し、理由に上限超過が分かる文言を含む
    assert.equal(calls.failTask.length, 1);
    assert.match(calls.failTask[0], /termId:22/);
    assert.match(calls.failTask[0], /上限 3 回/);

    // 再開系の副作用は一切走らない
    assert.equal(calls.setStatus.length, 0);
    assert.equal(calls.addComment.length, 0);
    assert.equal(calls.updateTask.length, 0);
    assert.equal(calls.cleanupForIssue.length, 0);
  });

  it('PR が既にあるタスクは再開しない（通常ルートに任せて何もしない）', async () => {
    const { deps, calls } = makeDeps({
      findPRForIssue: async () => ({ number: 99, html_url: 'https://github.com/owner/repo/pull/99' }),
    });
    const saved = { termId: 22, wpPort: 8888 };

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'has-pr' });

    // 再開・failed いずれの副作用も走らない
    assert.equal(calls.cleanupForIssue.length, 0);
    assert.equal(calls.updateTask.length, 0);
    assert.equal(calls.setStatus.length, 0);
    assert.equal(calls.addComment.length, 0);
    assert.equal(calls.failTask.length, 0);
  });

  it('PR 確認に失敗したら今回は見送る（次ループで再評価・副作用なし）', async () => {
    const { deps, calls } = makeDeps({
      findPRForIssue: async () => {
        throw new Error('rate limit');
      },
    });

    const result = await handlePaneMissing(issue, { termId: 22 }, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'skipped' });
    assert.equal(calls.cleanupForIssue.length, 0);
    assert.equal(calls.updateTask.length, 0);
    assert.equal(calls.setStatus.length, 0);
    assert.equal(calls.failTask.length, 0);
  });

  it('2 回目の再開はコメントの回数表記と resumeCount が増える', async () => {
    const { deps, calls } = makeDeps();
    const saved = { termId: 30, wpPort: 8890, resumeCount: 1 };

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'resumed', resumeCount: 2 });
    assert.deepEqual(calls.updateTask[0], [246, { resumeCount: 2 }]);
    assert.match(calls.addComment[0][1], /（2\/3回目）/);
  });

  it('wpPort が無いタスク（wp-env 無効）は cleanup をスキップして再開する', async () => {
    const { deps, calls } = makeDeps();
    const saved = { termId: 22, wpPort: null };

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'resumed', resumeCount: 1 });
    assert.equal(calls.cleanupForIssue.length, 0);
    assert.deepEqual(calls.setStatus, [[246, 'status:ready']]);
    // コメントにクリーンアップ結果セクションは付かない
    assert.doesNotMatch(calls.addComment[0][1], /クリーンアップ結果/);
  });

  it('ready 遷移に失敗したら state はリセットせず次ループの再検知に委ねる（resumeCount は記録済み）', async () => {
    const { deps, calls } = makeDeps({
      setStatus: async () => {
        throw new Error('label API down');
      },
    });
    const saved = { termId: 22, wpPort: 8888 };

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'retry', resumeCount: 1 });

    // resumeCount は ready 遷移前に記録される（遷移失敗の繰り返しが無限リトライに化けない）
    assert.deepEqual(calls.updateTask, [[246, { resumeCount: 1 }]]);
    // termId を残したまま戻るので、次ループの scanWatchdog が pane 消失を再検知できる
    assert.equal(calls.addComment.length, 0);
    assert.equal(calls.failTask.length, 0);
  });

  it('resumeMax オプションで上限を上書きできる（既定 3 回）', async () => {
    const { deps, calls } = makeDeps();
    const saved = { termId: 22, resumeCount: 1 };

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: 1,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'failed' });
    assert.match(calls.failTask[0], /上限 1 回/);
  });

  it('resumeMax が NaN でも上限判定が無効化されず既定 3 回で failed に倒れる', async () => {
    // NaN のまま `resumeCount > resumeMax` を評価すると常に false になり、
    // 無限リトライ防止（唯一の安全装置）が沈黙のうちに外れる回帰を防ぐ。
    const { deps, calls } = makeDeps();
    const saved = { termId: 22, resumeCount: 3 };

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: Number('abc'), // NaN
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'failed' });
    assert.equal(calls.failTask.length, 1);
    assert.match(calls.failTask[0], /上限 3 回/);
    assert.equal(calls.setStatus.length, 0);
  });

  it('resumeMax が負数なら既定 3 回にフォールバックする（常に即 failed にならない）', async () => {
    const { deps, calls } = makeDeps();
    const saved = { termId: 22, wpPort: 8888 }; // 初回消失（resumeCount 未記録）

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: -5,
      logger: silentLogger,
    });

    // 負数のまま採用されると 1 > -5 で即 failed になるが、既定 3 に戻るので再開される
    assert.deepEqual(result, { action: 'resumed', resumeCount: 1 });
    assert.equal(calls.failTask.length, 0);
    assert.match(calls.addComment[0][1], /（1\/3回目）/);
  });

  it('resumeMax が 0 なら自動再開せず常に failed（有効な「無効化」設定）', async () => {
    const { deps, calls } = makeDeps();
    const saved = { termId: 22 };

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: 0,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'failed' });
    assert.match(calls.failTask[0], /上限 0 回/);
    assert.equal(calls.setStatus.length, 0);
  });
});

// issue #172: submitToClaude が本文の取りこぼし（bodyConfirmed=false）を返したとき、
// in-progress のまま放置せず handlePaneMissing と同じコアで status:ready へ戻して
// 自動再ディスパッチする。トリガ理由の文言以外は pane 消失時と挙動を共有し、
// resumeCount / 上限（PANE_RESUME_MAX）は pane 消失と合算で管理する。
describe('handleUndeliveredBody', () => {
  it('本文未達なら cleanup・state リセットのうえ status:ready へ自動再開する', async () => {
    const { deps, calls } = makeDeps();
    const saved = { termId: 22, wpPort: 8888, repo: 'owner/repo' };

    const result = await handleUndeliveredBody(issue, saved, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'resumed', resumeCount: 1 });

    // PR の有無を対象 issue で確認している（PR ありなら通常ルートに任せる保険）
    assert.deepEqual(calls.findPRForIssue, [['owner', 'repo', 42]]);

    // wp-env の掃除が wpPort 付きで走っている
    assert.equal(calls.cleanupForIssue.length, 1);
    assert.deepEqual(calls.cleanupForIssue[0], { issueNumber: 246, wpPort: 8888 });

    // resumeCount 記録 → termId/paneMissingTicks/wpPort の明示リセットの順で state を更新。
    // termId は必ず null に戻す（残すと生存ペインへの in-progress 再試行経路に入り、
    // 空プロンプトのゾンビペインへ再送してしまうため）。
    assert.equal(calls.updateTask.length, 2);
    assert.deepEqual(calls.updateTask[0], [246, { resumeCount: 1 }]);
    assert.deepEqual(calls.updateTask[1], [246, { termId: null, paneMissingTicks: 0, wpPort: null }]);

    // status:ready へ再キュー
    assert.deepEqual(calls.setStatus, [[246, 'status:ready']]);

    // 本文未達を明示する自動再開コメント（pane 消失とは文言が異なる）
    assert.equal(calls.addComment.length, 1);
    assert.equal(calls.addComment[0][0], 246);
    assert.match(calls.addComment[0][1], /本文/);
    assert.match(calls.addComment[0][1], /（1\/3回目）/);

    // failed 経路には入らない
    assert.equal(calls.failTask.length, 0);
  });

  it('resumeCount が pane 消失と合算で上限超過したら failTask に倒す', async () => {
    const { deps, calls } = makeDeps();
    // 既に（pane 消失などで）上限まで再開済みのタスク
    const saved = { termId: 22, wpPort: 8888, resumeCount: 3 };

    const result = await handleUndeliveredBody(issue, saved, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'failed' });
    assert.equal(calls.failTask.length, 1);
    assert.match(calls.failTask[0], /termId:22/);
    assert.match(calls.failTask[0], /上限 3 回/);

    // 再開系の副作用は一切走らない（in-progress のまま放置もしない）
    assert.equal(calls.setStatus.length, 0);
    assert.equal(calls.addComment.length, 0);
    assert.equal(calls.updateTask.length, 0);
    assert.equal(calls.cleanupForIssue.length, 0);
  });

  it('PR が既にあるタスクは再開しない（通常ルートに任せる）', async () => {
    const { deps, calls } = makeDeps({
      findPRForIssue: async () => ({ number: 99, html_url: 'https://github.com/owner/repo/pull/99' }),
    });

    const result = await handleUndeliveredBody(issue, { termId: 22, wpPort: 8888 }, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'has-pr' });
    assert.equal(calls.setStatus.length, 0);
    assert.equal(calls.failTask.length, 0);
  });
});

describe('normalizeResumeMax', () => {
  it('有効値はそのまま・小数は切り捨て・不正値は既定 3 にフォールバックする', () => {
    // 有効値（数値・数値文字列・0）
    assert.equal(normalizeResumeMax(5), 5);
    assert.equal(normalizeResumeMax('2'), 2);
    assert.equal(normalizeResumeMax(0), 0);
    // 非整数は切り捨て
    assert.equal(normalizeResumeMax(2.9), 2);
    // 不正値（NaN・非数値文字列・負数・Infinity・undefined）は既定 3
    assert.equal(normalizeResumeMax(NaN), 3);
    assert.equal(normalizeResumeMax('abc'), 3);
    assert.equal(normalizeResumeMax(-1), 3);
    assert.equal(normalizeResumeMax(Infinity), 3);
    assert.equal(normalizeResumeMax(undefined), 3);
    // フォールバック値の上書き
    assert.equal(normalizeResumeMax('abc', 5), 5);
  });

  it('空文字・空白のみ・null は「未設定」として既定 3 に倒す（0 扱いにしない）', () => {
    // Number('') === 0 のため、素通しすると PANE_RESUME_MAX=（空文字の env 指定）が
    // 「自動再開無効化（0）」として意図せず発動する。未設定系は既定 3 へ。
    assert.equal(normalizeResumeMax(''), 3);
    assert.equal(normalizeResumeMax('  '), 3);
    assert.equal(normalizeResumeMax(null), 3);
    assert.equal(normalizeResumeMax(undefined), 3);
    // 明示指定の 0（数値・文字列）は引き続き有効値（自動再開無効化）
    assert.equal(normalizeResumeMax(0), 0);
    assert.equal(normalizeResumeMax('0'), 0);
    // フォールバック値の上書きも未設定系に効く
    assert.equal(normalizeResumeMax('', 5), 5);
  });
});
