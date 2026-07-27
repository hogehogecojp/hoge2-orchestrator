import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import {
  ORCHESTRATOR_RULES_HANDOFF_RELATIVE_PATH,
  defaultAgentRulesPath,
  writeAgentRulesHandoff,
} from '../src/engine/agentRulesHandoff.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('writeAgentRulesHandoff: runtime ディレクトリを作成して rulesPath を書き出す', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'vko-agent-rules-'));
  try {
    const rulesPath = resolve(homeDir, 'repo', 'docs', 'agent-rules.md');
    const writtenPath = writeAgentRulesHandoff({ homeDir, rulesPath });
    const handoffPath = join(homeDir, ORCHESTRATOR_RULES_HANDOFF_RELATIVE_PATH);

    assert.equal(writtenPath, rulesPath);
    assert.equal(existsSync(dirname(handoffPath)), true);
    assert.equal(readFileSync(handoffPath, 'utf8'), `${rulesPath}\n`);
    assert.deepEqual(readdirSync(dirname(handoffPath)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('writeAgentRulesHandoff: rulesPath 省略時は docs/agent-rules.md の絶対パスを書き出す', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'vko-agent-rules-'));
  try {
    const expectedRulesPath = resolve(__dirname, '..', 'docs', 'agent-rules.md');
    const writtenPath = writeAgentRulesHandoff({ homeDir });
    const handoffPath = join(homeDir, ORCHESTRATOR_RULES_HANDOFF_RELATIVE_PATH);

    assert.equal(defaultAgentRulesPath(), expectedRulesPath);
    assert.equal(writtenPath, expectedRulesPath);
    assert.equal(readFileSync(handoffPath, 'utf8'), `${expectedRulesPath}\n`);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('writeAgentRulesHandoff: 毎回上書きする', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'vko-agent-rules-'));
  try {
    const handoffPath = join(homeDir, ORCHESTRATOR_RULES_HANDOFF_RELATIVE_PATH);
    writeAgentRulesHandoff({ homeDir, rulesPath: resolve(homeDir, 'first.md') });
    writeFileSync(handoffPath, '/tmp/stale.md\n', 'utf8');

    const rulesPath = resolve(homeDir, 'second.md');
    writeAgentRulesHandoff({ homeDir, rulesPath });

    assert.equal(readFileSync(handoffPath, 'utf8'), `${rulesPath}\n`);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
