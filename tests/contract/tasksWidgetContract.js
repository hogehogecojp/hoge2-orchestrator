import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * tasks-widget 宣言のスキーマ契約テスト。#229 で VK Terminals 側が消費する契約を固定する。
 * buildTasksWidget の実装詳細ではなく「宣言の形（スキーマ）」だけを検証する再利用スイート。
 *
 * @param {object} opts
 * @param {(view: object, options?: object) => object} opts.buildWidget  buildTasksWidget 相当
 * @param {number} opts.schemaVersion  期待するスキーマバージョン
 */
export function runTasksWidgetContract({ buildWidget, schemaVersion }) {
  const label = 'tasks-widget';

  // 全ステータス・全属性を網羅した代表的な view を 1 つ用意する。
  function fixtureView() {
    return {
      updatedAt: '2026-07-21T00:00:00.000Z',
      viewer: 'wada',
      tasks: [
        {
          id: '1', number: 1, title: 'in-progress task', status: 'in-progress',
          priority: 'high', sequential: true, automerge: true, assignee: 'wada',
          targetIssueUrl: 'https://github.com/vektor-inc/vk-orchestrator/issues/196',
          prUrl: 'https://github.com/vektor-inc/vk-orchestrator/pull/2',
          queueIssueUrl: 'https://github.com/vektor-inc/task-queue/issues/1',
          updatedAt: '2026-07-20T00:00:00.000Z',
        },
        {
          id: '3', number: 3, title: 'waiting-input task', status: 'waiting-input',
          priority: null, sequential: false, automerge: false, assignee: null,
          targetIssueUrl: null, prUrl: null, queueIssueUrl: null, updatedAt: null,
        },
        {
          id: '4', number: 4, title: 'waiting-merge task', status: 'waiting-merge',
          priority: 'medium', sequential: false, automerge: false, assignee: null,
          targetIssueUrl: null, prUrl: 'https://github.com/vektor-inc/vk-orchestrator/pull/5',
          queueIssueUrl: null, updatedAt: null,
        },
        {
          id: '6', number: 6, title: 'done task', status: 'done',
          priority: 'low', sequential: false, automerge: false, assignee: null,
          targetIssueUrl: null, prUrl: null, queueIssueUrl: null, updatedAt: null,
        },
      ],
    };
  }

  const TONES = new Set(['warning', 'info', 'progress', 'success', 'danger', 'neutral', 'attention']);
  const ACTIONS = new Set(['set-status', 'set-priority', 'set-sequential', 'set-automerge']);

  test(`[contract:${label}] トップレベルのスキーマ`, () => {
    const w = buildWidget(fixtureView(), { staleThresholdMs: 120000 });
    assert.equal(w.schemaVersion, schemaVersion);
    assert.equal(w.kind, 'task-list');
    assert.equal(w.lang, 'ja');
    assert.equal(typeof w.updatedAt, 'string');
    assert.ok(w.viewer === null || typeof w.viewer === 'string');
    assert.equal(typeof w.staleThresholdMs, 'number');
    assert.equal(typeof w.emptyText, 'string');
    assert.ok(Array.isArray(w.groups));
    // staleness は boolean を焼き込まない（updatedAt + staleThresholdMs で再計算）。
    assert.equal(Object.hasOwn(w, 'stale'), false);
  });

  test(`[contract:${label}] グループのスキーマ`, () => {
    const w = buildWidget(fixtureView());
    for (const [index, group] of w.groups.entries()) {
      assert.equal(typeof group.id, 'string');
      assert.equal(typeof group.label, 'string');
      assert.ok(TONES.has(group.tone), `unknown group tone: ${group.tone}`);
      assert.equal(group.order, index);
      assert.ok(Array.isArray(group.items));
      assert.ok(group.items.length > 0);
    }
  });

  test(`[contract:${label}] アイテムのスキーマ`, () => {
    const w = buildWidget(fixtureView());
    for (const group of w.groups) {
      for (const item of group.items) {
        assert.equal(typeof item.id, 'string');
        assert.equal(typeof item.title, 'string');
        assert.ok(Array.isArray(item.links));
        for (const link of item.links) {
          assert.ok(['queue', 'pr', 'target'].includes(link.rel), `unknown link rel: ${link.rel}`);
          assert.match(link.url, /^https?:\/\//);
          assert.equal(typeof link.label, 'string');
        }
        assert.ok(Array.isArray(item.badges));
        for (const badge of item.badges) {
          assert.equal(typeof badge.label, 'string');
          assert.ok(TONES.has(badge.tone), `unknown badge tone: ${badge.tone}`);
        }
        assert.equal(typeof item.editable, 'boolean');
        assert.ok(item.updatedAt === null || typeof item.updatedAt === 'string');
        assert.ok(Array.isArray(item.controls));
        if (!item.editable) assert.equal(item.controls.length, 0);
      }
    }
  });

  test(`[contract:${label}] 対象 issue URL は target link として出力する`, () => {
    const w = buildWidget(fixtureView());
    const items = w.groups.flatMap((g) => g.items);
    const item = items.find((i) => i.id === '1');
    assert.ok(item);
    assert.deepEqual(item.links.find((link) => link.rel === 'target'), {
      rel: 'target',
      url: 'https://github.com/vektor-inc/vk-orchestrator/issues/196',
      label: 'Target',
    });
  });

  test(`[contract:${label}] コントロール・オプション・command のスキーマ`, () => {
    const w = buildWidget(fixtureView());
    const editableItems = w.groups.flatMap((g) => g.items).filter((i) => i.editable);
    assert.ok(editableItems.length > 0);
    for (const item of editableItems) {
      const fields = item.controls.map((c) => c.field);
      assert.deepEqual(fields, ['status', 'priority', 'sequential', 'automerge']);
      for (const control of item.controls) {
        assert.equal(control.type, 'select');
        assert.equal(typeof control.label, 'string');
        assert.equal(typeof control.ariaLabel, 'string');
        assert.ok('current' in control);
        assert.ok(Array.isArray(control.options) && control.options.length > 0);
        for (const option of control.options) {
          assert.ok('value' in option);
          assert.equal(typeof option.label, 'string');
          assert.equal(typeof option.disabled, 'boolean');
          if (option.disabled && option.value !== control.current) {
            assert.equal(typeof option.disabledReason, 'string');
          }
          if (option.command) {
            assert.ok(ACTIONS.has(option.command.action), `unknown action: ${option.command.action}`);
            assert.equal(typeof option.command.taskId, 'string');
            assert.ok('to' in option.command);
            assert.ok('expected' in option.command);
            // command 断片には id / requestedAt を含めない（ビューアが発行時に付与する）。
            assert.equal(Object.hasOwn(option.command, 'id'), false);
            assert.equal(Object.hasOwn(option.command, 'requestedAt'), false);
          }
          if (option.confirm) {
            assert.equal(typeof option.confirm.title, 'string');
            assert.equal(typeof option.confirm.body, 'string');
          }
        }
      }
    }
  });
}
