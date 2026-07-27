import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ORCHESTRATOR_RULES_HANDOFF_RELATIVE_PATH = '.vk-agents/runtime/orchestrator-rules.path';

export function defaultAgentRulesPath() {
  return resolve(__dirname, '..', '..', 'docs', 'agent-rules.md');
}

export function writeAgentRulesHandoff({ homeDir = homedir(), rulesPath = defaultAgentRulesPath() } = {}) {
  const resolvedRulesPath = resolve(rulesPath);
  const handoffPath = resolve(homeDir, ORCHESTRATOR_RULES_HANDOFF_RELATIVE_PATH);
  writeTextAtomic(handoffPath, `${resolvedRulesPath}\n`);
  return resolvedRulesPath;
}

function writeTextAtomic(path, text) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(
    dir,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(tmpPath, text, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // temp が作られる前の失敗、または rename 済みなら削除不要。
    }
    throw err;
  }
}
