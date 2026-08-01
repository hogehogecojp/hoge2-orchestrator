/**
 * isPaneWorking（src/engine/pane-activity.js）のユニットテスト。
 *
 * 「タスクに紐づく作業ペインが現に動いているか」の判定（issue #272）。
 * 材料が取れないときは必ず false（＝ waiting-input への遷移を保留しない / fail-open）に
 * なることを、経路ごとに固定する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isPaneWorking, PANE_ACTIVE_WINDOW_MS } from '../src/engine/pane-activity.js';

const NOW = 1_700_000_000_000;

// VK Terminals states のペイン 1 件（必要なフィールドだけ）。
function pane(overrides = {}) {
  return {
    termId: '7',
    waiting: false,
    externalWaiting: false,
    lastOutputTime: NOW - 2_000, // 実測どおり「作業中は約 2 秒ごとに出力」を模す
    lastLines: '⏵ working...',
    ...overrides,
  };
}

describe('isPaneWorking', () => {
  it('直近に出力があり VK Terminals も入力待ちと判定していなければ稼働中', () => {
    assert.equal(isPaneWorking({ pane: pane(), now: NOW }), true);
  });

  it('時間窓の内側（境界の直前）は稼働中', () => {
    assert.equal(isPaneWorking({
      pane: pane({ lastOutputTime: NOW - (PANE_ACTIVE_WINDOW_MS - 1) }),
      now: NOW,
    }), true);
  });

  it('時間窓ちょうど・それ以上に出力が古ければ静止（＝保留しない）', () => {
    assert.equal(isPaneWorking({
      pane: pane({ lastOutputTime: NOW - PANE_ACTIVE_WINDOW_MS }),
      now: NOW,
    }), false);
    assert.equal(isPaneWorking({
      pane: pane({ lastOutputTime: NOW - PANE_ACTIVE_WINDOW_MS * 10 }),
      now: NOW,
    }), false);
  });

  it('実行面が入力待ちと判定していれば、出力が直近でも稼働中とみなさない', () => {
    // 本物の確認ダイアログが出ているケース。実行面の判定を尊重して二重に判断しない。
    assert.equal(isPaneWorking({ pane: pane({ waiting: true }), now: NOW }), false);
  });

  it('waiting が真偽値以外でも truthy なら入力待ち扱い（判定は fail-open 側へ緩める）', () => {
    for (const waiting of [1, 'true', 'false', {}]) {
      assert.equal(
        isPaneWorking({ pane: pane({ waiting }), now: NOW }),
        false,
        `waiting=${JSON.stringify(waiting)}`
      );
    }
    // falsy は従来どおり「入力待ちではない」。
    for (const waiting of [false, 0, '', null, undefined]) {
      assert.equal(
        isPaneWorking({ pane: pane({ waiting }), now: NOW }),
        true,
        `waiting=${JSON.stringify(waiting)}`
      );
    }
  });

  it('externalWaiting（orchestrator が押し込んだ外部フラグ）は判定に使わない', () => {
    // 自分が書いた status:waiting-input を読み返す循環を作らないため、`externalWaiting` は見ない。
    // なお `waiting` 側が常に内部判定というわけではなく、tmux バックエンドでは
    // `setExternalWaiting()` が書いた値がそのまま返る（pane-activity.js の docblock 参照）。
    // そちらは向きが fail-open 側なので無害、という整理。
    assert.equal(isPaneWorking({ pane: pane({ externalWaiting: true }), now: NOW }), true);
  });

  it('ペインが引けない（VK Terminals 停止中・termId 未解決・一覧に無い）なら false', () => {
    assert.equal(isPaneWorking({ pane: null, now: NOW }), false);
    assert.equal(isPaneWorking({ pane: undefined, now: NOW }), false);
    assert.equal(isPaneWorking({ pane: 'not-an-object', now: NOW }), false);
    assert.equal(isPaneWorking(), false);
  });

  it('lastOutputTime が未報告・不正値なら false（材料無しとして倒す）', () => {
    for (const lastOutputTime of [undefined, null, 0, -1, NaN, 'abc', {}]) {
      assert.equal(
        isPaneWorking({ pane: pane({ lastOutputTime }), now: NOW }),
        false,
        `lastOutputTime=${String(lastOutputTime)}`
      );
    }
  });

  it('時間窓が不正値なら false（常時保留に倒れないようにする）', () => {
    for (const activeWindowMs of [0, -1, NaN, 'abc', null]) {
      assert.equal(
        isPaneWorking({ pane: pane(), now: NOW, activeWindowMs }),
        false,
        `activeWindowMs=${String(activeWindowMs)}`
      );
    }
  });

  // `lastOutputTime` は接続先マシン（VK Terminals が動いているマシン）の時計で打たれ、
  // 受信側で再スタンプされない。接続先を別マシンにできる構成があるため、2 台のクロック差が
  // そのまま差分に乗る。
  it('窓未満の未来（軽微なクロックずれ）は稼働中として許容', () => {
    assert.equal(isPaneWorking({ pane: pane({ lastOutputTime: NOW + 5_000 }), now: NOW }), true);
    assert.equal(isPaneWorking({
      pane: pane({ lastOutputTime: NOW + (PANE_ACTIVE_WINDOW_MS - 1) }),
      now: NOW,
    }), true);
  });

  it('窓以上の未来（大きなクロックずれ）は材料が信用できないので false（fail-open）', () => {
    // ここを true にすると、ずれの大きさに関係なく無条件で保留になる。しかも停止ペインでも
    // 散発的な出力で lastOutputTime が「未来」に更新され直すため、ずれがその間隔を超えると
    // 窓を抜ける前に必ず次の更新が来て保留が解けなくなる（＝本物の質問が出なくなる）。
    assert.equal(isPaneWorking({
      pane: pane({ lastOutputTime: NOW + PANE_ACTIVE_WINDOW_MS }),
      now: NOW,
    }), false);
    assert.equal(isPaneWorking({ pane: pane({ lastOutputTime: NOW + 600_000 }), now: NOW }), false);
  });

  it('判定窓はメインループ間隔（既定 60 秒）より短く、停止ペインが必ず窓から外れること', () => {
    // 窓がループ間隔以上だと、停止ペインの散発的な出力を毎巡拾って保留が続きうる。
    // ここを緩めるときは pane-activity.js の根拠コメントごと見直すこと。
    assert.ok(PANE_ACTIVE_WINDOW_MS < 60_000, `PANE_ACTIVE_WINDOW_MS=${PANE_ACTIVE_WINDOW_MS}`);
    // 作業中の実測出力間隔（最大 4.1 秒）に対して十分な余裕があること。
    assert.ok(PANE_ACTIVE_WINDOW_MS >= 10_000, `PANE_ACTIVE_WINDOW_MS=${PANE_ACTIVE_WINDOW_MS}`);
  });
});
