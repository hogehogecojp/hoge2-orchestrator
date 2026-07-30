import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';

/**
 * POST /api/menu へ送るセクション payload の契約テスト。
 *
 * VK Terminals 側は受け取ったセクションを検証し、**1 項目でも条件を満たさなければ
 * セクション全体を拒否する**。orchestrator 側は送信失敗を警告に落として処理を続けるため、
 * 拒否されても機能は「静かに何も出ない」状態になる。実際に `id` の付与漏れで
 * サイドバー通知が一度も出ない不具合が起きたので、ここで受理条件を契約として固定する。
 *
 * 検証規則は VK Terminals の main.js（validateMenuItem / validateMenuSection）の写しで、
 * 下の checkMenuContractDrift が「写しが本物とずれていないか」を見張る。
 *
 * @param {object} opts
 * @param {(input?: object) => object} opts.buildMenu buildOrchestratorMenu 相当
 * @param {string} opts.expectedSource 期待する source 識別子
 * @param {object[]} opts.itemFixtures 項目が 1 つ以上出る状況の入力（すべて検証を通ること）
 */
export function runMenuSectionContract({ buildMenu, expectedSource, itemFixtures }) {
  const label = 'menu-section';

  // --- VK Terminals 側の受理条件の写し ---------------------------------------
  const MENU_MAX_TEXT = 200;
  const MENU_MAX_ICON = 8;
  const MENU_MAX_ITEMS = 50;
  const MENU_ACTION_TYPES = new Set(['open-settings', 'open-url']);
  const ICON_RE = /^(?:\p{Extended_Pictographic}(?:️|︎)?)(?:\s?(?:\p{Extended_Pictographic}(?:️|︎)?))?$/u;

  function validateItem(raw, seenIds) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'menu item must be an object';
    // ここが本命。id が無いと VK Terminals はセクション全体を拒否する。
    if (typeof raw.id !== 'string' || !raw.id.trim()) return 'menu item id required';
    if (raw.id.length > MENU_MAX_TEXT) return 'menu item id too long';
    if (seenIds.has(raw.id)) return `duplicate menu item id "${raw.id}"`;
    seenIds.add(raw.id);
    if (typeof raw.label !== 'string' || !raw.label.trim()) return 'menu item label required';
    if (raw.label.length > MENU_MAX_TEXT) return 'menu item label too long';
    if (raw.icon != null && raw.icon !== '') {
      const icon = String(raw.icon).trim();
      if (!icon || icon.length > MENU_MAX_ICON || /[<>&]/.test(icon)) return 'menu item icon must be emoji only';
      if (!ICON_RE.test(icon)) return 'menu item icon must be emoji only';
    }
    if (raw.action != null) {
      if (!raw.action || typeof raw.action !== 'object' || Array.isArray(raw.action)) {
        return 'menu item action must be an object';
      }
      if (!MENU_ACTION_TYPES.has(raw.action.type)) return `unsupported menu action "${raw.action.type}"`;
      if (raw.action.type === 'open-url' && typeof raw.action.url !== 'string') return 'action.url required';
    }
    return null;
  }

  function validateSection(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'menu section must be an object';
    if (typeof raw.source !== 'string' || !raw.source.trim()) return 'source required';
    if (!Array.isArray(raw.items)) return 'items array required';
    if (raw.items.length > MENU_MAX_ITEMS) return `items too many (max ${MENU_MAX_ITEMS})`;
    if (raw.title != null && typeof raw.title !== 'string') return 'title must be a string';
    const seenIds = new Set();
    for (const item of raw.items) {
      const error = validateItem(item, seenIds);
      if (error) return error;
    }
    return null;
  }

  // --- 契約の検証 -----------------------------------------------------------

  test(`[contract:${label}] 空セクションが受理される（セクションを消す冪等シグナル）`, () => {
    const section = buildMenu();
    assert.equal(validateSection(section), null);
    assert.equal(section.source, expectedSource);
    assert.equal(section.items.length, 0);
  });

  test(`[contract:${label}] 項目を出すどの状況でも VK Terminals の受理条件を満たす`, () => {
    assert.ok(itemFixtures.length > 0, '項目が出る状況を 1 つ以上渡すこと');
    for (const input of itemFixtures) {
      const section = buildMenu(input);
      assert.ok(section.items.length > 0, `項目が出ない入力が混ざっている: ${JSON.stringify(input)}`);
      assert.equal(
        validateSection(section),
        null,
        `VK Terminals に拒否される payload: ${JSON.stringify(section)}`
      );
    }
  });

  test(`[contract:${label}] 全項目が id を持つ（欠けるとセクションごと拒否される）`, () => {
    for (const input of itemFixtures) {
      for (const item of buildMenu(input).items) {
        assert.equal(typeof item.id, 'string');
        assert.notEqual(item.id.trim(), '');
      }
    }
  });

  test(`[contract:${label}] アイコンは label に埋め込まず icon で渡す`, () => {
    for (const input of itemFixtures) {
      for (const item of buildMenu(input).items) {
        // 絵文字を label に含めると、常に描かれるアイコン枠のぶんテキスト左端がずれる。
        assert.doesNotMatch(
          item.label,
          /\p{Extended_Pictographic}/u,
          `label に絵文字が埋まっている: ${item.label}`
        );
        if (item.icon != null) assert.match(item.icon, ICON_RE);
      }
    }
  });

  test(`[contract:${label}] 検証の写しが「id が無い項目」を実際に落とせる`, () => {
    // 写し自体が壊れていたら、この契約テストは何も守らない。逆方向を 1 つ固定する。
    const withoutId = { source: expectedSource, title: 'x', items: [{ label: 'ラベル' }] };
    assert.equal(validateSection(withoutId), 'menu item id required');
  });
}

/**
 * 受理条件の写しが、実際にインストールされている VK Terminals とずれていないかを見張る。
 *
 * VK Terminals は optional 依存で、CI（`npm ci --omit=optional`）には入らない。
 * 入っているときだけ検証し、無ければスキップする。
 *
 * @param {string|null} mainJsPath node_modules/vk-terminals/main.js のパス
 */
export function checkMenuContractDrift(mainJsPath) {
  test('[contract:menu-section] 受理条件の写しが実物とずれていない', (t) => {
    if (!mainJsPath || !existsSync(mainJsPath)) {
      t.skip('VK Terminals が未導入のためスキップ（optional 依存）');
      return;
    }
    const source = readFileSync(mainJsPath, 'utf8');
    // 写しが前提にしている必須項目が、実物にも残っていることを確かめる。
    for (const marker of [
      "'menu item id required'",
      "'menu item label required'",
      "'menu item icon must be emoji only'",
      "'items array required'",
      "'source required'",
    ]) {
      assert.ok(
        source.includes(marker),
        `VK Terminals 側の検証が変わった可能性がある（${marker} が見つからない）。写しを見直すこと。`
      );
    }
  });
}
