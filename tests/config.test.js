/**
 * 統合設定 (src/config.js) のユニットテスト。
 * - loadUnifiedConfig: JSON 読み込み / 欠損時は {}
 * - applyConfigToEnv:  env > config.json の優先順位
 * - buildSettingsDescriptor: 設定パネルのマルチターゲット契約
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, dirname, isAbsolute, resolve } from 'path';
import { tmpdir } from 'os';
import { setTimeout as sleep } from 'timers/promises';
import {
  loadUnifiedConfig,
  applyConfigToEnv,
  ensureGitHubToken,
  getGitHubTokenFromGh,
  loadConfig,
  migrateLegacyOrchestratorConfig,
  migrateLegacyVkAgentsGuiKeys,
  resolveCommandsPath,
  resolveTasksViewPath,
  resolveVkAgentsRepoPath,
  resolveVkAgentsConfigPath,
  resolveVkAgentsCanonicalConfigPath,
  resolveVkTerminalsApiHost,
  resolveVkTerminalsApiPort,
  vkAgentsGlobalSettingsPath,
  vkAgentsSkillsManifestPath,
  vkAgentsSkillsManifestSourcePath,
  isVkAgentsSetup,
  writeVkAgentsManifestSource,
  writeVkAgentsSettings,
  writeVkTerminalsCommandsConfig,
  writeVkTerminalsTasksViewConfig,
  getTaskConfig,
  getQueueBackend,
  isCoderabbitEnabled,
  getTaskCwd,
  getProtocolConfig,
  getLabelsConfig,
  buildSettingsDescriptor,
  GPU_MODES,
  defaultGpuMode,
  getVkTerminalsGpuMode,
  gpuLaunchOptions,
  DEFAULT_LABELS,
  DEFAULT_QUEUE,
} from '../src/config.js';

function withTmpConfig(obj, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'vko-cfg-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(obj));
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withSavedEnv(keys, fn) {
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function withTmpDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withVkTerminalsSchema(schema, fn) {
  return withTmpDir('vko-vk-terminals-', (dir) => {
    writeFileSync(join(dir, 'settings-schema.json'), JSON.stringify(schema, null, 2));
    return fn(dir);
  });
}

function vkTerminalsSchemaFixture(groups = [{
  label: '基本',
  fields: [
    { key: 'apiHost', label: 'API ホスト', type: 'text', help: '既定 127.0.0.1' },
    { key: 'initialCommand', label: '初期コマンド', type: 'text', help: '各ペイン起動時のコマンド' },
    { key: 'confirmClose', label: '閉じる確認', type: 'select', options: [{ value: 'busy', label: '実行中のみ確認' }] },
    { key: 'gpu', label: 'GPU モード', type: 'select', options: [{ value: '', label: '自動' }, { value: 'off', label: 'off' }] },
  ],
}]) {
  return {
    title: 'VK Terminals 設定',
    note: '保存後、VK Terminals を再起動すると反映されます。',
    groups,
  };
}

test('loadUnifiedConfig: 存在しないパスは {} を返す', () => {
  assert.deepEqual(loadUnifiedConfig('/no/such/file.json'), {});
});

test('loadUnifiedConfig: JSON を読み込む', () => {
  withTmpConfig({ github: { owner: 'acme' } }, (path) => {
    assert.deepEqual(loadUnifiedConfig(path), { github: { owner: 'acme' } });
  });
});

test('applyConfigToEnv: 未設定の env に config 値を反映する', () => {
  const keys = ['GITHUB_OWNER', 'GITHUB_REPO', 'QUEUE_LABEL', 'QUEUE_BACKEND', 'VK_TERMINALS_PORT', 'ASSIGNEE_FILTER', 'TASK_CWD'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    applyConfigToEnv({
      github: { owner: 'acme', repo: 'q', queueLabel: 'lbl' },
      queue: { backend: 'local' },
      orchestrator: { assigneeFilter: 'alice', taskCwd: '/work/task' },
      vkTerminals: { port: 20000 },
    });
    assert.equal(process.env.GITHUB_OWNER, 'acme');
    assert.equal(process.env.GITHUB_REPO, 'q');
    assert.equal(process.env.QUEUE_LABEL, 'lbl');
    assert.equal(process.env.QUEUE_BACKEND, 'local');
    assert.equal(process.env.VK_TERMINALS_PORT, undefined);
    assert.equal(process.env.ASSIGNEE_FILTER, 'alice');
    assert.equal(process.env.TASK_CWD, undefined);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('applyConfigToEnv: 既存 env を上書きしない（env が優先）', () => {
  const saved = process.env.GITHUB_OWNER;
  process.env.GITHUB_OWNER = 'from-env';
  try {
    applyConfigToEnv({ github: { owner: 'from-config' } });
    assert.equal(process.env.GITHUB_OWNER, 'from-env');
  } finally {
    if (saved === undefined) delete process.env.GITHUB_OWNER;
    else process.env.GITHUB_OWNER = saved;
  }
});

test('applyConfigToEnv: null の assigneeFilter は反映しない', () => {
  const saved = process.env.ASSIGNEE_FILTER;
  delete process.env.ASSIGNEE_FILTER;
  try {
    applyConfigToEnv({ orchestrator: { assigneeFilter: null } });
    assert.equal(process.env.ASSIGNEE_FILTER, undefined);
  } finally {
    if (saved !== undefined) process.env.ASSIGNEE_FILTER = saved;
  }
});

test('applyConfigToEnv: GITHUB_TOKEN を config.json から反映できる', () => {
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    applyConfigToEnv({ github: { token: 'ghp_fromconfig' } });
    assert.equal(process.env.GITHUB_TOKEN, 'ghp_fromconfig');
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test('applyConfigToEnv: .env の GITHUB_TOKEN が config.json より優先される', () => {
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_fromenv';
  try {
    applyConfigToEnv({ github: { token: 'ghp_fromconfig' } });
    assert.equal(process.env.GITHUB_TOKEN, 'ghp_fromenv');
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test('ensureGitHubToken: 既存の GITHUB_TOKEN を優先し gh を呼ばない', () => {
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_fromenv';
  try {
    const token = ensureGitHubToken({
      execFileSync: () => {
        throw new Error('should not be called');
      },
    });
    assert.equal(token, 'ghp_fromenv');
    assert.equal(process.env.GITHUB_TOKEN, 'ghp_fromenv');
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test('ensureGitHubToken: 未設定なら gh auth token の結果を GITHUB_TOKEN に反映する', () => {
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const calls = [];
  try {
    const token = ensureGitHubToken({
      execFileSync: (file, args, options) => {
        calls.push({ file, args, options });
        return 'gho_fromgh\n';
      },
    });
    assert.equal(token, 'gho_fromgh');
    assert.equal(process.env.GITHUB_TOKEN, 'gho_fromgh');
    assert.deepEqual(calls, [
      {
        file: 'gh',
        args: ['auth', 'token'],
        options: { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      },
    ]);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test('getGitHubTokenFromGh: gh auth token の出力を trim する', () => {
  const token = getGitHubTokenFromGh(() => 'gho_token\n');
  assert.equal(token, 'gho_token');
});

test('loadConfig: gh auth token でも未解決なら gh auth login へ誘導する', () => {
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    assert.throws(
      () => loadConfig(['node', 'bin'], { execFileSync: () => { throw new Error('no auth'); } }),
      /gh auth login/,
    );
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test('resolveVkAgentsConfigPath: 明示 configPath を優先する', () => {
  withSavedEnv(['VK_AGENTS_CONFIG', 'VK_AGENTS_CONFIG_PATH'], () => {
    const configPath = join(tmpdir(), 'vk-agents-config.json');
    assert.equal(resolveVkAgentsConfigPath({ vkAgents: { configPath } }), configPath);
  });
});

test('resolveVkAgentsConfigPath: env を最優先する', () => {
  withSavedEnv(['VK_AGENTS_CONFIG', 'VK_AGENTS_CONFIG_PATH'], () => {
    const envPath = join(tmpdir(), 'vk-agents-env.json');
    const configPath = join(tmpdir(), 'vk-agents-config.json');
    process.env.VK_AGENTS_CONFIG = envPath;
    assert.equal(resolveVkAgentsConfigPath({ vkAgents: { configPath } }), envPath);
  });
});

test('resolveVkAgentsRepoPath: 明示 repoPath を優先する', () => {
  withSavedEnv(['VK_AGENTS_DIR', 'VK_AGENTS_REPO_PATH'], () => {
    const repoPath = join(tmpdir(), 'vk-agents');
    assert.equal(resolveVkAgentsRepoPath({ vkAgents: { repoPath } }), repoPath);
  });
});

test('resolveVkAgentsConfigPath: home 正本があれば旧 repoPath より優先する', () => {
  withSavedEnv(['VK_AGENTS_CONFIG', 'VK_AGENTS_CONFIG_PATH'], () => {
    const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-home-'));
    try {
      const homeConfig = join(dir, '.vk-agents', 'config.json');
      mkdirSync(dirname(homeConfig), { recursive: true });
      writeFileSync(homeConfig, '{}\n');
      const repoPath = join(tmpdir(), 'vk-agents');
      assert.equal(
        resolveVkAgentsConfigPath({ vkAgents: { repoPath } }, { homeDir: dir }),
        homeConfig,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('resolveVkAgentsConfigPath: home 正本が無ければ旧 repoPath の config.json へ fallback する', () => {
  withSavedEnv(['VK_AGENTS_CONFIG', 'VK_AGENTS_CONFIG_PATH'], () => {
    const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-home-'));
    try {
      const repoPath = join(tmpdir(), 'vk-agents');
      assert.equal(
        resolveVkAgentsConfigPath({ vkAgents: { repoPath } }, { homeDir: dir }),
        join(repoPath, 'config.json'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('resolveVkTerminalsApiHost: env VK_TERMINALS_HOST を最優先する', () => {
  withSavedEnv(['VK_TERMINALS_HOST'], () => {
    const dir = mkdtempSync(join(tmpdir(), 'vko-vkterm-host-'));
    try {
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, JSON.stringify({ apiHost: '100.64.0.1' }));
      process.env.VK_TERMINALS_HOST = '192.0.2.10';
      assert.equal(resolveVkTerminalsApiHost({ configPath }), '192.0.2.10');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('resolveVkTerminalsApiHost: ~/.vk-terminals/config.json の apiHost を読む', () => {
  withSavedEnv(['VK_TERMINALS_HOST'], () => {
    delete process.env.VK_TERMINALS_HOST;
    const dir = mkdtempSync(join(tmpdir(), 'vko-vkterm-home-'));
    try {
      const configPath = join(dir, '.vk-terminals', 'config.json');
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ apiHost: '  100.64.0.2  ' }));
      assert.equal(resolveVkTerminalsApiHost({ homeDir: dir }), '100.64.0.2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('resolveVkTerminalsApiHost: 不正 JSON でも例外を投げず既定 127.0.0.1 へフォールバックする', () => {
  withSavedEnv(['VK_TERMINALS_HOST'], () => {
    delete process.env.VK_TERMINALS_HOST;
    const dir = mkdtempSync(join(tmpdir(), 'vko-vkterm-home-'));
    try {
      const configPath = join(dir, '.vk-terminals', 'config.json');
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, '{ this is not valid json');
      // VK Terminals(GUI) が書き込み途中の不正 JSON を読んでも up を落とさないこと。
      assert.doesNotThrow(() => resolveVkTerminalsApiHost({ homeDir: dir }));
      assert.equal(resolveVkTerminalsApiHost({ homeDir: dir }), '127.0.0.1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('resolveVkTerminalsApiHost: apiHost 未設定なら既定 127.0.0.1 を返す', () => {
  withSavedEnv(['VK_TERMINALS_HOST'], () => {
    delete process.env.VK_TERMINALS_HOST;
    const dir = mkdtempSync(join(tmpdir(), 'vko-vkterm-home-'));
    try {
      assert.equal(resolveVkTerminalsApiHost({ homeDir: dir }), '127.0.0.1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('resolveVkTerminalsApiPort: env VK_TERMINALS_PORT を最優先する', () => {
  withSavedEnv(['VK_TERMINALS_PORT'], () => {
    const dir = mkdtempSync(join(tmpdir(), 'vko-vkterm-port-'));
    try {
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, JSON.stringify({ port: 20000 }));
      process.env.VK_TERMINALS_PORT = '21000';
      assert.equal(resolveVkTerminalsApiPort({ configPath }), 21000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('resolveVkTerminalsApiPort: ~/.vk-terminals/config.json の port を読む', () => {
  withSavedEnv(['VK_TERMINALS_PORT'], () => {
    delete process.env.VK_TERMINALS_PORT;
    const dir = mkdtempSync(join(tmpdir(), 'vko-vkterm-home-'));
    try {
      const configPath = join(dir, '.vk-terminals', 'config.json');
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ port: '22000' }));
      assert.equal(resolveVkTerminalsApiPort({ homeDir: dir }), 22000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('resolveVkTerminalsApiPort: port 未設定なら既定 13847 を返す', () => {
  withSavedEnv(['VK_TERMINALS_PORT'], () => {
    delete process.env.VK_TERMINALS_PORT;
    const dir = mkdtempSync(join(tmpdir(), 'vko-vkterm-home-'));
    try {
      assert.equal(resolveVkTerminalsApiPort({ homeDir: dir }), 13847);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('resolveVkTerminalsApiPort: 不正 JSON でも例外を投げず既定 13847 へフォールバックする', () => {
  withSavedEnv(['VK_TERMINALS_PORT'], () => {
    delete process.env.VK_TERMINALS_PORT;
    const dir = mkdtempSync(join(tmpdir(), 'vko-vkterm-home-'));
    try {
      const configPath = join(dir, '.vk-terminals', 'config.json');
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, '{ this is not valid json');
      assert.doesNotThrow(() => resolveVkTerminalsApiPort({ homeDir: dir }));
      assert.equal(resolveVkTerminalsApiPort({ homeDir: dir }), 13847);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('resolveTasksViewPath: home 配下の tasks-view.json を返す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-tasks-view-path-'));
  try {
    assert.equal(
      resolveTasksViewPath({ homeDir: dir }),
      join(dir, '.task-queue', 'tasks-view.json'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveCommandsPath: home 配下の commands.jsonl を返す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-commands-path-'));
  try {
    assert.equal(
      resolveCommandsPath({ homeDir: dir }),
      join(dir, '.task-queue', 'commands.jsonl'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkTerminalsTasksViewConfig: 既存設定を保ったまま tasksViewPath を注入する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkterm-tasks-view-'));
  try {
    const configPath = join(dir, '.vk-terminals', 'config.json');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ port: 13847, apiHost: '100.64.0.2' }));

    const result = writeVkTerminalsTasksViewConfig({ homeDir: dir });
    const config = JSON.parse(readFileSync(configPath, 'utf8'));

    assert.deepEqual(result, {
      configPath,
      tasksViewPath: join(dir, '.task-queue', 'tasks-view.json'),
    });
    assert.deepEqual(config, {
      port: 13847,
      apiHost: '100.64.0.2',
      tasksViewPath: join(dir, '.task-queue', 'tasks-view.json'),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkTerminalsCommandsConfig: 既存設定を保ったまま commandsPath を注入する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkterm-commands-'));
  try {
    const configPath = join(dir, '.vk-terminals', 'config.json');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ port: 13847, apiHost: '100.64.0.2' }));

    const result = writeVkTerminalsCommandsConfig({ homeDir: dir });
    const config = JSON.parse(readFileSync(configPath, 'utf8'));

    assert.deepEqual(result, {
      configPath,
      commandsPath: join(dir, '.task-queue', 'commands.jsonl'),
    });
    assert.deepEqual(config, {
      port: 13847,
      apiHost: '100.64.0.2',
      commandsPath: join(dir, '.task-queue', 'commands.jsonl'),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateLegacyOrchestratorConfig: repo 直下 config.json を home 正本へ初回コピーする', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-migrate-'));
  try {
    const repoRoot = join(dir, 'repo');
    const homeDir = join(dir, 'home');
    mkdirSync(repoRoot, { recursive: true });
    const sourcePath = join(repoRoot, 'config.json');
    const targetPath = join(homeDir, '.vk-orchestrator', 'config.json');
    writeFileSync(sourcePath, JSON.stringify({ github: { owner: 'vektor-inc' } }) + '\n');
    const logs = [];

    const result = migrateLegacyOrchestratorConfig({
      repoRoot,
      homeDir,
      log: (message) => logs.push(message),
    });

    assert.deepEqual(result, { migrated: true, sourcePath, targetPath });
    assert.equal(readFileSync(targetPath, 'utf8'), readFileSync(sourcePath, 'utf8'));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /正本/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateLegacyOrchestratorConfig: home 正本があれば旧配置を上書きしない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-migrate-'));
  try {
    const repoRoot = join(dir, 'repo');
    const homeDir = join(dir, 'home');
    const targetPath = join(homeDir, '.vk-orchestrator', 'config.json');
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(join(repoRoot, 'config.json'), JSON.stringify({ github: { owner: 'legacy' } }));
    writeFileSync(targetPath, JSON.stringify({ github: { owner: 'home' } }) + '\n');
    const logs = [];

    const result = migrateLegacyOrchestratorConfig({
      repoRoot,
      homeDir,
      log: (message) => logs.push(message),
    });

    assert.equal(result.migrated, false);
    assert.deepEqual(JSON.parse(readFileSync(targetPath, 'utf8')), { github: { owner: 'home' } });
    assert.equal(logs.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateLegacyVkAgentsGuiKeys: 旧 GUI キーを canonical へ移送し orchestrator config から削除する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-migrate-'));
  try {
    const sourcePath = join(dir, 'orchestrator.json');
    const targetPath = join(dir, '.vk-agents', 'config.json');
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(sourcePath, JSON.stringify({
      github: { owner: 'vektor-inc' },
      features: { coderabbit: false, coderabbit_ignore: true },
      staff_wp_dev: { engine: 'codex' },
      staff_review: { engine: 'claude' },
      multi_repo_task: { default_engine: 'claude' },
      org: {
        allowed_owners: ['vektor-inc'],
        review_assets_repo: 'vektor-inc/review-assets',
      },
      vkTerminals: { gpu: 'off' },
    }));
    writeFileSync(targetPath, JSON.stringify({
      features: { task_queue: true },
      org: { allowed_owners: ['existing-owner'] },
    }));
    const logs = [];

    const result = migrateLegacyVkAgentsGuiKeys({
      orchestratorConfigPath: sourcePath,
      canonicalConfigPath: targetPath,
      log: (message) => logs.push(message),
    });

    assert.deepEqual(result, { migrated: true, sourcePath, targetPath });
    assert.deepEqual(JSON.parse(readFileSync(sourcePath, 'utf8')), {
      github: { owner: 'vektor-inc' },
      org: { allowed_owners: ['vektor-inc'] },
      vkTerminals: { gpu: 'off' },
    });
    assert.deepEqual(JSON.parse(readFileSync(targetPath, 'utf8')), {
      features: { task_queue: true, coderabbit: false, coderabbit_ignore: true },
      org: {
        allowed_owners: ['existing-owner'],
        review_assets_repo: 'vektor-inc/review-assets',
      },
      staff_wp_dev: { engine: 'codex' },
      staff_review: { engine: 'claude' },
      multi_repo_task: { default_engine: 'claude' },
    });
    assert.equal(logs.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateLegacyVkAgentsGuiKeys: canonical に既存値がある場合は上書きせず旧キーだけ削除する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-migrate-'));
  try {
    const sourcePath = join(dir, 'orchestrator.json');
    const targetPath = join(dir, '.vk-agents', 'config.json');
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(sourcePath, JSON.stringify({
      features: { coderabbit: false },
      org: { review_assets_repo: 'vektor-inc/old-assets' },
    }));
    writeFileSync(targetPath, JSON.stringify({
      features: { coderabbit: true },
      org: { review_assets_repo: 'vektor-inc/new-assets' },
    }));

    const result = migrateLegacyVkAgentsGuiKeys({
      orchestratorConfigPath: sourcePath,
      canonicalConfigPath: targetPath,
      log: () => {},
    });

    assert.equal(result.migrated, true);
    assert.deepEqual(JSON.parse(readFileSync(sourcePath, 'utf8')), {});
    assert.deepEqual(JSON.parse(readFileSync(targetPath, 'utf8')), {
      features: { coderabbit: true },
      org: { review_assets_repo: 'vektor-inc/new-assets' },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateLegacyVkAgentsGuiKeys: orchestrator config の vkAgents.configPath を canonical 移行先に使う', () => {
  withSavedEnv(['VK_AGENTS_CONFIG', 'VK_AGENTS_CONFIG_PATH'], () => {
    delete process.env.VK_AGENTS_CONFIG;
    delete process.env.VK_AGENTS_CONFIG_PATH;
    const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-migrate-'));
    try {
      const sourcePath = join(dir, 'orchestrator.json');
      const configuredTargetPath = join(dir, 'custom-vk-agents', 'config.json');
      const defaultTargetPath = join(dir, '.vk-agents', 'config.json');
      writeFileSync(sourcePath, JSON.stringify({
        vkAgents: { configPath: configuredTargetPath },
        features: { coderabbit: false },
      }));

      const result = migrateLegacyVkAgentsGuiKeys({
        orchestratorConfigPath: sourcePath,
        homeDir: dir,
        log: () => {},
      });

      assert.deepEqual(result, { migrated: true, sourcePath, targetPath: configuredTargetPath });
      assert.deepEqual(JSON.parse(readFileSync(sourcePath, 'utf8')), {
        vkAgents: { configPath: configuredTargetPath },
      });
      assert.deepEqual(JSON.parse(readFileSync(configuredTargetPath, 'utf8')), {
        features: { coderabbit: false },
      });
      assert.equal(existsSync(defaultTargetPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('migrateLegacyVkAgentsGuiKeys: 2 回目は冪等に書き込まない', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-migrate-'));
  try {
    const sourcePath = join(dir, 'orchestrator.json');
    const targetPath = join(dir, '.vk-agents', 'config.json');
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(sourcePath, JSON.stringify({ features: { coderabbit: false } }));

    migrateLegacyVkAgentsGuiKeys({
      orchestratorConfigPath: sourcePath,
      canonicalConfigPath: targetPath,
      log: () => {},
    });
    const sourceMtimeNs = statSync(sourcePath).mtimeNs;
    const targetMtimeNs = statSync(targetPath).mtimeNs;
    await sleep(10);

    const second = migrateLegacyVkAgentsGuiKeys({
      orchestratorConfigPath: sourcePath,
      canonicalConfigPath: targetPath,
      log: () => {},
    });

    assert.equal(second.migrated, false);
    assert.equal(statSync(sourcePath).mtimeNs, sourceMtimeNs);
    assert.equal(statSync(targetPath).mtimeNs, targetMtimeNs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateLegacyVkAgentsGuiKeys: orchestrator config が無い・不正 JSON の場合は安全に no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-migrate-'));
  const savedWarn = console.warn;
  const warnings = [];
  try {
    const missingSourcePath = join(dir, 'missing.json');
    const invalidSourcePath = join(dir, 'invalid.json');
    const targetPath = join(dir, '.vk-agents', 'config.json');
    writeFileSync(invalidSourcePath, '{ "features": {');
    console.warn = (message) => warnings.push(message);

    const missing = migrateLegacyVkAgentsGuiKeys({
      orchestratorConfigPath: missingSourcePath,
      canonicalConfigPath: targetPath,
      log: () => {},
    });
    const invalid = migrateLegacyVkAgentsGuiKeys({
      orchestratorConfigPath: invalidSourcePath,
      canonicalConfigPath: targetPath,
      log: () => {},
    });

    assert.equal(missing.migrated, false);
    assert.equal(invalid.migrated, false);
    assert.equal(existsSync(targetPath), false);
    assert.equal(readFileSync(invalidSourcePath, 'utf8'), '{ "features": {');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /移行をスキップ/);
  } finally {
    console.warn = savedWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vkAgentsGlobalSettingsPath: sync.sh と同じ Claude グローバル設定パスを返す', () => {
  assert.equal(
    vkAgentsGlobalSettingsPath('/tmp/home'),
    '/tmp/home/.claude/vk-agents-settings.json',
  );
});

test('vkAgentsSkillsManifestPath: sync.sh の Claude スキルマニフェストパスを返す', () => {
  assert.equal(
    vkAgentsSkillsManifestPath('/tmp/home'),
    '/tmp/home/.claude/skills/.agent-skills-manifest',
  );
});

test('vkAgentsSkillsManifestSourcePath: orchestrator 管理の展開元サイドカーパスを返す', () => {
  assert.equal(
    vkAgentsSkillsManifestSourcePath('/tmp/home'),
    '/tmp/home/.claude/skills/.agent-skills-manifest-source',
  );
});

test('isVkAgentsSetup: マニフェストの有無だけで setup 済みを判定する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-home-'));
  try {
    assert.equal(isVkAgentsSetup({ homeDir: dir }), false);
    const manifestPath = vkAgentsSkillsManifestPath(dir);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, 'vk-kore\n');
    assert.equal(isVkAgentsSetup({ homeDir: dir }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkAgentsManifestSource: sync.sh に消されないサイドカーへ展開元を JSON で記録する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-source-'));
  try {
    const sourcePath = join(dir, 'vendor', 'vk-agents-public');
    const recordPath = writeVkAgentsManifestSource(sourcePath, {
      homeDir: dir,
      now: new Date('2026-07-10T00:00:00.000Z'),
    });
    assert.equal(recordPath, vkAgentsSkillsManifestSourcePath(dir));
    assert.deepEqual(JSON.parse(readFileSync(recordPath, 'utf8')), {
      sourcePath: resolve(sourcePath),
      writtenAt: '2026-07-10T00:00:00.000Z',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkAgentsSettings: GUI の vk-agents 共通設定だけを read-merge-write し、既存キーを保持する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-'));
  try {
    const configPath = join(dir, 'config.json');
    const globalSettingsPath = join(dir, 'home', '.claude', 'vk-agents-settings.json');
    writeFileSync(configPath, JSON.stringify({
      org: { allowed_owners: ['vektor-inc'] },
      features: { task_queue: true },
      staff_wp_dev: { engine: 'claude' },
      staff_review: { engine: 'claude' },
      multi_repo_task: { default_engine: 'claude' },
    }));

    const result = writeVkAgentsSettings(
      {
        org: {
          review_assets_repo: 'vektor-inc/review-assets',
        },
        features: { coderabbit: false, coderabbit_ignore: true },
        staff_wp_dev: { engine: 'codex' },
        staff_review: { engine: 'codex' },
        multi_repo_task: { default_engine: 'codex' },
      },
      { configPath, globalSettingsPath },
    );

    assert.deepEqual(result, { configPath, globalSettingsPath });
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(written, {
      org: {
        allowed_owners: ['vektor-inc'],
        review_assets_repo: 'vektor-inc/review-assets',
      },
      features: { task_queue: true, coderabbit: false, coderabbit_ignore: true },
      staff_wp_dev: { engine: 'codex' },
      staff_review: { engine: 'codex' },
      multi_repo_task: { default_engine: 'codex' },
    });
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, 'utf8')), written);
    assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
    assert.equal(readdirSync(dirname(globalSettingsPath)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkAgentsSettings: ホワイトリスト対象外の workspace.search_paths を canonical から globalSettingsPath へパススルー同期する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-passthrough-'));
  try {
    const configPath = join(dir, 'config.json');
    const globalSettingsPath = join(dir, 'home', '.claude', 'vk-agents-settings.json');
    writeFileSync(configPath, JSON.stringify({
      org: { allowed_owners: ['vektor-inc'] },
      workspace: { search_paths: ['/Users/foo/git', '/Users/foo/projects'] },
    }));

    const result = writeVkAgentsSettings(
      { features: { coderabbit: false } },
      { configPath, globalSettingsPath },
    );

    assert.deepEqual(result, { configPath, globalSettingsPath });
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(written.workspace.search_paths, ['/Users/foo/git', '/Users/foo/projects']);
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, 'utf8')), written);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkAgentsSettings: up/apply 投影時に canonical の CodeRabbit 設定を stale な orchestrator config で上書きしない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-reset-'));
  try {
    const orchestratorConfigPath = join(dir, 'orchestrator.json');
    const canonicalConfigPath = join(dir, '.vk-agents', 'config.json');
    const globalSettingsPath = join(dir, '.claude', 'vk-agents-settings.json');
    mkdirSync(dirname(canonicalConfigPath), { recursive: true });
    writeFileSync(orchestratorConfigPath, JSON.stringify({
      features: { coderabbit: false },
    }));
    writeFileSync(canonicalConfigPath, JSON.stringify({
      features: { coderabbit: true },
    }));

    migrateLegacyVkAgentsGuiKeys({
      orchestratorConfigPath,
      canonicalConfigPath,
      log: () => {},
    });
    writeVkAgentsSettings(
      loadUnifiedConfig(orchestratorConfigPath),
      { configPath: canonicalConfigPath, globalSettingsPath },
    );

    assert.equal(JSON.parse(readFileSync(canonicalConfigPath, 'utf8')).features.coderabbit, true);
    assert.equal(JSON.parse(readFileSync(globalSettingsPath, 'utf8')).features.coderabbit, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkAgentsSettings: review_assets_repo の空値は vk-agents config から削除しフォールバックへ戻せる', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-'));
  try {
    const configPath = join(dir, 'config.json');
    const globalSettingsPath = join(dir, 'settings.json');
    writeFileSync(configPath, JSON.stringify({
      org: {
        allowed_owners: ['vektor-inc'],
        review_assets_repo: 'vektor-inc/review-assets',
      },
      features: { coderabbit: true },
    }));

    writeVkAgentsSettings(
      {
        org: {
          review_assets_repo: '',
        },
      },
      { configPath, globalSettingsPath },
    );

    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(written, {
      org: { allowed_owners: ['vektor-inc'] },
      features: { coderabbit: true },
    });
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, 'utf8')), written);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkAgentsSettings: review_assets_repo の不正形式は既存値を保持する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-'));
  try {
    const configPath = join(dir, 'config.json');
    const globalSettingsPath = join(dir, 'settings.json');
    writeFileSync(configPath, JSON.stringify({
      org: {
        review_assets_repo: 'vektor-inc/review-assets',
      },
      features: { coderabbit: true },
    }));

    writeVkAgentsSettings(
      {
        org: {
          review_assets_repo: 'review-assets',
        },
      },
      { configPath, globalSettingsPath },
    );

    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(written, {
      org: {
        review_assets_repo: 'vektor-inc/review-assets',
      },
      features: { coderabbit: true },
    });
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, 'utf8')), written);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkAgentsSettings: review_assets_repo のドットセグメントは既存値を保持する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-'));
  try {
    const configPath = join(dir, 'config.json');
    const globalSettingsPath = join(dir, 'settings.json');
    writeFileSync(configPath, JSON.stringify({
      org: {
        review_assets_repo: 'vektor-inc/review-assets',
      },
      features: { coderabbit: true },
    }));

    writeVkAgentsSettings(
      {
        org: {
          review_assets_repo: '../..',
        },
      },
      { configPath, globalSettingsPath },
    );

    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(written, {
      org: {
        review_assets_repo: 'vektor-inc/review-assets',
      },
      features: { coderabbit: true },
    });
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, 'utf8')), written);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('descriptor の pattern と投影の受理集合が一致する（owner/repo 形式）', () => {
  // descriptor（GUI 検証）の pattern と、applyVkAgentsGuiSettings による投影の受理条件が
  // 単一ソース（OWNER_REPO_PATTERN）から生成されていることを構造的にロックするテスト。
  // 同一入力に対し「descriptor の pattern が受理するか」と「投影が値を反映する（弾かない）か」が
  // 常に一致することを検証し、両者のドリフトを防ぐ。
  const descriptor = buildSettingsDescriptor('/tmp/does-not-exist-config.json');
  // 検証対象の owner/repo フィールド（org.review_assets_repo）を取り出す。
  const fields = descriptor.groups
    .flatMap((group) => group.fields ?? [])
    .filter((field) => field.key === 'org.review_assets_repo');
  assert.equal(fields.length, 1, '検証対象の owner/repo フィールドが 1 件見つかること');

  // 既存値を保持したうえで raw 値を投影し、実際に「反映されたか（受理）」を返すヘルパー。
  // 反映されれば trim 済みの raw が書き込まれ、弾かれれば既存値（sentinel）が残る。
  const SENTINEL = 'existing-owner/existing-repo';
  const projectionAccepts = (key, raw) => {
    const dir = mkdtempSync(join(tmpdir(), 'vko-owner-repo-'));
    try {
      const configPath = join(dir, 'config.json');
      const globalSettingsPath = join(dir, 'settings.json');
      writeFileSync(configPath, JSON.stringify({ org: { [key.split('.')[1]]: SENTINEL } }));
      writeVkAgentsSettings({ org: { [key.split('.')[1]]: raw } }, { configPath, globalSettingsPath });
      const written = JSON.parse(readFileSync(configPath, 'utf8'));
      return written.org?.[key.split('.')[1]] === String(raw).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  // 受理集合の期待値。valid はそのまま反映、invalid は弾いて既存値を保持する想定。
  const cases = [
    { raw: 'vektor-inc/task-queue', accept: true },
    { raw: '..foo/repo', accept: true },
    { raw: 'a.b/c-d', accept: true },
    { raw: '  vektor-inc/task-queue  ', accept: true }, // 前後空白は trim 後に受理される
    { raw: './x', accept: false },
    { raw: 'x/..', accept: false },
    { raw: '../x', accept: false },
    { raw: 'x/.', accept: false },
    { raw: 'noSlash', accept: false },
    { raw: 'a/b/c', accept: false },
  ];

  for (const field of fields) {
    // descriptor の pattern は JSON 直列化されるため必ず文字列で提供されていること。
    assert.equal(typeof field.pattern, 'string', `${field.key}: pattern が文字列であること`);
    assert.equal(typeof field.invalidMessage, 'string', `${field.key}: invalidMessage が文字列であること`);
    const patternRe = new RegExp(field.pattern);
    for (const { raw, accept } of cases) {
      // descriptor は trim 済みの値を検証する前提（GUI 保存時も trim される）。
      const descriptorAccepts = patternRe.test(String(raw).trim());
      const projected = projectionAccepts(field.key, raw);
      assert.equal(
        descriptorAccepts,
        projected,
        `${field.key} / ${JSON.stringify(raw)}: descriptor(${descriptorAccepts}) と投影(${projected}) が一致すること`,
      );
      assert.equal(descriptorAccepts, accept, `${field.key} / ${JSON.stringify(raw)}: 期待どおりの受理判定になること`);
    }
    // 空文字は pattern では受理されないが、投影では delete（空欄許容）として扱う特例。
    assert.equal(patternRe.test(''), false, `${field.key}: 空文字は pattern に一致しないこと`);
    const dir = mkdtempSync(join(tmpdir(), 'vko-owner-repo-'));
    try {
      const configPath = join(dir, 'config.json');
      const globalSettingsPath = join(dir, 'settings.json');
      const short = field.key.split('.')[1];
      writeFileSync(configPath, JSON.stringify({ org: { [short]: 'vektor-inc/kept' } }));
      writeVkAgentsSettings({ org: { [short]: '' } }, { configPath, globalSettingsPath });
      const written = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.equal(written.org?.[short], undefined, `${field.key}: 空文字は投影で delete される（空欄許容）`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('writeVkAgentsSettings: features.coderabbit_ignore の文字列 boolean を受け入れる', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-'));
  try {
    const configPath = join(dir, 'config.json');
    const globalSettingsPath = join(dir, 'settings.json');
    writeFileSync(configPath, JSON.stringify({
      features: { coderabbit: true, task_queue: true },
    }));

    writeVkAgentsSettings(
      { features: { coderabbit_ignore: 'true' } },
      { configPath, globalSettingsPath },
    );

    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(written, {
      features: { coderabbit: true, task_queue: true, coderabbit_ignore: true },
    });
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, 'utf8')), written);

    writeVkAgentsSettings(
      { features: { coderabbit_ignore: 'false' } },
      { configPath, globalSettingsPath },
    );

    const rewritten = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(rewritten, {
      features: { coderabbit: true, task_queue: true, coderabbit_ignore: false },
    });
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, 'utf8')), rewritten);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkAgentsSettings: 和田エンジンの空値は vk-agents config から削除し既定へ戻せる', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-'));
  try {
    const configPath = join(dir, 'config.json');
    const globalSettingsPath = join(dir, 'settings.json');
    writeFileSync(configPath, JSON.stringify({
      staff_wp_dev: { engine: 'codex', other: true },
      features: { coderabbit: true },
    }));

    writeVkAgentsSettings(
      { staff_wp_dev: { engine: '' } },
      { configPath, globalSettingsPath },
    );

    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(written, {
      staff_wp_dev: { other: true },
      features: { coderabbit: true },
    });
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, 'utf8')), written);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkAgentsSettings: 麗美エンジンの空値は vk-agents config から削除し既定へ戻せる', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-'));
  try {
    const configPath = join(dir, 'config.json');
    const globalSettingsPath = join(dir, 'settings.json');
    writeFileSync(configPath, JSON.stringify({
      staff_review: { engine: 'codex', other: true },
      features: { coderabbit: true },
    }));

    writeVkAgentsSettings(
      { staff_review: { engine: '' } },
      { configPath, globalSettingsPath },
    );

    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(written, {
      staff_review: { other: true },
      features: { coderabbit: true },
    });
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, 'utf8')), written);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkAgentsSettings: マルチリポタスク既定エンジンの空値は vk-agents config から削除し既定へ戻せる', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-'));
  try {
    const configPath = join(dir, 'config.json');
    const globalSettingsPath = join(dir, 'settings.json');
    writeFileSync(configPath, JSON.stringify({
      multi_repo_task: { default_engine: 'codex', other: true },
      features: { coderabbit: true },
    }));

    writeVkAgentsSettings(
      { multi_repo_task: { default_engine: '' } },
      { configPath, globalSettingsPath },
    );

    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(written, {
      multi_repo_task: { other: true },
      features: { coderabbit: true },
    });
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, 'utf8')), written);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkAgentsSettings: setup:agents 用に features/skills/org/engine を vk-agents config 形式へ生成する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-setup-'));
  try {
    const configPath = join(dir, 'vendor', 'vk-agents-public', 'config.json');
    const globalSettingsPath = join(dir, 'home', '.claude', 'vk-agents-settings.json');

    const result = writeVkAgentsSettings(
      {
        features: { coderabbit: false, task_queue: true },
        vkAgents: {
          disabledSkills: ['vk-pr', '', '  vk-sync-skills  '],
          allowedOwners: ['vektor-inc', '  kurudrive  '],
        },
        staff_wp_dev: { engine: 'codex' },
        staff_review: { engine: 'claude' },
        multi_repo_task: { default_engine: 'claude' },
      },
      { configPath, globalSettingsPath, force: true },
    );

    assert.deepEqual(result, { configPath, globalSettingsPath });
    const expected = {
      features: { coderabbit: false, task_queue: true },
      skills: { disabled: ['vk-pr', 'vk-sync-skills'] },
      org: { allowed_owners: ['vektor-inc', 'kurudrive'] },
      staff_wp_dev: { engine: 'codex' },
      staff_review: { engine: 'claude' },
      multi_repo_task: { default_engine: 'claude' },
    };
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), expected);
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, 'utf8')), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkAgentsSettings: setup:agents は allowed_owners / skills.disabled の vk-agents 形も受け入れる', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-setup-'));
  try {
    const configPath = join(dir, 'config.json');
    const globalSettingsPath = join(dir, 'settings.json');

    writeVkAgentsSettings(
      {
        vkAgents: {
          skills: { disabled: ['a'] },
          org: { allowed_owners: ['owner-a'] },
        },
      },
      { configPath, globalSettingsPath, force: true },
    );

    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      skills: { disabled: ['a'] },
      org: { allowed_owners: ['owner-a'] },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkAgentsSettings: config.json が無くても features GUI 設定があれば新規作成する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-'));
  try {
    const configPath = join(dir, 'missing', 'config.json');
    const globalSettingsPath = join(dir, 'settings.json');
    writeVkAgentsSettings(
      { features: { coderabbit: true } },
      { configPath, globalSettingsPath },
    );

    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      features: { coderabbit: true },
    });
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, 'utf8')), {
      features: { coderabbit: true },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkAgentsSettings: config.json が無くても org GUI 設定があれば新規作成する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-'));
  try {
    const configPath = join(dir, 'missing', 'config.json');
    const globalSettingsPath = join(dir, 'settings.json');
    writeVkAgentsSettings(
      { org: { review_assets_repo: 'vektor-inc/review-assets' } },
      { configPath, globalSettingsPath },
    );

    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      org: { review_assets_repo: 'vektor-inc/review-assets' },
    });
    assert.deepEqual(JSON.parse(readFileSync(globalSettingsPath, 'utf8')), {
      org: { review_assets_repo: 'vektor-inc/review-assets' },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkAgentsSettings: config.json も GUI 設定も無ければ何もしない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-'));
  try {
    const configPath = join(dir, 'config.json');
    const globalSettingsPath = join(dir, 'settings.json');
    const result = writeVkAgentsSettings({}, { configPath, globalSettingsPath });
    assert.equal(result, null);
    assert.throws(() => readFileSync(configPath, 'utf8'), /ENOENT/);
    assert.throws(() => readFileSync(globalSettingsPath, 'utf8'), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeVkAgentsSettings: vk-agents config.json が不正 JSON なら warn して非書き込みでスキップする', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkagents-'));
  const savedWarn = console.warn;
  const warnings = [];
  try {
    const configPath = join(dir, 'config.json');
    const globalSettingsPath = join(dir, 'settings.json');
    const invalidJson = '{ "features": {';
    writeFileSync(configPath, invalidJson);
    console.warn = (msg) => warnings.push(msg);

    const result = writeVkAgentsSettings(
      { features: { coderabbit: false }, staff_wp_dev: { engine: 'codex' } },
      { configPath, globalSettingsPath },
    );

    assert.equal(result, null);
    assert.equal(readFileSync(configPath, 'utf8'), invalidJson);
    assert.throws(() => readFileSync(globalSettingsPath, 'utf8'), /ENOENT/);
    assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /不正な JSON/);
  } finally {
    console.warn = savedWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------
// task / protocol / labels セクション（汎用化の土台。既定値は現行ハードコード値）
// -------------------------------------------------------

const TASK_ENV_KEYS = ['TASK_COMMAND_TEMPLATE', 'TASK_WP_PORT_BASE', 'TASK_WP_PORT_STRIDE', 'TASK_WP_ENV_ENABLED', 'TASK_CWD'];

function withoutTaskEnv(fn) {
  const saved = Object.fromEntries(TASK_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of TASK_ENV_KEYS) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const k of TASK_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function withoutConsoleWarn(fn) {
  const saved = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = saved;
  }
}

test('getTaskConfig: config 無しで既定値を返す', () => {
  withoutTaskEnv(() => {
    const t = getTaskConfig({});
    assert.ok(t.commandTemplate.includes('/vk-kore'));
    assert.ok(t.commandTemplate.includes('wp-env-port='));
    assert.ok(t.commandTemplate.includes('headless=1'));
    assert.equal(t.portBase, 9100);
    assert.equal(t.portStride, 2);
  });
});

test('getTaskConfig: wpEnv.enabled は既定で null（自動判定）', () => {
  withoutTaskEnv(() => {
    const t = getTaskConfig({});
    // null＝対象リポの .wp-env.json 有無で startTask が自動判定する。
    assert.equal(t.wpEnv.enabled, null);
  });
});

test('getTaskConfig: config.json で wpEnv.enabled を false に上書きできる', () => {
  withoutTaskEnv(() => {
    const t = getTaskConfig({ task: { wpEnv: { enabled: false } } });
    assert.equal(t.wpEnv.enabled, false);
    // 他の task キーは既定のまま
    assert.equal(t.portBase, 9100);
    assert.equal(t.portStride, 2);
  });
});

test('getTaskConfig: TASK_WP_ENV_ENABLED env が config.json より優先される', () => {
  withoutTaskEnv(() => {
    // config.json で true 指定 → env の 'false' が勝つ
    process.env.TASK_WP_ENV_ENABLED = 'false';
    assert.equal(getTaskConfig({ task: { wpEnv: { enabled: true } } }).wpEnv.enabled, false);

    // '0' も false 扱い
    process.env.TASK_WP_ENV_ENABLED = '0';
    assert.equal(getTaskConfig({}).wpEnv.enabled, false);

    // 'true' は true 扱い（config.json の false を上書きして true に戻せる）
    process.env.TASK_WP_ENV_ENABLED = 'true';
    assert.equal(getTaskConfig({ task: { wpEnv: { enabled: false } } }).wpEnv.enabled, true);
  });
});

test('getTaskConfig: 空文字の TASK_WP_ENV_ENABLED は無視され config.json/既定が使われる', () => {
  withoutTaskEnv(() => {
    process.env.TASK_WP_ENV_ENABLED = '';
    assert.equal(getTaskConfig({}).wpEnv.enabled, null); // 既定（自動判定）
    assert.equal(getTaskConfig({ task: { wpEnv: { enabled: false } } }).wpEnv.enabled, false);
  });
});

test('getTaskConfig: 空白のみの TASK_WP_ENV_ENABLED は未指定扱い（true に倒さない）', () => {
  withoutTaskEnv(() => {
    process.env.TASK_WP_ENV_ENABLED = '   ';
    // 空白のみは無視され、config.json の false がそのまま採用される
    assert.equal(getTaskConfig({ task: { wpEnv: { enabled: false } } }).wpEnv.enabled, false);
    assert.equal(getTaskConfig({}).wpEnv.enabled, null); // config も無ければ既定（自動判定）
  });
});

test('getQueueBackend: config 無しで既定値 local を返す', () => {
  withSavedEnv(['QUEUE_BACKEND'], () => {
    delete process.env.QUEUE_BACKEND;
    assert.equal(DEFAULT_QUEUE.backend, 'local');
    assert.equal(getQueueBackend({}), 'local');
  });
});

test('getQueueBackend: config.json の queue.backend を読む', () => {
  withSavedEnv(['QUEUE_BACKEND'], () => {
    delete process.env.QUEUE_BACKEND;
    assert.equal(getQueueBackend({ queue: { backend: 'local' } }), 'local');
  });
});

test('getQueueBackend: QUEUE_BACKEND env が config.json より優先される', () => {
  withSavedEnv(['QUEUE_BACKEND'], () => {
    process.env.QUEUE_BACKEND = 'github';
    assert.equal(getQueueBackend({ queue: { backend: 'local' } }), 'github');
  });
});

test('getQueueBackend: 未知の値は local にフォールバックする', () => {
  withSavedEnv(['QUEUE_BACKEND'], () => {
    const savedWarn = console.warn;
    const warnings = [];
    console.warn = (message) => warnings.push(message);
    try {
      process.env.QUEUE_BACKEND = 'unknown';
      assert.equal(getQueueBackend({ queue: { backend: 'github' } }), 'local');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /未知の queue\.backend/);
    } finally {
      console.warn = savedWarn;
    }
  });
});

test('isCoderabbitEnabled: features.coderabbit 未設定は既定 true', () => {
  assert.equal(isCoderabbitEnabled({}), true);
  assert.equal(isCoderabbitEnabled({ features: {} }), true);
});

test('isCoderabbitEnabled: features.coderabbit=false（真偽値・文字列）は false', () => {
  assert.equal(isCoderabbitEnabled({ features: { coderabbit: false } }), false);
  assert.equal(isCoderabbitEnabled({ features: { coderabbit: 'false' } }), false);
});

test('isCoderabbitEnabled: features.coderabbit=true は true', () => {
  assert.equal(isCoderabbitEnabled({ features: { coderabbit: true } }), true);
});

test('getTaskCwd: config 無しで専用ディレクトリを既定値として作成して返す', () => {
  withoutTaskEnv(() => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'vko-task-home-'));
    try {
      const expected = join(tmpHome, 'vk-orchestrator-tasks');
      const cwd = getTaskCwd({}, tmpHome);
      assert.equal(isAbsolute(cwd), true);
      assert.equal(cwd, expected);
      assert.equal(existsSync(cwd), true);
      assert.equal(getTaskCwd({}, tmpHome), expected);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

test('getTaskCwd: config.json の orchestrator.taskCwd は無視して既定へフォールバックする', () => {
  withoutTaskEnv(() => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'vko-task-home-'));
    const dir = mkdtempSync(join(tmpdir(), 'vko-task-abs-'));
    try {
      const fallback = join(tmpHome, 'vk-orchestrator-tasks');
      assert.equal(getTaskCwd({ orchestrator: { taskCwd: dir } }, tmpHome), fallback);
      assert.equal(existsSync(fallback), true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('getTaskCwd: config.json の相対 taskCwd も無視して既定へフォールバックする', () => {
  withoutTaskEnv(() => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'vko-task-home-'));
    try {
      const fallback = join(tmpHome, 'vk-orchestrator-tasks');
      const cwd = getTaskCwd({ orchestrator: { taskCwd: '.' } }, tmpHome);
      assert.equal(isAbsolute(cwd), true);
      assert.equal(cwd, fallback);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

test('getTaskCwd: TASK_CWD env が config.json の廃止済み taskCwd より優先される', () => {
  withoutTaskEnv(() => {
    const envDir = mkdtempSync(join(tmpdir(), 'vko-task-env-'));
    const configDir = mkdtempSync(join(tmpdir(), 'vko-task-config-'));
    try {
      process.env.TASK_CWD = envDir;
      assert.equal(getTaskCwd({ orchestrator: { taskCwd: configDir } }), envDir);
    } finally {
      rmSync(envDir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

test('getTaskCwd: 空文字/空白のみの orchestrator.taskCwd は既定へフォールバックする', () => {
  withoutTaskEnv(() => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'vko-task-home-'));
    try {
      const fallback = join(tmpHome, 'vk-orchestrator-tasks');
      assert.equal(getTaskCwd({ orchestrator: { taskCwd: '' } }, tmpHome), fallback);
      assert.equal(getTaskCwd({ orchestrator: { taskCwd: '   ' } }, tmpHome), fallback);
      assert.equal(existsSync(fallback), true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

test('getTaskCwd: 明示値は存在しなくても自動作成しない', () => {
  withoutTaskEnv(() => {
    withoutConsoleWarn(() => {
      const dir = mkdtempSync(join(tmpdir(), 'vko-task-explicit-'));
      try {
        const missing = join(dir, 'missing-task-cwd');
        process.env.TASK_CWD = missing;
        const cwd = getTaskCwd({});
        assert.equal(cwd, resolve(missing));
        assert.equal(existsSync(cwd), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// -------------------------------------------------------
// GUI 設定パネル由来の空値汚染（"" / null / [] / {}）が既定を潰さないこと
// （設定パネルは全項目を書き戻すため、未入力項目が空で保存されうる）
// -------------------------------------------------------

test('getTaskConfig: 空文字/null の config 値は既定にフォールバックする（GUI 汚染耐性）', () => {
  withoutTaskEnv(() => {
    const t = getTaskConfig({ task: { commandTemplate: '', portBase: null, portStride: null } });
    assert.ok(t.commandTemplate.includes('/vk-kore')); // 既定に戻る
    assert.equal(t.portBase, 9100);
    assert.equal(t.portStride, 2);
  });
});

test('getLabelsConfig: 空配列/空文字の config 値は既定にフォールバックする（GUI 汚染耐性）', () => {
  const l = getLabelsConfig({ labels: { status: [], priority: [], automerge: '', sequential: '', parallel: '' } });
  assert.equal(l.status.ready, 'status:ready');       // 空配列 [] で潰れない
  assert.equal(l.status.inProgress, 'status:in-progress');
  assert.equal(l.priority.high, 'priority:high');
  assert.equal(l.automerge, 'automerge');             // 空文字 "" で潰れない
  assert.equal(l.sequential, 'sequential');
  assert.equal(l.parallel, 'parallel');
});

test('getProtocolConfig: 空文字/空配列の config 値は既定にフォールバックする（GUI 汚染耐性）', () => {
  const p = getProtocolConfig({ protocol: { statusLinePrefix: '', statusTokens: [] } });
  assert.equal(p.statusLinePrefix, 'Status:');
  assert.equal(p.statusTokens.waitingInput, 'waiting-input');
});

test('pruneEmpty 経由でも false / 0 は有意値として残る', () => {
  withoutTaskEnv(() => {
    // wpEnv.enabled:false は空扱いにされず反映される
    assert.equal(getTaskConfig({ task: { wpEnv: { enabled: false } } }).wpEnv.enabled, false);
  });
});

test('getProtocolConfig: 既定値を返す', () => {
  const p = getProtocolConfig({});
  assert.equal(p.statusLinePrefix, 'Status:');
  assert.equal(p.statusTokens.waitingInput, 'waiting-input');
  assert.equal(p.statusTokens.noAction, 'no-action');
  assert.equal(p.statusTokens.answered, 'answered');
});

test('getLabelsConfig: 既定値を返す', () => {
  const l = getLabelsConfig({});
  assert.equal(l.status.inProgress, 'status:in-progress');
  assert.equal(l.status.awaitingApproval, 'status:awaiting-approval');
  assert.equal(l.priority.high, 'priority:high');
  assert.equal(l.automerge, 'automerge');
  assert.equal(l.sequential, 'sequential');
  assert.equal(l.parallel, 'parallel');
  assert.equal(l.workingInProgress, 'working');
});

test('getLabelsConfig: workingInProgress は config.json で上書き可能（GUI 非公開の隠しオプション）', () => {
  const l = getLabelsConfig({ labels: { workingInProgress: '作業中' } });
  assert.equal(l.workingInProgress, '作業中');   // 上書きされる
  assert.equal(l.automerge, 'automerge');        // 未指定キーは既定のまま
});

test('DEFAULT_LABELS: dead config だった e2ePassed / e2ePassedShaPrefix は存在しない', () => {
  assert.equal('e2ePassed' in DEFAULT_LABELS, false);
  assert.equal('e2ePassedShaPrefix' in DEFAULT_LABELS, false);
});

test('getLabelsConfig: config.json の部分上書きが効き、未指定キーは既定にフォールバック', () => {
  const l = getLabelsConfig({ labels: { status: { done: 'x' } } });
  assert.equal(l.status.done, 'x');            // 上書きされる
  assert.equal(l.status.inProgress, 'status:in-progress'); // 未指定は既定のまま
  assert.equal(l.automerge, 'automerge');      // 他セクションも既定のまま
});

test('getProtocolConfig: statusTokens の部分上書き（ディープマージ）', () => {
  const p = getProtocolConfig({ protocol: { statusTokens: { answered: 'done' } } });
  assert.equal(p.statusTokens.answered, 'done');
  assert.equal(p.statusTokens.waitingInput, 'waiting-input'); // 未指定は既定
});

test('getTaskConfig: config.json が既定を上書きする', () => {
  withoutTaskEnv(() => {
    const t = getTaskConfig({ task: { portBase: 9200 } });
    assert.equal(t.portBase, 9200);
    assert.equal(t.portStride, 2); // 未指定は既定
  });
});

test('getTaskConfig: env が config.json より優先される', () => {
  // withoutTaskEnv が TASK_* を退避→finally で復元するので、その中で env を設定すれば
  // save/restore を手書きせずに済む（重複解消）。
  withoutTaskEnv(() => {
    process.env.TASK_WP_PORT_BASE = '9500';
    process.env.TASK_WP_PORT_STRIDE = '4';
    process.env.TASK_COMMAND_TEMPLATE = '/custom {issueUrl}';
    const t = getTaskConfig({ task: { portBase: 9200, portStride: 3, commandTemplate: '/cfg' } });
    assert.equal(t.portBase, 9500);
    assert.equal(t.portStride, 4);
    assert.equal(t.commandTemplate, '/custom {issueUrl}');
  });
});

test('getLabelsConfig: __proto__ ペイロードでグローバル汚染しない', () => {
  const l = getLabelsConfig(JSON.parse('{"labels":{"__proto__":{"polluted":"x"}}}'));
  assert.equal({}.polluted, undefined);
  assert.equal(l.automerge, 'automerge'); // 既定は維持
});

test('buildSettingsDescriptor: 共有契約系フィールドを UI から除外する', () => {
  const desc = buildSettingsDescriptor('/tmp/config.json');
  const labels = desc.groups.map((g) => g.label);
  // task.commandTemplate は独立グループを廃止し「オーケストレーター」グループへ統合済み。
  assert.ok(!labels.includes('issue を処理する Claude のコマンド'));
  assert.ok(!labels.includes('タスク'));
  assert.ok(!labels.includes('プロトコル'));
  assert.ok(!labels.includes('ラベル'));

  const fieldKeys = desc.groups.flatMap((g) => (g.fields ?? []).map((f) => f.key));
  assert.ok(fieldKeys.includes('task.commandTemplate'));
  const taskCommandGroup = desc.groups.find((g) => g.label === 'オーケストレーター');
  assert.ok(taskCommandGroup);
  const commandTemplateField = taskCommandGroup.fields.find((f) => f.key === 'task.commandTemplate');
  assert.ok(commandTemplateField);
  // ラベルは「issue を処理する Claude のコマンドテンプレート」へ変更。
  assert.equal(commandTemplateField.label, 'issue を処理する Claude のコマンドテンプレート');
  assert.ok(commandTemplateField.placeholder.includes('/vk-kore'));
  assert.match(commandTemplateField.help, /\{issueUrl\}/);
  assert.match(commandTemplateField.help, /\{wpPort\}/);
  const githubGroup = desc.groups.find((g) => g.label === 'GitHub');
  assert.match(githubGroup?.note ?? '', /gh auth login/);
  assert.match(githubGroup?.note ?? '', /このパネルでの入力は廃止/);
  // GitHub トークンは gh auth login 推奨のため、GUI から config.json へ保存する導線を出さない。
  assert.ok(!fieldKeys.includes('github.token'));
  assert.ok(!fieldKeys.includes('task.requireE2eGate')); // #57 で requireE2eGate 廃止

  assert.ok(!fieldKeys.includes('protocol.statusLinePrefix'));
  assert.ok(!fieldKeys.includes('protocol.statusTokens'));
  // 識別行マーカーは撤去済み（#9）。GUI フィールドも消えていること。
  assert.ok(!fieldKeys.includes('protocol.agentMarker'));
  assert.ok(!fieldKeys.includes('labels.status'));
  assert.ok(!fieldKeys.includes('labels.priority'));
  assert.ok(!fieldKeys.includes('labels.automerge'));
  assert.ok(!fieldKeys.includes('labels.sequential'));
  assert.ok(!fieldKeys.includes('labels.parallel'));
  // dead config だった e2e 完了マーカー枠（#10）も GUI から消えていること。
  assert.ok(!fieldKeys.includes('labels.e2ePassed'));
  assert.ok(!fieldKeys.includes('labels.e2ePassedShaPrefix'));
  // 作業中ラベルは隠しオプション化（#11）。GUI フィールドには出ないこと。
  assert.ok(!fieldKeys.includes('labels.workingInProgress'));
  assert.ok(!fieldKeys.includes('task.portBase'));
  assert.ok(!fieldKeys.includes('task.portStride'));
  // wp-env 連携は対象リポの .wp-env.json 有無で自動判定するようになり、手動トグルは撤去済み。
  // config.json / 環境変数（task.wpEnv.enabled）での明示指定は脱出ハッチとして残すが GUI には出さない。
  assert.ok(!fieldKeys.includes('task.wpEnv.enabled'));
});

test('buildSettingsDescriptor: オーケストレーターグループ先頭に queue.backend select を持つ', () => {
  const desc = buildSettingsDescriptor('/tmp/config.json');
  const orchestratorGroup = desc.groups.find((g) => g.label === 'オーケストレーター');
  assert.ok(orchestratorGroup);
  // queue.backend は「オーケストレーター」グループ先頭に置く。
  assert.equal(orchestratorGroup.fields[0].key, 'queue.backend');
  const backendField = orchestratorGroup.fields[0];
  assert.equal(backendField.type, 'select');
  // 既定はローカル（DEFAULT_QUEUE.backend / getQueueBackend の解決と一致）。
  assert.equal(backendField.default, DEFAULT_QUEUE.backend);
  assert.equal(backendField.default, 'local');
  const optionValues = backendField.options.map((o) => o.value);
  assert.deepEqual(optionValues, ['local', 'github']);
});

test('buildSettingsDescriptor: github.repo は local モードで hide する visibleWhen を宣言する', () => {
  const desc = buildSettingsDescriptor('/tmp/config.json');
  const repoField = desc.groups
    .flatMap((g) => g.fields ?? [])
    .find((f) => f.key === 'github.repo');
  assert.ok(repoField);
  assert.deepEqual(repoField.visibleWhen, { key: 'queue.backend', value: 'local', hide: true });
  // 必須フラグは持たない（ローカルモードで未設定でも起動できることの担保）。
  assert.ok(!repoField.required);
});

test('buildSettingsDescriptor: sourceOrg は空欄保存時に未指定として扱う', () => {
  const desc = buildSettingsDescriptor('/tmp/config.json');
  const sourceOrgField = desc.groups
    .flatMap((g) => g.fields ?? [])
    .find((f) => f.key === 'github.sourceOrg');
  assert.ok(sourceOrgField);
  assert.equal(sourceOrgField.emptyToNull, true);
});

test('buildSettingsDescriptor: tabs と各 group の tab 割り当てを持つ', () => {
  const desc = buildSettingsDescriptor('/tmp/config.json');
  assert.deepEqual(desc.tabs, [
    { id: 'orchestrator', label: 'Orchestrator', note: '保存した設定は次回起動時以降に反映されます。' },
    { id: 'terminals', label: 'Terminals', note: '保存した設定は次回起動時以降に反映されます。' },
    { id: 'agents', label: 'VK Agents', note: '保存した設定は次回セッション以降に反映されます。' },
  ]);
  const tabsByLabel = Object.fromEntries(desc.groups.map((group) => [group.label, group.tab]));
  assert.equal(tabsByLabel.GitHub, 'orchestrator');
  assert.equal(tabsByLabel['オーケストレーター'], 'orchestrator');
  assert.equal(tabsByLabel['VK Terminals（本体設定）'], 'terminals');
  assert.equal(tabsByLabel['VK Terminals 起動オプション（オーケストレーター制御）'], undefined);
  // 独立していた「issue を処理する Claude のコマンド」グループは廃止（オーケストレーターへ統合）。
  assert.equal(tabsByLabel['issue を処理する Claude のコマンド'], undefined);
  assert.equal(tabsByLabel['vk-agents（エージェント共通設定）'], 'agents');

  // Orchestrator タブ内は「オーケストレーター」→「GitHub」の順。
  const orchestratorLabels = desc.groups.filter((g) => g.tab === 'orchestrator').map((g) => g.label);
  assert.deepEqual(orchestratorLabels, ['オーケストレーター', 'GitHub']);
});

test('buildSettingsDescriptor: 保存後の反映タイミング案内をタブごとの note で持つ', () => {
  const desc = buildSettingsDescriptor('/tmp/config.json');
  assert.equal(desc.note, undefined);

  const tabsById = Object.fromEntries(desc.tabs.map((tab) => [tab.id, tab]));
  assert.equal(tabsById.orchestrator.note, '保存した設定は次回起動時以降に反映されます。');
  assert.equal(tabsById.terminals.note, '保存した設定は次回起動時以降に反映されます。');
  assert.equal(tabsById.agents.note, '保存した設定は次回セッション以降に反映されます。');
});

test('buildSettingsDescriptor: vk-agents 共通設定グループを含む', () => {
  const desc = buildSettingsDescriptor('/tmp/config.json');
  const group = desc.groups.find((g) => g.label === 'vk-agents（エージェント共通設定）');
  assert.ok(group);
  assert.match(group.note, /vk-agents の config に保存/);

  const coderabbitField = group.fields.find((f) => f.key === 'features.coderabbit');
  assert.ok(coderabbitField);
  assert.equal(coderabbitField.type, 'boolean');
  assert.equal(coderabbitField.default, true);
  assert.match(coderabbitField.help, /CodeRabbit/);

  const reviewAssetsRepoField = group.fields.find((f) => f.key === 'org.review_assets_repo');
  assert.ok(reviewAssetsRepoField);
  assert.equal(reviewAssetsRepoField.label, 'レビュー用アセットリポジトリ');
  assert.equal(reviewAssetsRepoField.type, 'text');
  assert.equal(reviewAssetsRepoField.placeholder, 'owner/repo');
  assert.equal(reviewAssetsRepoField.emptyToNull, true);
  assert.match(reviewAssetsRepoField.help, /<owner>\/<repo>/);
  assert.match(reviewAssetsRepoField.help, /vektor-inc\/review-assets/);
  assert.match(reviewAssetsRepoField.help, /形式が正しくない値は反映されません/);
  assert.match(reviewAssetsRepoField.help, /画像アップロードをスキップ/);
  assert.match(reviewAssetsRepoField.help, /テキスト記述/);

  const coderabbitIgnoreField = group.fields.find((f) => f.key === 'features.coderabbit_ignore');
  assert.ok(coderabbitIgnoreField);
  assert.equal(coderabbitIgnoreField.type, 'boolean');
  assert.equal(coderabbitIgnoreField.default, false);
  assert.match(coderabbitIgnoreField.label, /@coderabbitai ignore/);
  assert.match(coderabbitIgnoreField.help, /features\.coderabbit/);

  const engineField = group.fields.find((f) => f.key === 'staff_wp_dev.engine');
  assert.ok(engineField);
  assert.equal(engineField.label, 'staff-wp-dev（和田）の実行エンジン');
  assert.equal(engineField.type, 'select');
  assert.deepEqual(
    engineField.options.map((o) => o.value),
    ['', 'claude', 'codex'],
  );
  assert.match(engineField.options.find((o) => o.value === 'codex').label, /push\/PR/);

  const reviewEngineField = group.fields.find((f) => f.key === 'staff_review.engine');
  assert.ok(reviewEngineField);
  assert.equal(reviewEngineField.label, 'staff-review（麗美）の実行エンジン');
  assert.equal(reviewEngineField.type, 'select');
  assert.deepEqual(
    reviewEngineField.options.map((o) => o.value),
    ['', 'claude', 'codex'],
  );
  assert.match(reviewEngineField.options.find((o) => o.value === 'codex').label, /司が担当/);

  const multiRepoEngineField = group.fields.find((f) => f.key === 'multi_repo_task.default_engine');
  assert.ok(multiRepoEngineField);
  assert.equal(multiRepoEngineField.label, 'vk-multi-repo-task の既定実行エンジン');
  assert.equal(multiRepoEngineField.type, 'select');
  assert.deepEqual(
    multiRepoEngineField.options.map((o) => o.value),
    ['', 'claude', 'codex'],
  );
  assert.equal(multiRepoEngineField.options.find((o) => o.value === 'codex').label, 'Codex');
  assert.match(multiRepoEngineField.help, /vk-multi-repo-task/);
  assert.match(multiRepoEngineField.help, /Claude/);
});

test('buildSettingsDescriptor: Agents グループは workspace.search_paths（lines）を先頭に、CodeRabbit 2項目を末尾に持つ', () => {
  const desc = buildSettingsDescriptor('/tmp/config.json');
  const orchestratorGroup = desc.groups.find((g) => g.label === 'オーケストレーター');
  assert.ok(orchestratorGroup);
  assert.equal(orchestratorGroup.fields.some((field) => field.key === 'orchestrator.taskCwd'), false);

  const group = desc.groups.find((g) => g.label === 'vk-agents（エージェント共通設定）');
  assert.ok(group);

  // 先頭が workspace.search_paths（lines 型）
  const first = group.fields[0];
  assert.equal(first.key, 'workspace.search_paths');
  assert.equal(first.type, 'lines');
  assert.match(first.help, /優先/);
  assert.match(first.help, /絶対パス/);
  assert.match(first.help, /最大 4 階層/);
  assert.match(first.help, /~/);

  // CodeRabbit 2項目が末尾（順序も固定）
  const keys = group.fields.map((f) => f.key);
  assert.deepEqual(keys.slice(-2), ['features.coderabbit', 'features.coderabbit_ignore']);

  // 全体の並び順
  assert.deepEqual(keys, [
    'workspace.search_paths',
    'org.review_assets_repo',
    'staff_wp_dev.engine',
    'staff_review.engine',
    'multi_repo_task.default_engine',
    'features.coderabbit',
    'features.coderabbit_ignore',
  ]);
});

test('buildSettingsDescriptor: VK Terminals 本体設定は settings-schema.json 由来フィールドと port を表示する', () => {
  withVkTerminalsSchema(vkTerminalsSchemaFixture(), (vkTerminalsDir) => {
    const desc = buildSettingsDescriptor('/tmp/config.json', { vkTerminalsDir });
    const group = desc.groups.find((g) => g.label === 'VK Terminals（本体設定）');
    assert.ok(group);
    assert.equal(group.tab, 'terminals');
    assert.equal(group.targetPath, '~/.vk-terminals/config.json');
    assert.match(group.note, /VK Terminals 本体の設定ファイル/);
    assert.deepEqual(
      group.fields.map((field) => field.key),
      ['apiHost', 'port', 'initialCommand', 'confirmClose', 'gpu'],
    );
    assert.equal(group.fields.find((field) => field.key === 'port').type, 'number');
    assert.match(group.fields.find((field) => field.key === 'port').help, /13847/);
    assert.equal(group.fields.find((field) => field.key === 'confirmClose').type, 'select');
    assert.deepEqual(group.fields.find((field) => field.key === 'confirmClose').options, [{ value: 'busy', label: '実行中のみ確認' }]);
  });
});

test('buildSettingsDescriptor: VK Terminals スキーマ側に port があれば追加挿入しない', () => {
  withVkTerminalsSchema(vkTerminalsSchemaFixture([{
    label: '基本',
    fields: [
      { key: 'apiHost', label: 'API ホスト', type: 'text' },
      { key: 'port', label: '本体側 API ポート', type: 'number', help: 'VK Terminals 側の定義' },
      { key: 'initialCommand', label: '初期コマンド', type: 'text' },
    ],
  }]), (vkTerminalsDir) => {
    const desc = buildSettingsDescriptor('/tmp/config.json', { vkTerminalsDir });
    const group = desc.groups.find((g) => g.label === 'VK Terminals（本体設定）');
    assert.deepEqual(group.fields.map((field) => field.key), ['apiHost', 'port', 'initialCommand']);
    assert.equal(group.fields.filter((field) => field.key === 'port').length, 1);
    assert.equal(group.fields.find((field) => field.key === 'port').label, '本体側 API ポート');
    assert.equal(group.fields.find((field) => field.key === 'port').help, 'VK Terminals 側の定義');
  });
});

test('buildSettingsDescriptor: VK Terminals スキーマが複数グループなら group label を suffix にする', () => {
  withVkTerminalsSchema(vkTerminalsSchemaFixture([
    {
      label: '基本',
      fields: [
        { key: 'apiHost', label: 'API ホスト', type: 'text' },
        { key: 'initialCommand', label: '初期コマンド', type: 'text' },
      ],
    },
    {
      label: '表示',
      fields: [
        { key: 'showUsage', label: '使用量表示', type: 'boolean' },
      ],
    },
  ]), (vkTerminalsDir) => {
    const desc = buildSettingsDescriptor('/tmp/config.json', { vkTerminalsDir });
    const terminalGroups = desc.groups.filter((g) => g.targetPath === '~/.vk-terminals/config.json');
    assert.deepEqual(
      terminalGroups.map((group) => group.label),
      ['VK Terminals（本体設定）: 基本', 'VK Terminals（本体設定）: 表示'],
    );
    assert.deepEqual(terminalGroups[0].fields.map((field) => field.key), ['apiHost', 'port', 'initialCommand']);
    assert.deepEqual(terminalGroups[1].fields.map((field) => field.key), ['showUsage']);
  });
});

test('buildSettingsDescriptor: apiHost がないスキーマでは port を先頭へ挿入する', () => {
  withVkTerminalsSchema(vkTerminalsSchemaFixture([{
    label: '基本',
    fields: [
      { key: 'initialCommand', label: '初期コマンド', type: 'text' },
      { key: 'gpu', label: 'GPU モード', type: 'select', options: [] },
    ],
  }]), (vkTerminalsDir) => {
    const desc = buildSettingsDescriptor('/tmp/config.json', { vkTerminalsDir });
    const group = desc.groups.find((g) => g.label === 'VK Terminals（本体設定）');
    assert.deepEqual(group.fields.map((field) => field.key), ['port', 'initialCommand', 'gpu']);
  });
});

test('buildSettingsDescriptor: hiddenKeys 指定時は該当フィールドだけ除外し、全除外グループは出さない', () => {
  withVkTerminalsSchema(vkTerminalsSchemaFixture([
    {
      label: '基本',
      fields: [
        { key: 'apiHost', label: 'API ホスト', type: 'text' },
        { key: 'initialCommand', label: '初期コマンド', type: 'text' },
      ],
    },
    {
      label: '表示',
      fields: [
        { key: 'showUsage', label: '使用量表示', type: 'boolean' },
      ],
    },
  ]), (vkTerminalsDir) => {
    const desc = buildSettingsDescriptor('/tmp/config.json', {
      vkTerminalsDir,
      hiddenKeys: ['initialCommand', 'showUsage'],
    });
    const terminalGroups = desc.groups.filter((g) => g.targetPath === '~/.vk-terminals/config.json');
    assert.deepEqual(terminalGroups.map((group) => group.label), ['VK Terminals（本体設定）: 基本']);
    assert.deepEqual(terminalGroups[0].fields.map((field) => field.key), ['apiHost', 'port']);
  });
});

test('buildSettingsDescriptor: hiddenKeys で全フィールド除外でも port のみの VK Terminals 本体設定グループを残す', () => {
  withVkTerminalsSchema(vkTerminalsSchemaFixture(), (vkTerminalsDir) => {
    const savedWarn = console.warn;
    const warnings = [];
    try {
      console.warn = (message) => warnings.push(message);
      const desc = buildSettingsDescriptor('/tmp/config.json', {
        vkTerminalsDir,
        hiddenKeys: ['apiHost', 'initialCommand', 'confirmClose', 'gpu'],
      });
      const group = desc.groups.find((g) => g.label === 'VK Terminals（本体設定）');
      assert.ok(group);
      assert.equal(group.targetPath, '~/.vk-terminals/config.json');
      assert.deepEqual(group.fields.map((field) => field.key), ['port']);
      assert.ok(warnings.some((message) => /表示可能.*port.*のみ表示/.test(message)));
    } finally {
      console.warn = savedWarn;
    }
  });
});

test('buildSettingsDescriptor: settings-schema.json の groups が空配列なら port のみ表示する', () => {
  withVkTerminalsSchema(vkTerminalsSchemaFixture([]), (vkTerminalsDir) => {
    const savedWarn = console.warn;
    const warnings = [];
    try {
      console.warn = (message) => warnings.push(message);
      const desc = buildSettingsDescriptor('/tmp/config.json', { vkTerminalsDir });
      const group = desc.groups.find((g) => g.label === 'VK Terminals（本体設定）');
      assert.ok(group);
      assert.equal(group.targetPath, '~/.vk-terminals/config.json');
      assert.deepEqual(group.fields.map((field) => field.key), ['port']);
      assert.ok(warnings.some((message) => /表示可能.*port.*のみ表示/.test(message)));
    } finally {
      console.warn = savedWarn;
    }
  });
});

test('buildSettingsDescriptor: settings-schema.json が無い場合は warn して port のみ表示する', () => {
  withTmpDir('vko-vk-terminals-empty-', (vkTerminalsDir) => {
    const savedWarn = console.warn;
    const warnings = [];
    try {
      console.warn = (message) => warnings.push(message);
      const desc = buildSettingsDescriptor('/tmp/config.json', { vkTerminalsDir });
      const group = desc.groups.find((g) => g.label === 'VK Terminals（本体設定）');
      assert.ok(group);
      assert.deepEqual(group.fields.map((field) => field.key), ['port']);
      const allKeys = desc.groups.flatMap((g) => (g.fields ?? []).map((field) => field.key));
      assert.equal(allKeys.includes('apiHost'), false);
      assert.equal(allKeys.includes('initialCommand'), false);
      assert.equal(allKeys.includes('additionalPanes'), false);
      assert.equal(allKeys.includes('newPaneAutoLaunchClaude'), false);
      assert.equal(allKeys.includes('vkTerminals.gpu'), false);
      assert.equal(desc.groups.some((g) => g.label === 'VK Terminals 起動オプション（オーケストレーター制御）'), false);
      assert.ok(warnings.some((message) => /port.*のみ表示/.test(message)));
    } finally {
      console.warn = savedWarn;
    }
  });
});

test('buildSettingsDescriptor: settings-schema.json が不正 JSON または構造不正でも port のみ表示する', () => {
  for (const schemaText of ['{', JSON.stringify({ groups: [{ label: '基本', fields: [{ key: 'apiHost', label: 'API ホスト' }] }] })]) {
    withTmpDir('vko-vk-terminals-invalid-', (vkTerminalsDir) => {
      writeFileSync(join(vkTerminalsDir, 'settings-schema.json'), schemaText);
      const savedWarn = console.warn;
      const warnings = [];
      try {
        console.warn = (message) => warnings.push(message);
        const desc = buildSettingsDescriptor('/tmp/config.json', { vkTerminalsDir });
        const group = desc.groups.find((g) => g.label === 'VK Terminals（本体設定）');
        assert.ok(group);
        assert.deepEqual(group.fields.map((field) => field.key), ['port']);
        assert.ok(warnings.some((message) => /settings-schema\.json/.test(message)));
      } finally {
        console.warn = savedWarn;
      }
    });
  }
});

test('buildSettingsDescriptor: vk-agents group は正本リゾルバ（env 上書き）を targetPath に持つ', () => {
  withSavedEnv(['VK_AGENTS_CONFIG', 'VK_AGENTS_CONFIG_PATH'], () => {
    const configPath = join(tmpdir(), 'vk-agents-settings.json');
    process.env.VK_AGENTS_CONFIG = configPath;
    const desc = buildSettingsDescriptor('/tmp/config.json');
    const group = desc.groups.find((g) => g.label === 'vk-agents（エージェント共通設定）');
    assert.ok(group);
    assert.equal(group.targetPath, resolveVkAgentsCanonicalConfigPath());
    assert.equal(group.targetPath, configPath);
  });
});

test('resolveVkAgentsCanonicalConfigPath: 明示・env が無ければ揮発せず ~/.vk-agents/config.json を返す（null/vendored にしない）', () => {
  withSavedEnv(['VK_AGENTS_CONFIG', 'VK_AGENTS_CONFIG_PATH', 'VK_AGENTS_DIR', 'VK_AGENTS_REPO_PATH'], () => {
    delete process.env.VK_AGENTS_CONFIG;
    delete process.env.VK_AGENTS_CONFIG_PATH;
    delete process.env.VK_AGENTS_DIR;
    delete process.env.VK_AGENTS_REPO_PATH;
    // home 正本が存在しない一時ディレクトリを home に見立てても、正本パスを返し続ける。
    const fakeHome = mkdtempSync(join(tmpdir(), 'vko-home-'));
    try {
      const resolved = resolveVkAgentsCanonicalConfigPath({}, { homeDir: fakeHome });
      assert.equal(resolved, join(fakeHome, '.vk-agents', 'config.json'));
      // vendored（<repo>/vendor/vk-agents-public）へは決してフォールバックしない。
      assert.equal(resolved.includes('vendor'), false);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

test('buildSettingsDescriptor: home 正本・repo が無くても vk-agents group の targetPath は null にならない（descriptor 無効化事故の防止）', () => {
  withSavedEnv(['VK_AGENTS_CONFIG', 'VK_AGENTS_CONFIG_PATH'], () => {
    delete process.env.VK_AGENTS_CONFIG;
    delete process.env.VK_AGENTS_CONFIG_PATH;
    const desc = buildSettingsDescriptor('/tmp/config.json');
    const group = desc.groups.find((g) => g.label === 'vk-agents（エージェント共通設定）');
    assert.ok(group);
    assert.equal(typeof group.targetPath, 'string');
    assert.ok(group.targetPath.length > 0);
    assert.ok(group.targetPath.endsWith(join('.vk-agents', 'config.json')));
  });
});

// -------------------------------------------------------
// GPU 起動モード（GUI/Electron の HW-GPU 利用切り替え）
// -------------------------------------------------------

function withoutGpuEnv(fn) {
  const saved = process.env.VK_TERMINALS_GPU;
  delete process.env.VK_TERMINALS_GPU;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.VK_TERMINALS_GPU;
    else process.env.VK_TERMINALS_GPU = saved;
  }
}

test('defaultGpuMode: macOS は default、それ以外は off', () => {
  assert.equal(defaultGpuMode('darwin'), 'default');
  assert.equal(defaultGpuMode('linux'), 'off');
  assert.equal(defaultGpuMode('win32'), 'off');
});

test('getVkTerminalsGpuMode: 未設定はプラットフォーム既定にフォールバック', () => {
  withoutGpuEnv(() => {
    withTmpDir('vko-vk-terminals-home-', (homeDir) => {
      assert.equal(getVkTerminalsGpuMode({ homeDir }, 'linux'), 'off');
      assert.equal(getVkTerminalsGpuMode({ homeDir }, 'darwin'), 'default');
    });
  });
});

test('getVkTerminalsGpuMode: VK Terminals 本体 config.json の gpu を採用する', () => {
  withoutGpuEnv(() => {
    withTmpDir('vko-vk-terminals-home-', (homeDir) => {
      const configDir = join(homeDir, '.vk-terminals');
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, 'config.json');

      writeFileSync(configPath, JSON.stringify({ gpu: 'off' }));
      assert.equal(getVkTerminalsGpuMode({ homeDir }, 'darwin'), 'off');

      // 大文字・前後空白は正規化する
      writeFileSync(configPath, JSON.stringify({ gpu: '  Default ' }));
      assert.equal(getVkTerminalsGpuMode({ configPath }, 'linux'), 'default');
    });
  });
});

test('getVkTerminalsGpuMode: null / 空文字はプラットフォーム既定にフォールバックする', () => {
  withoutGpuEnv(() => {
    withTmpDir('vko-vk-terminals-home-', (homeDir) => {
      const configDir = join(homeDir, '.vk-terminals');
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, 'config.json');

      writeFileSync(configPath, JSON.stringify({ gpu: null }));
      assert.equal(getVkTerminalsGpuMode({ homeDir }, 'linux'), 'off');

      writeFileSync(configPath, JSON.stringify({ gpu: '' }));
      assert.equal(getVkTerminalsGpuMode({ homeDir }, 'darwin'), 'default');
    });
  });
});

test('getVkTerminalsGpuMode: 未知の値は warn して既定にフォールバックする', () => {
  withoutGpuEnv(() => {
    withTmpDir('vko-vk-terminals-home-', (homeDir) => {
      const configDir = join(homeDir, '.vk-terminals');
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, 'config.json');
      writeFileSync(configPath, JSON.stringify({ gpu: 'turbo' }));

      const savedWarn = console.warn;
      const warnings = [];
      try {
        console.warn = (message) => warnings.push(message);
        assert.equal(getVkTerminalsGpuMode({ homeDir }, 'linux'), 'off');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /未知の GPU モード "turbo"/);
      } finally {
        console.warn = savedWarn;
      }
    });
  });
});

test('getVkTerminalsGpuMode: env VK_TERMINALS_GPU が config.json より優先される', () => {
  withoutGpuEnv(() => {
    withTmpDir('vko-vk-terminals-home-', (homeDir) => {
      const configDir = join(homeDir, '.vk-terminals');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ gpu: 'off' }));
      process.env.VK_TERMINALS_GPU = 'default';
      assert.equal(getVkTerminalsGpuMode({ homeDir }, 'linux'), 'default');
    });
  });
});

test('getVkTerminalsGpuMode: config 読み込み失敗時は warn して既定にフォールバックする', () => {
  withoutGpuEnv(() => {
    withTmpDir('vko-vk-terminals-home-', (homeDir) => {
      const configDir = join(homeDir, '.vk-terminals');
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, 'config.json');
      writeFileSync(configPath, '{');

      const savedWarn = console.warn;
      const warnings = [];
      try {
        console.warn = (message) => warnings.push(message);
        assert.equal(getVkTerminalsGpuMode({ homeDir }, 'linux'), 'off');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /既定 GPU モード "off"/);
      } finally {
        console.warn = savedWarn;
      }
    });
  });
});

test('gpuLaunchOptions: off は GPU 無効フラグを返し追加 env は無し', () => {
  const { args, env } = gpuLaunchOptions('off');
  assert.deepEqual(args, ['--disable-gpu', '--disable-software-rasterizer']);
  assert.deepEqual(env, {});
});

test('gpuLaunchOptions: default はフラグ・env とも空（Chromium 任せ）', () => {
  const { args, env } = gpuLaunchOptions('default');
  assert.deepEqual(args, []);
  assert.deepEqual(env, {});
});

test('GPU_MODES: 取りうる値の一覧（off / default の2択）', () => {
  assert.deepEqual(GPU_MODES, ['off', 'default']);
});

test('buildSettingsDescriptor: VK Terminals スキーマ由来の GPU モードピッカーが本体設定グループにある', () => {
  withVkTerminalsSchema(vkTerminalsSchemaFixture(), (vkTerminalsDir) => {
    const desc = buildSettingsDescriptor('/tmp/config.json', { vkTerminalsDir });
    const gpuField = desc.groups
      .flatMap((g) => g.fields ?? [])
      .find((f) => f.key === 'gpu');
    assert.ok(gpuField);
    assert.equal(gpuField.type, 'select');
    const optionValues = (gpuField.options ?? []).map((o) => o.value);
    assert.deepEqual(optionValues, ['', 'off']);
    for (const v of optionValues) {
      if (v !== '') assert.ok(GPU_MODES.includes(v), `未知のモード: ${v}`);
    }
  });
});
