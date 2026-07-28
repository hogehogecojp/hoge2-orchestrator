import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONFLICT_HANDBACK_MAX,
  buildResolvedConflictHandbackState,
  buildConflictHandbackPrompt,
  decideConflictHandback,
  isPRConflicted,
  normalizeConflictHandbackMax,
  requiresBlockedLabelForHandbackDecision,
} from '../src/engine/conflict-handback.js';

describe('isPRConflicted', () => {
  it('mergeable=false または mergeableState=dirty をコンフリクトとして扱う', () => {
    assert.equal(isPRConflicted({ mergeable: false, mergeableState: 'unknown' }), true);
    assert.equal(isPRConflicted({ mergeable: true, mergeableState: 'dirty' }), true);
  });

  it('計算中・clean・状態なしはコンフリクトとして扱わない', () => {
    assert.equal(isPRConflicted({ mergeable: null, mergeableState: 'unknown' }), false);
    assert.equal(isPRConflicted({ mergeable: true, mergeableState: 'clean' }), false);
    assert.equal(isPRConflicted(null), false);
  });
});

describe('normalizeConflictHandbackMax', () => {
  it('未設定・空白・NaN・負数は既定値へフォールバックする', () => {
    for (const value of [undefined, null, '', '  ', 'not-a-number', -1]) {
      assert.equal(normalizeConflictHandbackMax(value), DEFAULT_CONFLICT_HANDBACK_MAX);
    }
  });

  it('0 は機能無効化として許容し、正の小数は切り捨てる', () => {
    assert.equal(normalizeConflictHandbackMax('0'), 0);
    assert.equal(normalizeConflictHandbackMax(0), 0);
    assert.equal(normalizeConflictHandbackMax('3'), 3);
    assert.equal(normalizeConflictHandbackMax(3.9), 3);
  });
});

describe('buildResolvedConflictHandbackState', () => {
  it('解消時は配達状態を戻し、通算 attempts だけを保持する', () => {
    assert.deepEqual(
      buildResolvedConflictHandbackState({
        conflictHandback: {
          headSha: 'sha-1',
          attempts: 2,
          sendFailures: 3,
          delivered: true,
          exhaustedNotified: true,
        },
      }),
      {
        headSha: null,
        attempts: 2,
        sendFailures: 0,
        delivered: false,
        exhaustedNotified: false,
      }
    );
  });
});

