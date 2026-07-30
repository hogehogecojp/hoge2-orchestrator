/**
 * 同梱 vk-agents の再展開判定のユニットテスト。
 *
 * 再展開は `sync.sh --claude-global` の実行＝~/.claude の書き換えを伴う。利用者の
 * グローバル設定を上書きする取り返しのつかない操作なので、走らせる条件は
 * 「同梱のほうが新しいと確かに分かる」ときだけに絞る。
 *
 * 比較を「異なるか」で行うと、同梱が利用者自身の vk-agents clone より古い**通常の
 * 定常状態**（リリースのたびに同梱をそろえるが、利用者は自分の clone から先に同期している）
 * で ~/.claude を古い内容へ巻き戻してしまう。ここではその境界を全方向で固定する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateAgentsVersionState,
  needsAgentsRedeploy,
  resolveAgentsSyncAction,
} from '../src/engine/agents-redeploy.js';
import {
  formatAgentsVersionNotice,
  formatAgentsVersionRequirement,
} from '../src/engine/update-messages.js';

/** 展開済み・同梱と記録が同じ版、を既定にした入力を作る。 */
function input(overrides = {}) {
  return { vendorVersion: 'v0.14.0', recordedVersion: 'v0.14.0', manifestExists: true, ...overrides };
}

describe('evaluateAgentsVersionState（版の突き合わせ）', () => {
  it('同梱が新しい', () => {
    const state = evaluateAgentsVersionState(input({ vendorVersion: 'v0.16.0' }));
    assert.equal(state.code, 'vendor-newer');
    assert.equal(state.vendor, '0.16.0');
    assert.equal(state.recorded, '0.14.0');
  });

  it('同梱が古い', () => {
    assert.equal(evaluateAgentsVersionState(input({ recordedVersion: 'v0.16.0' })).code, 'vendor-older');
  });

  it('同じ', () => {
    assert.equal(evaluateAgentsVersionState(input()).code, 'up-to-date');
  });

  it('マイナー・パッチも数値として比較する（文字列比較では 0.9.0 > 0.10.0 になってしまう）', () => {
    assert.equal(
      evaluateAgentsVersionState(input({ vendorVersion: 'v0.10.0', recordedVersion: 'v0.9.0' })).code,
      'vendor-newer'
    );
    assert.equal(
      evaluateAgentsVersionState(input({ vendorVersion: 'v0.9.0', recordedVersion: 'v0.10.0' })).code,
      'vendor-older'
    );
  });

  it('展開済みの版が分からない', () => {
    assert.equal(evaluateAgentsVersionState(input({ recordedVersion: null })).code, 'recorded-unknown');
  });

  it('同梱の版が読めない', () => {
    assert.equal(evaluateAgentsVersionState(input({ vendorVersion: null })).code, 'vendor-unknown');
    assert.equal(evaluateAgentsVersionState(input({ vendorVersion: '  ' })).code, 'vendor-unknown');
  });

  it('semver として読めない版表記', () => {
    assert.equal(evaluateAgentsVersionState(input({ vendorVersion: 'main' })).code, 'invalid-version');
    assert.equal(evaluateAgentsVersionState(input({ recordedVersion: 'latest' })).code, 'invalid-version');
  });

  it('まだ展開されていない', () => {
    assert.equal(evaluateAgentsVersionState(input({ manifestExists: false })).code, 'not-deployed');
  });
});

describe('needsAgentsRedeploy', () => {
  it('同梱が新しいときだけ展開する', () => {
    assert.deepEqual(
      needsAgentsRedeploy(input({ vendorVersion: 'v0.16.0' })),
      { action: 'deploy', reason: 'vendor-newer' }
    );
  });

  it('同梱が古ければ展開しない', () => {
    assert.deepEqual(
      needsAgentsRedeploy(input({ recordedVersion: 'v0.16.0' })),
      { action: 'skip', reason: 'vendor-older' }
    );
  });

  it('同じなら展開しない', () => {
    assert.deepEqual(needsAgentsRedeploy(input()), { action: 'skip', reason: 'up-to-date' });
  });

  it('展開済みの版が分からなければ展開しない', () => {
    assert.deepEqual(
      needsAgentsRedeploy(input({ recordedVersion: null })),
      { action: 'skip', reason: 'recorded-unknown' }
    );
  });

  it('未展開は展開側（実行するかは resolveAgentsSyncAction が決める）', () => {
    assert.deepEqual(
      needsAgentsRedeploy(input({ manifestExists: false })),
      { action: 'deploy', reason: 'manifest-missing' }
    );
  });

  it('引数なしでも落ちない', () => {
    assert.equal(needsAgentsRedeploy().action, 'deploy');
  });
});

