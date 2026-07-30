import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  TERMINALS_MODES,
  resolveTerminalsMode,
  resolveTmuxSession,
  resolveTmuxClaudeCommand,
} from '../src/config.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = join(REPO_ROOT, 'bin', 'vk-orchestrator.js');

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

test('bin up（tmux モード）: 未定義関数で落ちず doctor 案内を経て tmux 起動まで到達する', () => {
  // 以前は未定義の warnIfVkAgentsNotSetup() を呼んでいて ReferenceError で必ず落ちていた。
  // 実 tmux を触らないよう、常に失敗するフェイク tmux を PATH の先頭に置き（セッションを
  // 作らない）、HOME と config も一時ディレクトリへ隔離する（実ユーザーの設定を書き換えない）。
  // 自己更新（リモート照会）は VK_ORCHESTRATOR_NO_AUTO_UPDATE=1 で止める。
  const dir = mkdtempSync(join(tmpdir(), 'vko-up-tmux-'));
  try {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const fakeTmux = join(binDir, 'tmux');
    writeFileSync(fakeTmux, '#!/bin/sh\nexit 1\n');
    chmodSync(fakeTmux, 0o755);

    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ terminals: { mode: 'tmux' } }));

    const result = spawnSync(process.execPath, [BIN_PATH, 'up'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      timeout: 60000,
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: dir,
        VK_TERMINALS_MODE: 'tmux',
        VK_ORCHESTRATOR_CONFIG: configPath,
        VK_ORCHESTRATOR_NO_AUTO_UPDATE: '1',
      },
    });
    const out = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(out, /ReferenceError/, out);
    assert.doesNotMatch(out, /warnIfVkAgentsNotSetup/, out);
    // フェイク tmux が失敗するので、セッション作成失敗のメッセージまで到達して exit 1。
    assert.match(out, /tmux セッション .* を作成できませんでした/);
    assert.equal(result.status, 1);
    // doctor はモード別に判定する: tmux 未導入は必須欠損として案内され、
    // VK Terminals 未導入は（tmux モードでは任意なので）案内に出ない。
    assert.match(out, /tmux コマンド導入/);
    assert.doesNotMatch(out, /VK Terminals 導入/);
    // 未充足の案内は「初回」と限定しない（長く使っている人でも PATH 変化でここに落ちる）。
    assert.match(out, /起動に必要な項目が未充足です/);
    // このフェイク PATH には claude も無い。Claude Code 未導入の人に
    // 「Claude Code で開いて /vk-orchestrator-setup」と案内すると実行不可能な指示になるため、
    // 先に導入を促す締めへ差し替わること（詰みループ回避）。
    assert.match(out, /まず Claude Code をインストールしてください/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
