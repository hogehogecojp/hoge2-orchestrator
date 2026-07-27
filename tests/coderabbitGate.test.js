/**
 * CodeRabbit 待機ゲート（prCompletionOptions / coderabbitGateLine）のユニットテスト。
 *
 * issue #215:
 *  1. CodeRabbit を有効にしたままレビューだけ抑止する設定（features.coderabbit_ignore=true）では
 *     CodeRabbit が一度もコメントしないのに、自動マージが PR 作成から 30 分待たされていた。
 *  2. 待機の要否を判定する処理が orchestrator 自身の設定（~/.vk-orchestrator/config.json）しか
 *     読まず、設定パネルが編集する vk-agents 正本（~/.vk-agents/config.json）を見ていなかったため、
 *     設定パネルで CodeRabbit を OFF にしてもマージ判定に反映されなかった。
 *
 * 判定は engine/index.js から切り出した src/engine/coderabbit-gate.js の純関数で、設定は引数で
 * 受け取る（ファイル読み込みは呼び出し側の loadCoderabbitFeatureConfig() が担当し、そちらの
 * 優先順位・フォールバックは tests/config.test.js で検証する）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prCompletionOptions, coderabbitGateLine } from '../src/engine/coderabbit-gate.js';

const features = (coderabbit, coderabbitIgnore) => ({
  features: {
    ...(coderabbit === undefined ? {} : { coderabbit }),
    ...(coderabbitIgnore === undefined ? {} : { coderabbit_ignore: coderabbitIgnore }),
  },
});

// --- issue #215 の真理値表（待機 0 分＝即時マージ可か） ---

test('prCompletionOptions: coderabbit=false なら待機 0 分（既存動作の維持）', () => {
  assert.deepEqual(prCompletionOptions(features(false)), { coderabbitIdleMs: 0 });
  // coderabbit_ignore の値は不問。
  assert.deepEqual(prCompletionOptions(features(false, false)), { coderabbitIdleMs: 0 });
  assert.deepEqual(prCompletionOptions(features(false, true)), { coderabbitIdleMs: 0 });
  assert.deepEqual(prCompletionOptions(features('false')), { coderabbitIdleMs: 0 });
});

test('prCompletionOptions: coderabbit=true かつ coderabbit_ignore=true なら待機 0 分（#215）', () => {
  assert.deepEqual(prCompletionOptions(features(true, true)), { coderabbitIdleMs: 0 });
  // 旧 GUI が保存した文字列 boolean も同じ扱いにする。
  assert.deepEqual(prCompletionOptions(features(true, 'true')), { coderabbitIdleMs: 0 });
});

test('prCompletionOptions: coderabbit=true かつ coderabbit_ignore=false なら既定（30 分待機）', () => {
  assert.deepEqual(prCompletionOptions(features(true, false)), {});
  assert.deepEqual(prCompletionOptions(features(true, 'false')), {});
});

test('prCompletionOptions: 設定が空・未指定なら既定（監視あり・抑止なし＝30 分待機）', () => {
  assert.deepEqual(prCompletionOptions({}), {});
  assert.deepEqual(prCompletionOptions({ features: {} }), {});
  // 引数省略でもファイルを読まず、安全側の「待つ」へ倒れる（純関数としての既定）。
  assert.deepEqual(prCompletionOptions(), {});
});

// --- issue コメントに書く「CodeRabbit のコメント待ち」行（waiting-merge / automerge 共通） ---

test('coderabbitGateLine: coderabbit=true / ignore=false は 30 分間 新規コメントなし', () => {
  assert.equal(
    coderabbitGateLine(features(true, false)),
    '- CodeRabbit のコメント待ち: 30 分間 新規コメントなし',
  );
});

test('coderabbitGateLine: coderabbit_ignore=true は抑止設定を理由として示し、戻し方が分かるキー名を添える（#215）', () => {
  const line = coderabbitGateLine(features(true, true));
  assert.doesNotMatch(line, /30 分間/);
  assert.match(line, /@coderabbitai ignore/);
  assert.match(line, /features\.coderabbit_ignore = true/);
  assert.match(line, /待機なし/);
});

test('coderabbitGateLine: coderabbit=false は監視無効を理由として示し、戻し方が分かるキー名を添える', () => {
  const line = coderabbitGateLine(features(false));
  assert.doesNotMatch(line, /30 分間/);
  assert.match(line, /features\.coderabbit = false/);
  assert.match(line, /待機なし/);
});

test('coderabbitGateLine: 3 分岐すべて周囲の箇条書きと同じ「条件: 状態」型で揃える', () => {
  for (const cfg of [features(true, false), features(true, true), features(false)]) {
    assert.match(coderabbitGateLine(cfg), /^- CodeRabbit のコメント待ち: .+$/);
  }
});
