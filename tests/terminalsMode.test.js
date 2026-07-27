import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  TERMINALS_MODES,
  resolveTerminalsMode,
  resolveTmuxSession,
  resolveTmuxClaudeCommand,
} from '../src/config.js';

const ENV_KEYS = ['VK_TERMINALS_MODE', 'VK_TMUX_SESSION', 'VK_TMUX_CLAUDE_CMD'];
let saved;
beforeEach(() => { saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

test('resolveTerminalsMode: 既定は vk-terminals', () => {
  assert.equal(resolveTerminalsMode({}), 'vk-terminals');
});
test('resolveTerminalsMode: config で tmux', () => {
  assert.equal(resolveTerminalsMode({ terminals: { mode: 'tmux' } }), 'tmux');
});
test('resolveTerminalsMode: env が config より優先', () => {
  process.env.VK_TERMINALS_MODE = 'tmux';
  assert.equal(resolveTerminalsMode({ terminals: { mode: 'vk-terminals' } }), 'tmux');
});
test('resolveTerminalsMode: 未知値は既定へフォールバック', () => {
  assert.equal(resolveTerminalsMode({ terminals: { mode: 'bogus' } }), 'vk-terminals');
});
test('TERMINALS_MODES は vk-terminals と tmux', () => {
  assert.deepEqual(TERMINALS_MODES, ['vk-terminals', 'tmux']);
});
test('resolveTmuxSession: 既定 vk-orch / env 優先', () => {
  assert.equal(resolveTmuxSession({}), 'vk-orch');
  process.env.VK_TMUX_SESSION = 'foo';
  assert.equal(resolveTmuxSession({ tmux: { session: 'bar' } }), 'foo');
});
test('resolveTmuxClaudeCommand: 既定 claude / config 反映', () => {
  assert.equal(resolveTmuxClaudeCommand({}), 'claude');
  assert.equal(resolveTmuxClaudeCommand({ tmux: { claudeCommand: 'claude --dangerously-skip-permissions' } }),
    'claude --dangerously-skip-permissions');
});

test('index.js: mode で実行面バックエンドが切り替わる（fetch 呼び出し回数で検証）', async () => {
  // checkHealth の戻り値の型ではなく「HTTP パスへ落ちているか」を fetch 呼び出し回数で
  // 直接検証する。vkBackend.checkHealth は fetch 例外を握りつぶして false を返すため、
  // typeof === 'boolean' は両モードで成立してしまい、ルーティングを証明できない。
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  // 良性の health レスポンスを返す（VK モードで throw させず、純粋に呼び出し回数だけ数える）。
  global.fetch = async () => { fetchCalls++; return { ok: true, json: async () => ({ ok: true }) }; };
  try {
    // --- tmux モード: fetch は一切呼ばれない（tmux has-session へシェルアウトする）---
    fetchCalls = 0;
    process.env.VK_TERMINALS_MODE = 'tmux';
    // モジュールメモ（_backend）をまたぐため、import ごとに別のキャッシュバスターを付ける。
    const tmuxMod = await import(`../src/terminals/index.js?mode=tmux&t=${Date.now()}`);
    const tmuxOk = await tmuxMod.checkHealth(0);
    assert.equal(typeof tmuxOk, 'boolean');
    assert.equal(fetchCalls, 0, 'tmux モードでは fetch を呼んではいけない（HTTP バックエンドに落ちていない証明）');

    // --- 既定（vk-terminals）モード: HTTP /api/health を叩くので fetch が 1 回以上呼ばれる ---
    fetchCalls = 0;
    delete process.env.VK_TERMINALS_MODE;
    const vkMod = await import(`../src/terminals/index.js?mode=vk&t=${Date.now()}`);
    await vkMod.checkHealth(0);
    assert.ok(fetchCalls >= 1, '既定モードでは fetch を 1 回以上呼ぶ（HTTP バックエンドへ届いている証明）');
  } finally {
    global.fetch = originalFetch;
    delete process.env.VK_TERMINALS_MODE;
  }
});
