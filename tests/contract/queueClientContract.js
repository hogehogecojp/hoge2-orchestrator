import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * キュークライアント抽象の契約テスト。GitHubClient / 後続の LocalQueueClient 等、
 * 実装に依存しない「インターフェースの振る舞い」だけを検証する再利用スイート。
 *
 * 各アダプタのテストファイルから呼び出す。
 *
 * @param {object} opts
 * @param {string} opts.label  スイート名に使うクライアント種別ラベル（例: 'GitHubClient'）
 * @param {(seedIssues: Array<object>) => (Promise<object>|object)} opts.createClient
 *   与えた open issue 群を listAllQueueIssues() が返すようなクライアントを生成するファクトリ。
 */
export function runQueueClientContract({ label, createClient }) {
  test(`[contract:${label}] listAllQueueIssues は関数として実装されている`, async () => {
    const client = await createClient([]);
    assert.equal(typeof client.listAllQueueIssues, 'function');
  });

  test(`[contract:${label}] listAllQueueIssues は配列を返す`, async () => {
    const client = await createClient([]);
    const result = await client.listAllQueueIssues();
    assert.ok(Array.isArray(result));
  });

  test(`[contract:${label}] 種を与えていなければ空配列を返す`, async () => {
    const client = await createClient([]);
    assert.deepEqual(await client.listAllQueueIssues(), []);
  });

  test(`[contract:${label}] 全ての open issue を assignee で絞らず返す`, async () => {
    const seed = [
      { number: 1, title: 'a', assignees: [{ login: 'wada' }] },
      { number: 2, title: 'b', assignees: [] },
      { number: 3, title: 'c', assignees: [{ login: 'tsukasa' }] },
    ];
    const client = await createClient(seed);
    const result = await client.listAllQueueIssues();
    assert.deepEqual(
      result.map((issue) => issue.number).sort((a, b) => a - b),
      [1, 2, 3],
    );
  });
}