describe('decideConflictHandback', () => {
  it('maxAttempts=0 は通知無しの disabled を返す', () => {
    assert.deepEqual(
      decideConflictHandback({ headSha: 'sha-1', saved: {}, maxAttempts: 0 }),
      { type: 'disabled', attempt: 0, sendFailures: 0, notifyExhausted: false }
    );
  });

  it('新規 head は attempt=1・sendFailures=1 で差し戻す', () => {
    assert.deepEqual(
      decideConflictHandback({ headSha: 'sha-1', saved: {}, maxAttempts: 2 }),
      { type: 'handback', attempt: 1, sendFailures: 1, notifyExhausted: false }
    );
  });

  it('saved=null でも初回の差し戻しとして扱う', () => {
    assert.deepEqual(
      decideConflictHandback({ headSha: 'sha-1', saved: null, maxAttempts: 2 }),
      { type: 'handback', attempt: 1, sendFailures: 1, notifyExhausted: false }
    );
  });

  it('同じ head かつ配達済みなら重複として見送る', () => {
    assert.deepEqual(
      decideConflictHandback({
        headSha: 'sha-1',
        saved: {
          conflictHandback: {
            headSha: 'sha-1',
            attempts: 1,
            sendFailures: 0,
            delivered: true,
          },
        },
        maxAttempts: 2,
      }),
      { type: 'skip-duplicate', attempt: 1, sendFailures: 0, notifyExhausted: false }
    );
  });

  it('同じ head かつ未達なら attempts は増やさず sendFailures だけ増やす', () => {
    assert.deepEqual(
      decideConflictHandback({
        headSha: 'sha-1',
        saved: {
          conflictHandback: {
            headSha: 'sha-1',
            attempts: 1,
            sendFailures: 1,
            delivered: false,
          },
        },
        maxAttempts: 2,
      }),
      { type: 'handback', attempt: 1, sendFailures: 2, notifyExhausted: false }
    );
  });

  it('同じ head の未達再送でも、設定変更後の上限超過を再評価する', () => {
    assert.deepEqual(
      decideConflictHandback({
        headSha: 'sha-1',
        saved: {
          conflictHandback: {
            headSha: 'sha-1',
            attempts: 3,
            sendFailures: 1,
            delivered: false,
          },
        },
        maxAttempts: 1,
      }),
      { type: 'skip-exhausted', attempt: 3, sendFailures: 1, notifyExhausted: true }
    );
  });

  it('同じ head の未達を再送し、配達済みになれば以後は重複として見送る', () => {
    const retry = decideConflictHandback({
      headSha: 'sha-1',
      saved: {
        conflictHandback: {
          headSha: 'sha-1',
          attempts: 1,
          sendFailures: 1,
          delivered: false,
        },
      },
      maxAttempts: 2,
    });
    assert.deepEqual(
      retry,
      { type: 'handback', attempt: 1, sendFailures: 2, notifyExhausted: false }
    );

    assert.deepEqual(
      decideConflictHandback({
        headSha: 'sha-1',
        saved: {
          conflictHandback: {
            headSha: 'sha-1',
            attempts: retry.attempt,
            sendFailures: 0,
            delivered: true,
          },
        },
        maxAttempts: 2,
      }),
      { type: 'skip-duplicate', attempt: 1, sendFailures: 0, notifyExhausted: false }
    );
  });

  it('同じ head の送信失敗上限到達は初回だけ通知する', () => {
    const base = {
      headSha: 'sha-1',
      attempts: 1,
      sendFailures: 3,
      delivered: false,
    };
    assert.deepEqual(
      decideConflictHandback({
        headSha: 'sha-1',
        saved: { conflictHandback: base },
        maxAttempts: 2,
      }),
      { type: 'skip-send-failed', attempt: 1, sendFailures: 3, notifyExhausted: true }
    );
    assert.deepEqual(
      decideConflictHandback({
        headSha: 'sha-1',
        saved: { conflictHandback: { ...base, exhaustedNotified: true } },
        maxAttempts: 2,
      }),
      { type: 'skip-send-failed', attempt: 1, sendFailures: 3, notifyExhausted: false }
    );
  });

  it('送信失敗上限は maxSendFailures で上書きできる', () => {
    assert.deepEqual(
      decideConflictHandback({
        headSha: 'sha-1',
        saved: {
          conflictHandback: {
            headSha: 'sha-1',
            attempts: 1,
            sendFailures: 1,
            delivered: false,
          },
        },
        maxAttempts: 2,
        maxSendFailures: 1,
      }),
      { type: 'skip-send-failed', attempt: 1, sendFailures: 1, notifyExhausted: true }
    );
  });

  it('送信失敗で打ち切った後も head が変われば attempts + 1 で再開する', () => {
    const failed = {
      headSha: 'sha-1',
      attempts: 1,
      sendFailures: 3,
      delivered: false,
      exhaustedNotified: true,
    };
    assert.equal(
      decideConflictHandback({
        headSha: 'sha-1',
        saved: { conflictHandback: failed },
        maxAttempts: 2,
      }).type,
      'skip-send-failed'
    );
    assert.deepEqual(
      decideConflictHandback({
        headSha: 'sha-2',
        saved: { conflictHandback: failed },
        maxAttempts: 2,
      }),
      { type: 'handback', attempt: 2, sendFailures: 1, notifyExhausted: false }
    );
  });

  it('解消時リセット後の再コンフリクトは通算 attempts + 1 になる', () => {
    const resolvedState = buildResolvedConflictHandbackState({
      conflictHandback: { headSha: 'sha-1', attempts: 1 },
    });
    assert.deepEqual(
      decideConflictHandback({
        headSha: 'sha-2',
        saved: { conflictHandback: resolvedState },
        maxAttempts: 2,
      }),
      { type: 'handback', attempt: 2, sendFailures: 1, notifyExhausted: false }
    );
  });

  it('head が変われば attempts が増え、上限超過通知は初回だけ要求する', () => {
    assert.deepEqual(
      decideConflictHandback({
        headSha: 'sha-2',
        saved: { conflictHandback: { headSha: 'sha-1', attempts: 1 } },
        maxAttempts: 2,
      }),
      { type: 'handback', attempt: 2, sendFailures: 1, notifyExhausted: false }
    );
    const base = { headSha: 'sha-2', attempts: 2, delivered: true };
    assert.deepEqual(
      decideConflictHandback({
        headSha: 'sha-3',
        saved: { conflictHandback: base },
        maxAttempts: 2,
      }),
      { type: 'skip-exhausted', attempt: 3, sendFailures: 0, notifyExhausted: true }
    );
    assert.deepEqual(
      decideConflictHandback({
        headSha: 'sha-3',
        saved: { conflictHandback: { ...base, exhaustedNotified: true } },
        maxAttempts: 2,
      }),
      { type: 'skip-exhausted', attempt: 3, sendFailures: 0, notifyExhausted: false }
    );
  });

  it('head SHA が無ければ fail-closed で見送る', () => {
    assert.deepEqual(
      decideConflictHandback({ headSha: null, saved: {}, maxAttempts: 2 }),
      { type: 'skip-unknown-head', attempt: 0, sendFailures: 0, notifyExhausted: false }
    );
  });
});

