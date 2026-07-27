/**
 * VK Terminals サイドバーメニュー payload のユニットテスト。
 *
 * POST /api/menu は VK Terminals 側で source 単位の丸ごと置換として扱われ、
 * items.length === 0 のときは該当 source のセクションを削除する。orchestrator は
 * 「VK Orchestrator」セクションを意図的に空で投入し、サイドバーから項目を出さない
 * （task-queue への導線は VK Terminals 側の見出しリンクへ一本化）。ここでは空セクションと
 * 安定した source 識別子を検証する。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MENU_SOURCE, buildOrchestratorMenu } from '../src/engine/menu.js';

test('buildOrchestratorMenu: VK Orchestrator セクションを空 items で組み立てる', () => {
  const section = buildOrchestratorMenu({ owner: 'vektor-inc', repo: 'task-queue' });

  assert.equal(section.source, 'vk-orchestrator');
  assert.ok(Array.isArray(section.items), 'items は配列である');
  assert.equal(section.items.length, 0, 'items は空（セクションクリアの冪等シグナル）');
});

test('buildOrchestratorMenu: 引数に依らず常に空セクションを返す', () => {
  const section = buildOrchestratorMenu({ owner: 'foo', repo: 'bar' });
  assert.equal(section.source, 'vk-orchestrator');
  assert.equal(section.items.length, 0);
});

test('MENU_SOURCE は vk-orchestrator で安定している', () => {
  assert.equal(MENU_SOURCE, 'vk-orchestrator');
});
