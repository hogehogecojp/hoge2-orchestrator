/**
 * evaluateSyncExit（setup:agents における sync.sh 終了コードの解釈）のユニットテスト。
 *
 * sync.sh の終了コードは 0=成功 / 2=部分成功 / それ以外=失敗 の 3 段階。
 * 部分成功を失敗扱いにすると展開元サイドカーの記録が残らないため、
 * 分岐を純関数として切り出して検証している。カバーするケース:
 *   - 0    → 続行・警告なし
 *   - 2    → 続行・警告あり（配布は完了している）
 *   - 1    → 中断・終了コード 1
 *   - 3    → 中断・受け取った終了コードをそのまま返す
 *   - null → 中断・終了コード 1 へフォールバック（シグナル終了・spawn 失敗）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateSyncExit,
  SYNC_EXIT_SUCCESS,
  SYNC_EXIT_PARTIAL_SUCCESS,
} from '../src/setup/sync-exit.js';

describe('evaluateSyncExit', () => {
  it('終了コード 0（成功）は警告なしで続行する', () => {
    const outcome = evaluateSyncExit(SYNC_EXIT_SUCCESS);
    assert.deepEqual(outcome, { proceed: true, warning: null, exitCode: null });
  });

  it('終了コード 2（部分成功）は警告を出したうえで続行する', () => {
    const outcome = evaluateSyncExit(SYNC_EXIT_PARTIAL_SUCCESS);
    assert.equal(outcome.proceed, true);
    assert.equal(outcome.exitCode, null);
    assert.equal(typeof outcome.warning, 'string');
    // 「sync.sh の出力を確認する」導線があること。
    assert.match(outcome.warning, /sync\.sh の出力を確認/);
    // 断定せず「可能性がある」という表現に留めていること。
    assert.match(outcome.warning, /可能性があります/);
  });

  it('終了コード 2 の警告は成功を断定しない（2 は異常終了でも起こり得るため）', () => {
    const { warning } = evaluateSyncExit(SYNC_EXIT_PARTIAL_SUCCESS);
    // 同梱 sync.sh が #302 反映前の場合、2 は異常しか意味しない。
    // 「完了しました」と言い切るとエラー出力と矛盾したメッセージになる。
    assert.doesNotMatch(warning, /配布は完了しました/);
    assert.doesNotMatch(warning, /見送りました/);
  });

  it('終了コード 1（失敗）は終了コード 1 で中断する', () => {
    const outcome = evaluateSyncExit(1);
    assert.deepEqual(outcome, { proceed: false, warning: null, exitCode: 1 });
  });

  it('2 以外の 0 でない終了コードは受け取った値のまま中断する', () => {
    const outcome = evaluateSyncExit(3);
    assert.deepEqual(outcome, { proceed: false, warning: null, exitCode: 3 });
  });

  it('status が null（シグナル終了・spawn 失敗）は終了コード 1 にフォールバックして中断する', () => {
    const outcome = evaluateSyncExit(null);
    assert.deepEqual(outcome, { proceed: false, warning: null, exitCode: 1 });
  });

  it('status が undefined でも終了コード 1 にフォールバックして中断する', () => {
    const outcome = evaluateSyncExit(undefined);
    assert.deepEqual(outcome, { proceed: false, warning: null, exitCode: 1 });
  });
});
