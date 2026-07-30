/**
 * orchestratorUpdateDecision のユニットテスト。
 *
 * vk-orchestrator 自身の自己更新は git / npm / re-exec の副作用を伴うため、
 * 更新してよいかどうかの判定だけを純粋関数として検証する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { orchestratorUpdateDecision } from '../src/engine/self-update.js';
import { cmpTuple, toTuple } from '../scripts/vk-terminals-tags.mjs';

const base = {
  current: '0.11.0',
  latest: 'v0.12.0',
  dirty: false,
  branch: 'main',
  optOut: false,
  alreadyUpdated: false,
};

describe('orchestratorUpdateDecision', () => {
  it('既に最新なら skip', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, latest: 'v0.11.0' }),
      { action: 'skip', reason: 'up-to-date' }
    );
  });

  it('ローカルが先行していても skip', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, current: '0.12.1', latest: 'v0.12.0' }),
      { action: 'skip', reason: 'up-to-date' }
    );
  });

  it('re-exec 後なら skip', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, alreadyUpdated: true }),
      { action: 'skip', reason: 'already-updated' }
    );
  });

  it('opt-out 指定なら skip', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, optOut: true }),
      { action: 'skip', reason: 'opt-out' }
    );
  });

  it('dirty なら skip', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, dirty: true }),
      { action: 'skip', reason: 'dirty' }
    );
  });

  it('main 以外のブランチなら skip', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, branch: 'feature/test' }),
      { action: 'skip', reason: 'non-main-branch' }
    );
  });

  it('すべて満たすなら update', () => {
    assert.deepEqual(
      orchestratorUpdateDecision(base),
      { action: 'update', reason: 'newer-release' }
    );
  });
});

// 入手経路（チャネル）別のゲート。既存 7 ケースは channel 未指定＝git として通ることを
// 上の describe がそのまま担保しており、ここでは追加した分岐だけを検証する。
describe('orchestratorUpdateDecision（入手経路別）', () => {
  it('zip なら未コミット変更があっても update（zip 環境に作業ツリーの概念が無い）', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, channel: 'zip', dirty: true, branch: '' }),
      { action: 'update', reason: 'newer-release' }
    );
  });

  it('zip なら main 以外のブランチ名でも update', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, channel: 'zip', branch: 'feature/test' }),
      { action: 'update', reason: 'newer-release' }
    );
  });

  it('zip で稼働中（GUI・engine が動いている）なら skip', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, channel: 'zip', busy: true }),
      { action: 'skip', reason: 'busy' }
    );
  });

  it('git チャネルでは busy を見ない（起動時の静止点でのみ走るため）', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, channel: 'git', busy: true }),
      { action: 'update', reason: 'newer-release' }
    );
  });

  it('入手経路が決まらなければ channel-unresolved で skip', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, channel: 'unknown' }),
      { action: 'skip', reason: 'channel-unresolved' }
    );
  });

  it('channel-unresolved は版が読めない場合より先に判定する', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, channel: 'unknown', current: null, latest: null }),
      { action: 'skip', reason: 'channel-unresolved' }
    );
  });

  it('channel: off は設定 OFF と同じ扱い（opt-out）', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, channel: 'off' }),
      { action: 'skip', reason: 'opt-out' }
    );
  });

  it('re-exec 後の判定はチャネルより先（多重更新を防ぐ）', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, channel: 'unknown', alreadyUpdated: true }),
      { action: 'skip', reason: 'already-updated' }
    );
  });

  it('チャネル指定に依らず最新なら up-to-date', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, channel: 'zip', latest: 'v0.11.0' }),
      { action: 'skip', reason: 'up-to-date' }
    );
  });

  it('戻り値は action と reason の 2 フィールドだけ（呼び出し側が形に依存している）', () => {
    assert.deepEqual(
      Object.keys(orchestratorUpdateDecision({ ...base, channel: 'zip' })).sort(),
      ['action', 'reason']
    );
  });
});

describe('semver tuple comparison', () => {
  it('等値は 0', () => {
    assert.equal(cmpTuple(toTuple('0.11.0'), toTuple('v0.11.0')), 0);
  });

  it('パッチ差を比較できる', () => {
    assert.ok(cmpTuple(toTuple('0.11.1'), toTuple('0.11.0')) > 0);
  });

  it('マイナー差を比較できる', () => {
    assert.ok(cmpTuple(toTuple('0.12.0'), toTuple('0.11.9')) > 0);
  });
});
