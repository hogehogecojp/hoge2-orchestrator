/**
 * VK Terminals host がこのマシン自身を指すかどうかの判定テスト。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLocalMachineHost } from '../src/engine/local-machine-host.js';

test('isLocalMachineHost: 非ループバックでも自マシン IP なら true を返す', () => {
  assert.equal(
    isLocalMachineHost('100.121.46.76', ['127.0.0.1', '100.121.46.76']),
    true,
  );
});

test('isLocalMachineHost: ループバックは localAddresses に依らず true を返す', () => {
  assert.equal(isLocalMachineHost('127.0.0.1', []), true);
  assert.equal(isLocalMachineHost('localhost', []), true);
  assert.equal(isLocalMachineHost('::1', []), true);
  assert.equal(isLocalMachineHost('[::1]', []), true);
});

test('isLocalMachineHost: 別マシンの IP は false を返す', () => {
  assert.equal(
    isLocalMachineHost('203.0.113.10', ['127.0.0.1', '100.121.46.76']),
    false,
  );
});

test('isLocalMachineHost: IPv6 の角括弧とゾーン ID を正規化して比較する', () => {
  assert.equal(
    isLocalMachineHost('[fd7a:115c:a1e0::7537:2e4d]', ['fd7a:115c:a1e0::7537:2e4d']),
    true,
  );
  assert.equal(
    isLocalMachineHost('fe80::1%en0', ['fe80::1']),
    true,
  );
  assert.equal(
    isLocalMachineHost('[fe80::1%en0]', ['fe80::1%lo0']),
    true,
  );
});

test('isLocalMachineHost: 大文字と前後空白を正規化して比較する', () => {
  assert.equal(
    isLocalMachineHost('  EXAMPLE.LOCAL  ', ['example.local']),
    true,
  );
  assert.equal(
    isLocalMachineHost('  FD7A:115C:A1E0::7537:2E4D  ', ['fd7a:115c:a1e0::7537:2e4d']),
    true,
  );
});