// sync.sh --claude-global は利用者のグローバル設定（~/.claude）を書き換える。
// ここが本体の回帰テスト。
describe('resolveAgentsSyncAction（sync.sh を走らせる条件）', () => {
  // ── これが今回の不具合そのもの ────────────────────────────────────────
  it('同梱が古いときは走らせない（利用者の ~/.claude を古い内容へ巻き戻さない）', () => {
    assert.deepEqual(
      resolveAgentsSyncAction(input({ vendorVersion: 'v0.14.0', recordedVersion: 'v0.16.0' })),
      { run: false, reason: 'vendor-older' }
    );
  });

  it('展開済みの版が分からないときは走らせない（新しい可能性があるので触らない）', () => {
    assert.deepEqual(
      resolveAgentsSyncAction(input({ recordedVersion: null })),
      { run: false, reason: 'recorded-unknown' }
    );
  });

  // 実環境で確認した入力そのもの。同梱 v0.14.0 を配りながら、利用者の clone は v0.16.0 で
  // ~/.claude はそこから同期済み、記録のサイドカーは無い、という状態。
  // ここが run: true だと、次の `up` で ~/.claude が 2 バージョン分巻き戻る。
  it('同梱 v0.14.0・記録なし・展開済み（実環境で確認した状態）では走らせない', () => {
    assert.equal(
      resolveAgentsSyncAction({ vendorVersion: 'v0.14.0', recordedVersion: null, manifestExists: true }).run,
      false
    );
  });
  // ──────────────────────────────────────────────────────────────────

  it('同梱が新しいときだけ走らせる', () => {
    assert.deepEqual(
      resolveAgentsSyncAction(input({ vendorVersion: 'v0.16.0' })),
      { run: true, reason: 'vendor-newer' }
    );
  });

  it('版が同じなら走らせない（毎起動で ~/.claude を書き換えない）', () => {
    assert.deepEqual(resolveAgentsSyncAction(input()), { run: false, reason: 'up-to-date' });
  });

  it('同梱の版が読めないときは走らせない（比較材料が無い）', () => {
    assert.deepEqual(
      resolveAgentsSyncAction(input({ vendorVersion: null })),
      { run: false, reason: 'vendor-unknown' }
    );
  });

  it('semver でない版表記のときは走らせない（大小を決められない）', () => {
    assert.equal(resolveAgentsSyncAction(input({ vendorVersion: 'main' })).run, false);
    assert.equal(resolveAgentsSyncAction(input({ recordedVersion: 'some-branch' })).run, false);
  });

  it('まだ一度も展開されていない環境では走らせない（初回セットアップの案内に任せる）', () => {
    assert.deepEqual(
      resolveAgentsSyncAction(input({ manifestExists: false, recordedVersion: null })),
      { run: false, reason: 'initial-setup-required' }
    );
  });

  it('先頭の v の有無で結果が変わらない', () => {
    const newerPairs = [
      ['v0.16.0', 'v0.14.0'],
      ['0.16.0', 'v0.14.0'],
      ['v0.16.0', '0.14.0'],
      ['0.16.0', '0.14.0'],
    ];
    for (const [vendorVersion, recordedVersion] of newerPairs) {
      assert.equal(
        resolveAgentsSyncAction(input({ vendorVersion, recordedVersion })).run,
        true,
        `同梱が新しい判定が崩れている: ${vendorVersion} / ${recordedVersion}`
      );
    }
    // 逆向き（同梱が古い）は、v の有無に関わらず必ず走らせない。
    for (const [recordedVersion, vendorVersion] of newerPairs) {
      assert.equal(
        resolveAgentsSyncAction(input({ vendorVersion, recordedVersion })).run,
        false,
        `同梱が古い判定が崩れている: ${vendorVersion} / ${recordedVersion}`
      );
    }
  });

  it('走らせるのは「同梱が新しい」1 通りだけ（ほかは全部見送る）', () => {
    const states = [
      input({ vendorVersion: 'v0.16.0' }),   // vendor-newer
      input({ recordedVersion: 'v0.16.0' }), // vendor-older
      input(),                               // up-to-date
      input({ recordedVersion: null }),      // recorded-unknown
      input({ vendorVersion: null }),        // vendor-unknown
      input({ vendorVersion: 'main' }),      // invalid-version
      input({ manifestExists: false }),      // not-deployed
    ];
    const runs = states.filter((s) => resolveAgentsSyncAction(s).run);
    assert.equal(runs.length, 1);
    assert.equal(evaluateAgentsVersionState(runs[0]).code, 'vendor-newer');
  });
});