describe('requiresBlockedLabelForHandbackDecision', () => {
  it('打ち切り状態なら notifyExhausted の値に関係なくラベルを主張する', () => {
    assert.equal(requiresBlockedLabelForHandbackDecision({
      type: 'skip-exhausted',
      notifyExhausted: true,
    }), true);
    assert.equal(requiresBlockedLabelForHandbackDecision({
      type: 'skip-exhausted',
      notifyExhausted: false,
    }), true);
    assert.equal(requiresBlockedLabelForHandbackDecision({
      type: 'skip-send-failed',
      notifyExhausted: true,
    }), true);
    assert.equal(requiresBlockedLabelForHandbackDecision({
      type: 'skip-send-failed',
      notifyExhausted: false,
    }), true);
  });

  it('打ち切り以外の判断や引数なしではラベルを主張しない', () => {
    for (const type of [
      'skip-unknown-head',
      'disabled',
      'skip-duplicate',
      'handback',
    ]) {
      assert.equal(requiresBlockedLabelForHandbackDecision({ type }), false, type);
    }
    assert.equal(requiresBlockedLabelForHandbackDecision(), false);
  });
});

describe('buildConflictHandbackPrompt', () => {
  it('対象ブランチ・PR URL・解消/push/CI/再レビュー/マーカー再付与・回数を含む', () => {
    const prompt = buildConflictHandbackPrompt({
      prRef: { owner: 'vektor-inc', repo: 'example', number: 42 },
      prUrl: 'https://github.com/vektor-inc/example/pull/42',
      headRefName: 'feature/conflict-fix',
      attempt: 2,
      maxAttempts: 3,
    });
    assert.match(prompt, /https:\/\/github\.com\/vektor-inc\/example\/pull\/42/);
    assert.match(prompt, /対象ブランチ: `feature\/conflict-fix`/);
    assert.match(prompt, /対象ブランチをチェックアウト/);
    assert.match(prompt, /コンフリクトを解消/);
    assert.match(prompt, /push/);
    assert.match(prompt, /CI が通過/);
    assert.match(prompt, /再レビュー/);
    assert.match(prompt, /agent-review-passed-sha:/);
    assert.match(prompt, /2\/3 回目/);
    assert.match(prompt, /上限に達すると自動依頼は打ち切られ/);
  });

  it('headRefName が null のときはブランチ行を出さず、調べ方を案内する', () => {
    const prompt = buildConflictHandbackPrompt({
      prRef: { owner: 'vektor-inc', repo: 'example', number: 42 },
      prUrl: 'https://github.com/vektor-inc/example/pull/42',
      headRefName: null,
      attempt: 1,
      maxAttempts: 2,
    });
    assert.doesNotMatch(prompt, /対象ブランチ: `/);
    assert.match(prompt, /PR #42/);
    assert.match(prompt, /gh pr view 42 -R vektor-inc\/example --json headRefName/);
    assert.match(prompt, /表示されたブランチをチェックアウト/);
  });
});
