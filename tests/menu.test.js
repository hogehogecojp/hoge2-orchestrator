/**
 * VK Terminals サイドバーメニュー payload のユニットテスト。
 *
 * POST /api/menu は VK Terminals 側で source 単位の丸ごと置換として扱われ、
 * items.length === 0 のときは該当 source のセクションを削除する。orchestrator は
 * 平常時は「VK Orchestrator」セクションを空で投入し、サイドバーから項目を出さない
 * （task-queue への導線は VK Terminals 側の見出しリンクへ一本化）。
 *
 * 例外はアップデート関連のお知らせだけで、更新が当たったら項目が消えることまで検証する
 * （押しても何も無い項目が残ると、通知そのものが信用されなくなるため）。
 *
 * 「VK Terminals に受理される形か」は tests/contract/menuSectionContract.js の契約テストに
 * 任せる。ラベルや action だけを見ていると、必須項目（id）の欠落で**セクションごと拒否され
 * サイドバーに何も出ない**状態を、テスト全件緑のまま通してしまう。
 */

import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { MENU_SOURCE, MENU_ITEM_ID_UPDATE, buildOrchestratorMenu } from '../src/engine/menu.js';
import { checkMenuContractDrift, runMenuSectionContract } from './contract/menuSectionContract.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('buildOrchestratorMenu: 引数なしなら空 items で組み立てる', () => {
  const section = buildOrchestratorMenu();

  assert.equal(section.source, 'vk-orchestrator');
  assert.ok(Array.isArray(section.items), 'items は配列である');
  assert.equal(section.items.length, 0, 'items は空（セクションクリアの冪等シグナル）');
});

test('buildOrchestratorMenu: 未知の引数に依らず空セクションを返す', () => {
  const section = buildOrchestratorMenu({ owner: 'foo', repo: 'bar' });
  assert.equal(section.source, 'vk-orchestrator');
  assert.equal(section.items.length, 0);
});

test('MENU_SOURCE は vk-orchestrator で安定している', () => {
  assert.equal(MENU_SOURCE, 'vk-orchestrator');
});

describe('アップデートのお知らせ項目', () => {
  it('最新のときは項目を出さない（平常時のサイドバーは今と変わらない）', () => {
    const section = buildOrchestratorMenu({
      updateSnapshot: { channel: 'zip', current: '1.5.0', latest: '1.5.0', updateAvailable: false, notice: null },
    });
    assert.equal(section.items.length, 0);
  });

  it('新しい版があるときだけ 1 項目を出す', () => {
    const section = buildOrchestratorMenu({
      updateSnapshot: { channel: 'zip', current: '1.4.2', latest: '1.5.0', updateAvailable: true, notice: null },
    });
    assert.equal(section.items.length, 1);
    assert.equal(section.items[0].id, MENU_ITEM_ID_UPDATE);
    assert.equal(section.items[0].icon, '⬆️');
    assert.equal(section.items[0].label, '新しい版 1.5.0 があります');
    assert.deepEqual(section.items[0].action, { type: 'open-settings' });
  });

  it('アップデートが止まっているときは注意として出す', () => {
    const section = buildOrchestratorMenu({
      updateSnapshot: {
        channel: 'git',
        current: '1.4.2',
        latest: '1.5.0',
        updateAvailable: true,
        notice: { code: 'dirty', tone: 'warning' },
      },
    });
    assert.equal(section.items.length, 1);
    assert.equal(section.items[0].icon, '⚠️');
    assert.equal(section.items[0].label, 'アップデートが止まっています');
  });

  it('確認できていないときは「止まっています」ではなく確認の話として出す', () => {
    const section = buildOrchestratorMenu({
      updateSnapshot: {
        channel: 'zip',
        current: '1.5.0',
        latest: null,
        updateAvailable: false,
        notice: { code: 'stale-check', tone: 'warning' },
      },
    });
    assert.equal(section.items.length, 1);
    assert.equal(section.items[0].label, '新しい版を確認できていません');
  });

  it('更新が当たれば項目が消える（記録が最新になった後の再投稿で自己クリアされる）', () => {
    const before = buildOrchestratorMenu({
      updateSnapshot: { current: '1.4.2', latest: '1.5.0', updateAvailable: true, notice: null },
    });
    assert.equal(before.items.length, 1);

    const after = buildOrchestratorMenu({
      updateSnapshot: { current: '1.5.0', latest: '1.5.0', updateAvailable: false, notice: null },
    });
    assert.equal(after.items.length, 0, '更新後の記録では項目を出さない');
  });

  it('確認に失敗しただけ（info のお知らせ）では項目を出さない', () => {
    const section = buildOrchestratorMenu({
      updateSnapshot: {
        channel: 'zip',
        current: '1.5.0',
        latest: null,
        updateAvailable: false,
        notice: { code: 'offline', tone: 'info' },
      },
    });
    assert.equal(section.items.length, 0, '放っておけば直る状態でサイドバーを賑やかにしない');
  });
});

// VK Terminals が受理する形になっているかの契約テスト。
// 項目が出るすべての状況を渡し、1 つでも拒否される payload があれば落とす。
runMenuSectionContract({
  buildMenu: buildOrchestratorMenu,
  expectedSource: 'vk-orchestrator',
  itemFixtures: [
    { updateSnapshot: { channel: 'zip', current: '1.4.2', latest: '1.5.0', updateAvailable: true, notice: null } },
    {
      updateSnapshot: {
        channel: 'git',
        current: '1.4.2',
        latest: '1.5.0',
        updateAvailable: true,
        notice: { code: 'dirty', tone: 'warning' },
      },
    },
    {
      updateSnapshot: {
        channel: 'zip',
        current: '1.5.0',
        latest: null,
        updateAvailable: false,
        notice: { code: 'stale-check', tone: 'warning' },
      },
    },
    {
      updateSnapshot: {
        channel: 'unknown',
        current: '1.4.2',
        latest: '1.5.0',
        updateAvailable: true,
        notice: { code: 'channel-unresolved', tone: 'warning' },
      },
    },
  ],
});

checkMenuContractDrift(join(REPO_ROOT, 'node_modules', 'vk-terminals', 'main.js'));