// 展開を見送ったときも黙って済ませない。とくに「同梱のほうが古い」は利用者が自分で
// 新しくしている通常の状態なので、黙っていると「なぜ展開されないのか」が分からない。
describe('formatAgentsVersionNotice（起動時に伝える 1 行）', () => {
  const noticeFor = (overrides) => formatAgentsVersionNotice(evaluateAgentsVersionState(input(overrides)));

  it('同梱が古いときは、どちらが新しいかが分かる文で知らせる', () => {
    const notice = noticeFor({ vendorVersion: 'v0.14.0', recordedVersion: 'v0.16.0' });
    assert.ok(notice, '黙って見送らない');
    assert.match(notice.text, /同梱のエージェント定義（v0\.14\.0）/);
    assert.match(notice.text, /展開済みの版（v0\.16\.0）/);
    assert.match(notice.text, /古いため展開しません/);
  });

  it('展開済みの版が分からないときは、そろえる手段を案内する', () => {
    const notice = noticeFor({ recordedVersion: null });
    assert.ok(notice);
    assert.match(notice.text, /版が分からない/);
    assert.match(notice.text, /setup:agents/);
  });

  it('同梱が新しいときは、展開し直すことと版の変化を知らせる', () => {
    const notice = noticeFor({ vendorVersion: 'v0.16.0' });
    assert.match(notice.text, /v0\.14\.0 → v0\.16\.0/);
    assert.match(notice.text, /展開し直します/);
  });

  it('版が同じとき・未展開のときは伝えることが無い', () => {
    assert.equal(noticeFor(), null);
    assert.equal(noticeFor({ manifestExists: false }), null);
  });

  it('比較できないときは注意として出す', () => {
    assert.equal(noticeFor({ vendorVersion: 'main' }).level, 'warn');
    assert.equal(noticeFor({ vendorVersion: null }).level, 'warn');
  });
});

describe('formatAgentsVersionRequirement（doctor の表示）', () => {
  const viewFor = (overrides) => formatAgentsVersionRequirement(evaluateAgentsVersionState(input(overrides)));

  it('版が同じなら充足', () => {
    assert.equal(viewFor().ok, true);
  });

  // 同梱が利用者の clone より古いのは通常の定常状態なので、ここを警告にすると
  // 自分で vk-agents を同期している利用者全員が毎回警告を見ることになる。
  it('展開済みのほうが新しい状態は警告にしない', () => {
    const view = viewFor({ recordedVersion: 'v0.16.0' });
    assert.equal(view.ok, true);
    assert.match(view.current, /v0\.16\.0/);
    assert.match(view.hint, /そのまま使えます/);
  });

  it('展開済みが古ければ未充足として、自動で展開し直すことを伝える', () => {
    const view = viewFor({ vendorVersion: 'v0.16.0' });
    assert.equal(view.ok, false);
    assert.match(view.hint, /次回の `up` 起動時に自動で展開し直します/);
  });

  it('展開済みの版が分からないときは「確認できない」と案内する', () => {
    const view = viewFor({ recordedVersion: null });
    assert.equal(view.ok, false);
    assert.match(view.hint, /確認できません/);
    assert.match(view.hint, /setup:agents/);
  });

  it('未展開なら未充足として展開手段を案内する', () => {
    const view = viewFor({ manifestExists: false });
    assert.equal(view.ok, false);
    assert.equal(view.current, '未展開');
    assert.match(view.hint, /setup:agents/);
  });
});
