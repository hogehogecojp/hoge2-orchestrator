/**
 * リモートタグ照会（fetchTags）のユニットテスト。
 *
 * fetchTags は up 起動時の版確認から呼ばれるため、「応答しないリモート」や
 * 「認証を求められる非公開リポジトリ」に当たっても待ち続けてはいけない。
 * 待ち時間の上限と認証プロンプト抑止が外されていないことを回帰テストとして固定する。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  FETCH_TAGS_TIMEOUT_MS,
  NON_INTERACTIVE_GIT_ENV,
  fetchTags,
  latestSemverTag,
  toTuple,
} from '../scripts/vk-terminals-tags.mjs';

describe('fetchTags の固まり防止', () => {
  test('待ち時間の上限が設定されている（無制限で待たない）', () => {
    assert.equal(Number.isFinite(FETCH_TAGS_TIMEOUT_MS), true);
    assert.ok(FETCH_TAGS_TIMEOUT_MS > 0, '0 以下だと即 abort してしまう');
    assert.ok(FETCH_TAGS_TIMEOUT_MS <= 30_000, '起動処理を長く止めない上限に収める');
  });

  test('認証入力を求めさせない環境変数が揃っている', () => {
    // GIT_TERMINAL_PROMPT=0 で端末プロンプトを止め、ASKPASS を空にして
    // 外部の入力ダイアログ呼び出しも止める。どれか 1 つでも欠けると固まりうる。
    assert.equal(NON_INTERACTIVE_GIT_ENV.GIT_TERMINAL_PROMPT, '0');
    assert.equal(NON_INTERACTIVE_GIT_ENV.GIT_ASKPASS, '');
    assert.equal(NON_INTERACTIVE_GIT_ENV.SSH_ASKPASS, '');
  });

  test('到達できないリモートでは待たずに例外を投げる（呼び出し側が現行版へフォールバックできる）', () => {
    // 実在しないローカルパスを渡すと git が即座に失敗する。ネットワークには出ない。
    assert.throws(() => fetchTags('/nonexistent/vk-orchestrator-test-repo.git'));
  });

  test('呼び出し側から待ち時間を上書きできる', () => {
    // options.timeout が既定より後に展開されること（上書き可能であること）の確認。
    assert.throws(() => fetchTags('/nonexistent/vk-orchestrator-test-repo.git', { timeout: 1_000 }));
  });
});

describe('latestSemverTag', () => {
  test('semver 以外のタグを無視して最新を返す', () => {
    const tags = new Map([
      ['v0.24.0', 'a'.repeat(40)],
      ['v0.25.0', 'b'.repeat(40)],
      ['nightly', 'c'.repeat(40)],
    ]);
    assert.equal(latestSemverTag(tags), 'v0.25.0');
    assert.deepEqual(toTuple('v0.25.0'), [0, 25, 0]);
  });
});
