/**
 * doctor（初回セットアップ充足判定）のユニットテスト。
 * - モード別（queue.backend / terminals.mode）の required 切り替え
 * - owner → org.allowed_owners のプリフィル判定
 * - 全充足／一部欠損時の要約（summarizeDoctor）
 * - gh auth token の有無（フェイク execFileSync）
 * - マニフェスト有無（vk-agents 展開判定）
 *
 * 実 fs の一時ディレクトリ（mkdtempSync）＋ DI でテストする（tests/config.test.js の雛形）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { runDoctor, summarizeDoctor, formatDoctorReport } from '../src/doctor.js';

const BIN_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'vk-orchestrator.js');

// テスト環境を丸ごと注入するためのヘルパ。
// homeDir 配下に config（A）・canonical（C）・manifest を任意で用意し、
// gh 認証 / VK Terminals 導入 / tmux 導入 / Claude Code 導入 / platform / node を明示注入する。
function withDoctorEnv(
  {
    config = {},
    queueBackend,
    terminalsMode,
    allowedOwners,
    hasManifest = true,
    ghAuthenticated = true,
    vkTerminalsInstalled = true,
    tmuxInstalled = true,
    claudeInstalled = true,
    platform = 'darwin',
    nodeVersion = '20.11.0',
  } = {},
  fn,
) {
  const dir = mkdtempSync(join(tmpdir(), 'vko-doctor-'));
  // resolveTerminalsMode は env VK_TERMINALS_MODE を config より優先するため、
  // 実行環境の env でテストがぶれないよう退避して外す（finally で復元）。
  const savedTerminalsModeEnv = process.env.VK_TERMINALS_MODE;
  delete process.env.VK_TERMINALS_MODE;
  // resolveTmuxClaudeCommand も env VK_TMUX_CLAUDE_CMD を config より優先するため同様に外す。
  const savedTmuxClaudeCmdEnv = process.env.VK_TMUX_CLAUDE_CMD;
  delete process.env.VK_TMUX_CLAUDE_CMD;
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));

    const canonicalConfigPath = join(dir, '.vk-agents', 'config.json');
    if (allowedOwners !== undefined) {
      mkdirSync(dirname(canonicalConfigPath), { recursive: true });
      writeFileSync(canonicalConfigPath, JSON.stringify({ org: { allowed_owners: allowedOwners } }));
    }

    const manifestPath = join(dir, '.claude', 'skills', '.agent-skills-manifest');
    if (hasManifest) {
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, 'vk-kore\n');
    }

    const options = {
      homeDir: dir,
      configPath,
      queueBackend,
      terminalsMode,
      manifestPath,
      canonicalConfigPath,
      platform,
      nodeVersion,
      execFileSync: () => {
        if (!ghAuthenticated) throw new Error('gh not authenticated');
        return 'gho_faketoken\n';
      },
      resolveVkTerminalsDir: () => {
        if (!vkTerminalsInstalled) throw new Error('vk-terminals not installed');
        return join(dir, 'node_modules', 'vk-terminals');
      },
      // gh 認証用の execFileSync とは別フック（引数を見ないフェイクで「常に導入済み」に倒れないように）。
      resolveTmuxVersion: () => {
        if (!tmuxInstalled) throw new Error('tmux not found');
        return 'tmux 3.4';
      },
      // claude も tmux と同じく専用フックにする。実 PATH の claude を見に行くと
      // 「開発マシンには入っているのでテストが通る」状態になり、未導入環境の検知を検証できない。
      resolveClaudeVersion: () => {
        if (!claudeInstalled) throw new Error('claude not found');
        return '2.0.14 (Claude Code)';
      },
    };
    return fn(options);
  } finally {
    if (savedTerminalsModeEnv === undefined) delete process.env.VK_TERMINALS_MODE;
    else process.env.VK_TERMINALS_MODE = savedTerminalsModeEnv;
    if (savedTmuxClaudeCmdEnv === undefined) delete process.env.VK_TMUX_CLAUDE_CMD;
    else process.env.VK_TMUX_CLAUDE_CMD = savedTmuxClaudeCmdEnv;
    rmSync(dir, { recursive: true, force: true });
  }
}

function byId(requirements, id) {
  const r = requirements.find((x) => x.id === id);
  assert.ok(r, `要件 ${id} が存在すること`);
  return r;
}

test('runDoctor: ローカルモードでは gh 認証・github.owner・repo・assigneeFilter は任意になる', () => {
  withDoctorEnv({ queueBackend: 'local', ghAuthenticated: false, allowedOwners: ['vektor-inc'] }, (options) => {
    const reqs = runDoctor(options);
    assert.equal(byId(reqs, 'gh-auth').required, false);
    assert.equal(byId(reqs, 'github.owner').required, false);
    assert.equal(byId(reqs, 'github.repo').required, false);
    assert.equal(byId(reqs, 'orchestrator.assigneeFilter').required, false);
    // 前提とモード・allowed_owners は両モードで必須。
    assert.equal(byId(reqs, 'node').required, true);
    assert.equal(byId(reqs, 'platform').required, true);
    assert.equal(byId(reqs, 'vk-terminals').required, true);
    assert.equal(byId(reqs, 'vk-agents-setup').required, true);
    assert.equal(byId(reqs, 'queue.backend').required, true);
    assert.equal(byId(reqs, 'org.allowed_owners').required, true);
  });
});

test('runDoctor: GitHub モードでは gh 認証・owner・repo・assigneeFilter・allowed_owners が必須になる', () => {
  withDoctorEnv({ queueBackend: 'github', allowedOwners: ['vektor-inc'] }, (options) => {
    const reqs = runDoctor(options);
    assert.equal(byId(reqs, 'gh-auth').required, true);
    assert.equal(byId(reqs, 'github.owner').required, true);
    assert.equal(byId(reqs, 'github.repo').required, true);
    assert.equal(byId(reqs, 'orchestrator.assigneeFilter').required, true);
    assert.equal(byId(reqs, 'org.allowed_owners').required, true);
  });
});

test('runDoctor: queue.backend を options ではなく config から解決する', () => {
  withDoctorEnv({ config: { queue: { backend: 'github' } }, allowedOwners: ['vektor-inc'] }, (options) => {
    // queueBackend を明示注入しない（config から読む）。
    delete options.queueBackend;
    const reqs = runDoctor(options);
    assert.equal(byId(reqs, 'queue.backend').current, 'GitHub');
    assert.equal(byId(reqs, 'gh-auth').required, true);
  });
});

test('runDoctor: gh 未認証は gh-auth を ok=false にする（GitHub モード）', () => {
  withDoctorEnv({ queueBackend: 'github', ghAuthenticated: false, allowedOwners: ['vektor-inc'] }, (options) => {
    const reqs = runDoctor(options);
    const gh = byId(reqs, 'gh-auth');
    assert.equal(gh.ok, false);
    assert.equal(gh.required, true);
  });
});

test('runDoctor: gh 認証済みは gh-auth を ok=true にする', () => {
  withDoctorEnv({ queueBackend: 'github', ghAuthenticated: true, allowedOwners: ['vektor-inc'] }, (options) => {
    assert.equal(byId(runDoctor(options), 'gh-auth').ok, true);
  });
});

test('runDoctor: マニフェスト有無で vk-agents-setup の ok が変わる', () => {
  withDoctorEnv({ hasManifest: false, allowedOwners: ['vektor-inc'] }, (options) => {
    assert.equal(byId(runDoctor(options), 'vk-agents-setup').ok, false);
  });
  withDoctorEnv({ hasManifest: true, allowedOwners: ['vektor-inc'] }, (options) => {
    assert.equal(byId(runDoctor(options), 'vk-agents-setup').ok, true);
  });
});

test('runDoctor: VK Terminals 未導入は vk-terminals を ok=false にする', () => {
  withDoctorEnv({ vkTerminalsInstalled: false, allowedOwners: ['vektor-inc'] }, (options) => {
    assert.equal(byId(runDoctor(options), 'vk-terminals').ok, false);
  });
});

test('runDoctor: vk-terminals モード（既定）では VK Terminals 必須・tmux 要件は出ない', () => {
  withDoctorEnv({ terminalsMode: 'vk-terminals', allowedOwners: ['vektor-inc'] }, (options) => {
    const reqs = runDoctor(options);
    assert.equal(byId(reqs, 'vk-terminals').required, true);
    assert.equal(
      reqs.find((r) => r.id === 'tmux'),
      undefined,
      'vk-terminals モードでは tmux 要件の行を出さないこと',
    );
    // プラットフォームは GUI 前提の文言のまま。
    assert.match(byId(reqs, 'platform').label, /WSL2/);
    assert.equal(byId(reqs, 'terminals.mode').current, 'vk-terminals（既定）');
    assert.equal(byId(reqs, 'terminals.mode').ok, true);
    assert.equal(byId(reqs, 'terminals.mode').required, true);
  });
});

test('runDoctor: tmux モードでは VK Terminals は任意・tmux 要件が必須になる', () => {
  withDoctorEnv({ terminalsMode: 'tmux', allowedOwners: ['vektor-inc'] }, (options) => {
    const reqs = runDoctor(options);
    assert.equal(byId(reqs, 'vk-terminals').required, false);
    assert.match(byId(reqs, 'vk-terminals').hint, /tmux モードでは VK Terminals/);
    const tmux = byId(reqs, 'tmux');
    assert.equal(tmux.required, true);
    assert.equal(tmux.ok, true);
    assert.equal(tmux.current, 'tmux 3.4');
    assert.match(tmux.hint, /brew install tmux/);
    // プラットフォームは GUI 非依存の文言に差し替わる。
    const platformReq = byId(reqs, 'platform');
    assert.match(platformReq.label, /macOS \/ Linux/);
    assert.match(platformReq.hint, /GUI を起動しない/);
    assert.equal(byId(reqs, 'terminals.mode').current, 'tmux');
    // group が飛び地にならない（formatDoctorReport の見出しが重複しない）こと。
    const groups = reqs.map((r) => r.group);
    const uniqueRuns = groups.filter((g, i) => g !== groups[i - 1]);
    assert.equal(uniqueRuns.length, new Set(groups).size, 'same group must be contiguous');
  });
});

test('runDoctor: tmux モードで tmux 未導入は必須欠損になる', () => {
  withDoctorEnv({ terminalsMode: 'tmux', tmuxInstalled: false, allowedOwners: ['vektor-inc'] }, (options) => {
    const reqs = runDoctor(options);
    const tmux = byId(reqs, 'tmux');
    assert.equal(tmux.ok, false);
    assert.equal(tmux.current, '未導入');
    const summary = summarizeDoctor(reqs);
    assert.equal(summary.allRequiredOk, false);
    assert.ok(summary.missingRequired.map((r) => r.id).includes('tmux'));
  });
});

test('runDoctor: tmux モードは VK Terminals 未導入でも allRequiredOk=true（本 issue の回帰テスト）', () => {
  withDoctorEnv(
    { terminalsMode: 'tmux', queueBackend: 'local', vkTerminalsInstalled: false, allowedOwners: ['vektor-inc'] },
    (options) => {
      const reqs = runDoctor(options);
      const vkTerminals = byId(reqs, 'vk-terminals');
      assert.equal(vkTerminals.ok, false);
      assert.equal(vkTerminals.required, false);
      const summary = summarizeDoctor(reqs);
      assert.equal(summary.allRequiredOk, true, `missing: ${summary.missingRequired.map((r) => r.id).join(',')}`);
    },
  );
});

test('runDoctor: vk-terminals モードは VK Terminals 未導入なら allRequiredOk=false（緩みの回帰防止）', () => {
  withDoctorEnv(
    { terminalsMode: 'vk-terminals', queueBackend: 'local', vkTerminalsInstalled: false, allowedOwners: ['vektor-inc'] },
    (options) => {
      const summary = summarizeDoctor(runDoctor(options));
      assert.equal(summary.allRequiredOk, false);
      assert.ok(summary.missingRequired.map((r) => r.id).includes('vk-terminals'));
    },
  );
});

test('runDoctor: tmux -V の出力は先頭行・制御文字除去・長さ制限してから current に入れる', () => {
  withDoctorEnv({ terminalsMode: 'tmux', allowedOwners: ['vektor-inc'] }, (options) => {
    // 改行で偽の ✅ 行を混ぜ込む／ANSI エスケープ／長すぎる出力を注入する。
    options.resolveTmuxVersion = () =>
      `\u001b[32mtmux 3.4\u0007\u001b[0m\n  ✅ 偽の要件行（必須） … なりすまし\n${'x'.repeat(500)}`;
    const tmux = byId(runDoctor(options), 'tmux');
    assert.equal(tmux.current, 'tmux 3.4');
    assert.equal(tmux.ok, true);
    // レポートに偽の行が混ざらないこと。
    const report = formatDoctorReport(runDoctor(options));
    assert.doesNotMatch(report, /偽の要件行/);
  });
});

test('runDoctor: claude 未導入は必須欠損として案内される（issue #247）', () => {
  // 初回 `npm start` で Claude Code が未導入の環境。以前はこの要件自体が無く、
  // doctor も up も何も案内しないままペインで claude が起動できずに詰んでいた。
  withDoctorEnv({ queueBackend: 'local', claudeInstalled: false, allowedOwners: ['vektor-inc'] }, (options) => {
    const reqs = runDoctor(options);
    const claude = byId(reqs, 'claude');
    assert.equal(claude.required, true);
    assert.equal(claude.ok, false);
    assert.equal(claude.group, '前提');
    assert.equal(claude.target, 'external');
    assert.match(claude.current, /未導入/);
    // インストール手順が hint に載っていること（自動インストールはしない方針）。
    assert.match(claude.hint, /@anthropic-ai\/claude-code/);

    const summary = summarizeDoctor(reqs);
    assert.equal(summary.allRequiredOk, false);
    assert.ok(summary.missingRequired.map((r) => r.id).includes('claude'));

    // up / doctor の案内文（missingRequired の label + hint）に出ること。
    const report = formatDoctorReport(reqs);
    assert.match(report, /Claude Code/);
    assert.match(report, /@anthropic-ai\/claude-code/);
  });
});

test('runDoctor: claude 導入済みは ok=true・current にバージョンを出す', () => {
  withDoctorEnv({ queueBackend: 'local', claudeInstalled: true, allowedOwners: ['vektor-inc'] }, (options) => {
    const reqs = runDoctor(options);
    const claude = byId(reqs, 'claude');
    assert.equal(claude.ok, true);
    assert.equal(claude.current, '2.0.14 (Claude Code)');
    assert.equal(summarizeDoctor(reqs).allRequiredOk, true);
  });
});

test('runDoctor: vk-terminals モードでは素の claude を検査対象にする', () => {
  // vk-terminals モードのペイン起動は VK Terminals 側が素の claude を叩くため、
  // tmux.claudeCommand の指定があっても検査対象は 'claude' のまま。
  withDoctorEnv(
    {
      terminalsMode: 'vk-terminals',
      config: { tmux: { claudeCommand: 'my-claude --dangerously-skip-permissions' } },
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      const checked = [];
      options.resolveClaudeVersion = (command) => {
        checked.push(command);
        return '2.0.14 (Claude Code)';
      };
      assert.equal(byId(runDoctor(options), 'claude').ok, true);
      assert.deepEqual(checked, ['claude']);
    },
  );
});

test('runDoctor: tmux モードは tmux.claudeCommand の先頭トークンを検査対象にする', () => {
  // 独自コマンド運用（bypass 用の引数付きなど）で「素の claude が無い」と誤検知しないこと。
  // 設定値は任意文字列なので、シェルへ渡さず実行ファイル名（先頭トークン）だけを検査する。
  withDoctorEnv(
    {
      terminalsMode: 'tmux',
      config: { tmux: { claudeCommand: 'my-claude --dangerously-skip-permissions' } },
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      const checked = [];
      options.resolveClaudeVersion = (command) => {
        checked.push(command);
        return '2.0.14 (Claude Code)';
      };
      const claude = byId(runDoctor(options), 'claude');
      assert.equal(claude.ok, true);
      assert.deepEqual(checked, ['my-claude'], '引数を落とした実行ファイル名だけを検査すること');
      // 独自コマンド利用者が原因に気づけるよう、hint に設定キーと現在値を出す。
      assert.match(claude.hint, /tmux\.claudeCommand/);
      assert.match(claude.hint, /my-claude/);
      // 成功時も検査対象を出す（自分の設定が見られているか確認できるようにする）。
      assert.match(claude.current, /コマンド: my-claude/);
    },
  );
});

test('runDoctor: 64 文字を超える絶対パスを切り詰めずに検査対象へ渡す', () => {
  // 表示用サニタイズ（64 文字で切り詰め）を実行対象に流用すると、fnm / volta 配下の
  // claude の絶対パスが途中で切れて別の実体を指す。「tmux サーバーの PATH に claude が
  // 無いから絶対パスを書く」は典型的な設定動機なので、正しく設定できている人ほど
  // 誤検知される。実行に渡す値は切り詰めないこと。
  const longPath = '/Users/someuser/.local/share/fnm/node-versions/v20.11.0/installation/bin/claude';
  assert.ok(longPath.length > 64, '前提: 検証には 64 文字超のパスを使う');
  withDoctorEnv(
    { terminalsMode: 'tmux', config: { tmux: { claudeCommand: `${longPath} --dangerously-skip-permissions` } }, allowedOwners: ['vektor-inc'] },
    (options) => {
      const checked = [];
      options.resolveClaudeVersion = (command) => {
        checked.push(command);
        return '2.0.14 (Claude Code)';
      };
      assert.equal(byId(runDoctor(options), 'claude').ok, true);
      assert.deepEqual(checked, [longPath]);
    },
  );
});

test('runDoctor: 長い検査対象コマンドは実行には全長を渡し、レポートには有界な値だけ出す', () => {
  // 実行側（切り詰めない）と表示側（切り詰める）の両方向を 1 本でロックする。
  // 表示を生の値に戻しても、実行を切り詰めた値に戻しても、どちらでも落ちること。
  const longPath = `/opt/${'a'.repeat(200)}/claude`;
  withDoctorEnv(
    { terminalsMode: 'tmux', config: { tmux: { claudeCommand: longPath } }, allowedOwners: ['vektor-inc'] },
    (options) => {
      const checked = [];
      options.resolveClaudeVersion = (command) => {
        checked.push(command);
        throw new Error('claude not found');
      };
      const claude = byId(runDoctor(options), 'claude');
      // 実行対象は全長のまま（途中で切れたパスは別の実体を指す）。
      assert.deepEqual(checked, [longPath]);
      // 表示は有界。レポート 1 行が設定値の長さで無制限に伸びないこと。
      assert.ok(!claude.current.includes(longPath), 'current に全長を出さないこと');
      assert.ok(
        claude.current.length <= 100,
        `current が有界であること（実際: ${claude.current.length} 文字）`,
      );
    },
  );
});

test('runDoctor: tmux モードで独自 claude コマンドが未導入なら ok=false・current に対象名を出す', () => {
  withDoctorEnv(
    { terminalsMode: 'tmux', config: { tmux: { claudeCommand: 'my-claude' } }, claudeInstalled: false, allowedOwners: ['vektor-inc'] },
    (options) => {
      const claude = byId(runDoctor(options), 'claude');
      assert.equal(claude.ok, false);
      assert.equal(claude.current, '未導入（コマンド: my-claude）');
      // 独自コマンドが見つからないときに「npm install …」を先頭に置くと、それを実行しても
      // 生えるのは claude で設定した独自コマンドは直らない。一番効く行動を先に出すこと。
      assert.match(claude.hint, /^ペイン起動に使うコマンド "my-claude" が見つかりません。/);
    },
  );
});

test('runDoctor: 既定コマンドのときは hint に tmux.claudeCommand の説明を出さない', () => {
  // 独自コマンドを使っていない大多数に設定キーの説明を出すのは冗長なので、
  // 検査対象が既定 claude かどうかで hint 自体を分ける。
  for (const terminalsMode of ['vk-terminals', 'tmux']) {
    withDoctorEnv({ terminalsMode, claudeInstalled: false, allowedOwners: ['vektor-inc'] }, (options) => {
      const claude = byId(runDoctor(options), 'claude');
      assert.equal(claude.current, '未導入（コマンド: claude）');
      // 独自コマンド分岐と同じ「何が見つからないか → 打つ手」の型で始めること。
      assert.match(claude.hint, /^`claude` コマンドが見つかりません。/);
      assert.doesNotMatch(claude.hint, /tmux\.claudeCommand/);
      // 「入れたのに見つからない（PATH 未反映）」は最頻の詰まりどころなので両モードで案内する。
      assert.match(claude.hint, /claude --version/);
      assert.match(claude.hint, /シェルを開き直して/);
    });
  }
});

test('runDoctor: claude 導入済み・既定コマンドなら current にコマンド名を添えない', () => {
  withDoctorEnv({ terminalsMode: 'tmux', allowedOwners: ['vektor-inc'] }, (options) => {
    assert.equal(byId(runDoctor(options), 'claude').current, '2.0.14 (Claude Code)');
  });
});

test('formatDoctorReport: claude 未充足なら /vk-orchestrator-setup ではなく先に導入を促す（詰みループ回避）', () => {
  // Claude Code が無いから ❌ が出ている人に「Claude Code で開いて /vk-orchestrator-setup」と
  // 案内すると実行不可能で、この機能が救おうとしている当事者が二度目の壁にぶつかる。
  withDoctorEnv({ queueBackend: 'local', claudeInstalled: false, allowedOwners: ['vektor-inc'] }, (options) => {
    const report = formatDoctorReport(runDoctor(options));
    assert.match(report, /まず Claude Code をインストールしてください/);
    assert.match(report, /導入後、Claude Code でこのリポジトリを開き/);
  });
});

test('formatDoctorReport: 独自コマンドが見つからない場合はインストールを勧めない', () => {
  // 独自コマンド（cly 等）が無いだけなら Claude Code 自体は入っていることが多く、
  // インストールを勧めても解決しない。締めでも hint と同じ優先順位を守る。
  withDoctorEnv(
    { terminalsMode: 'tmux', queueBackend: 'local', config: { tmux: { claudeCommand: 'cly' } }, claudeInstalled: false, allowedOwners: ['vektor-inc'] },
    (options) => {
      const report = formatDoctorReport(runDoctor(options));
      assert.doesNotMatch(report, /まず Claude Code をインストールしてください/);
      assert.match(report, /まず上記の「Claude Code コマンド導入」を解消してください/);
    },
  );
});

test('formatDoctorReport: claude が充足していれば従来どおり /vk-orchestrator-setup へ誘導する', () => {
  withDoctorEnv({ queueBackend: 'github', config: {}, ghAuthenticated: false, claudeInstalled: true }, (options) => {
    const report = formatDoctorReport(runDoctor(options));
    assert.doesNotMatch(report, /まず Claude Code をインストールしてください/);
    assert.match(report, /Claude Code でこのリポジトリを開き `\/vk-orchestrator-setup` を実行すると/);
  });
});

test('runDoctor: claude --version の出力は先頭行・制御文字除去・長さ制限してから current に入れる', () => {
  withDoctorEnv({ queueBackend: 'local', allowedOwners: ['vektor-inc'] }, (options) => {
    // 改行で偽の ✅ 行を混ぜ込む／ANSI エスケープ／長すぎる出力を注入する。
    options.resolveClaudeVersion = () =>
      `\u001b[32m2.0.14 (Claude Code)\u0007\u001b[0m\n  ✅ 偽の要件行（必須） … なりすまし\n${'x'.repeat(500)}`;
    const claude = byId(runDoctor(options), 'claude');
    assert.equal(claude.current, '2.0.14 (Claude Code)');
    assert.equal(claude.ok, true);
    // レポートに偽の行が混ざらないこと。
    assert.doesNotMatch(formatDoctorReport(runDoctor(options)), /偽の要件行/);
  });
});

test('runDoctor: tmux.claudeCommand が制御文字入りでもレポート行を壊さない', () => {
  // 設定値は current / hint に出るため、そこから偽の要件行を混ぜ込めないこと。
  // 実際にここを守っているのは先頭トークン抽出（split(/\s+/)）で、改行以降は
  // その時点で落ちる。制御文字の除去はそれをすり抜ける値への多層防御。
  withDoctorEnv(
    {
      terminalsMode: 'tmux',
      config: { tmux: { claudeCommand: 'my-claude\n  ✅ 偽の要件行（必須） … なりすまし' } },
      claudeInstalled: false,
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      const reqs = runDoctor(options);
      assert.equal(byId(reqs, 'claude').ok, false);
      assert.doesNotMatch(formatDoctorReport(reqs), /偽の要件行/);
    },
  );
});

test('runDoctor: terminals.mode を options ではなく config から解決する', () => {
  withDoctorEnv({ config: { terminals: { mode: 'tmux' } }, allowedOwners: ['vektor-inc'] }, (options) => {
    // terminalsMode を明示注入しない（config から読む。env はヘルパ側で外している）。
    delete options.terminalsMode;
    const reqs = runDoctor(options);
    assert.equal(byId(reqs, 'terminals.mode').current, 'tmux');
    assert.equal(byId(reqs, 'vk-terminals').required, false);
    assert.equal(byId(reqs, 'tmux').required, true);
  });
});

test('runDoctor: Node 20 未満・非対応プラットフォームは ok=false になる', () => {
  withDoctorEnv({ nodeVersion: '18.20.0', platform: 'win32', allowedOwners: ['vektor-inc'] }, (options) => {
    const reqs = runDoctor(options);
    assert.equal(byId(reqs, 'node').ok, false);
    assert.equal(byId(reqs, 'platform').ok, false);
  });
});

test('runDoctor: github.owner 未設定は ok=false・既定 vektor-inc を表示する', () => {
  withDoctorEnv({ queueBackend: 'github', config: {}, allowedOwners: ['vektor-inc'] }, (options) => {
    const owner = byId(runDoctor(options), 'github.owner');
    assert.equal(owner.ok, false);
    assert.match(owner.current, /vektor-inc/);
  });
});

test('runDoctor: github.owner を設定すると ok=true になる', () => {
  withDoctorEnv({ queueBackend: 'github', config: { github: { owner: 'acme' } }, allowedOwners: ['acme'] }, (options) => {
    const owner = byId(runDoctor(options), 'github.owner');
    assert.equal(owner.ok, true);
    assert.equal(owner.current, 'acme');
  });
});

test('runDoctor: owner が allowed_owners に含まれれば ok=true（プリフィル済み想定）', () => {
  withDoctorEnv({ config: { github: { owner: 'acme' } }, allowedOwners: ['acme'] }, (options) => {
    assert.equal(byId(runDoctor(options), 'org.allowed_owners').ok, true);
  });
});

test('runDoctor: owner が allowed_owners に含まれなければ ok=false', () => {
  withDoctorEnv({ config: { github: { owner: 'acme' } }, allowedOwners: ['vektor-inc'] }, (options) => {
    const owners = byId(runDoctor(options), 'org.allowed_owners');
    assert.equal(owners.ok, false);
    assert.match(owners.label, /acme/);
  });
});

test('runDoctor: canonical config が無い（allowed_owners 未設定）と ok=false・current 未設定', () => {
  withDoctorEnv({ config: { github: { owner: 'acme' } } }, (options) => {
    const owners = byId(runDoctor(options), 'org.allowed_owners');
    assert.equal(owners.ok, false);
    assert.equal(owners.current, '（未設定）');
  });
});

test('runDoctor: 既定 owner(vektor-inc) は allowed_owners=[vektor-inc] で ok=true', () => {
  withDoctorEnv({ config: {}, allowedOwners: ['vektor-inc'] }, (options) => {
    assert.equal(byId(runDoctor(options), 'org.allowed_owners').ok, true);
  });
});

test('runDoctor: assigneeFilter は空だと ok=false、値があると ok=true', () => {
  withDoctorEnv({ queueBackend: 'github', config: {}, allowedOwners: ['vektor-inc'] }, (options) => {
    assert.equal(byId(runDoctor(options), 'orchestrator.assigneeFilter').ok, false);
  });
  withDoctorEnv({ queueBackend: 'github', config: { orchestrator: { assigneeFilter: 'all' } }, allowedOwners: ['vektor-inc'] }, (options) => {
    const af = byId(runDoctor(options), 'orchestrator.assigneeFilter');
    assert.equal(af.ok, true);
    assert.equal(af.current, 'all');
  });
});

test('summarizeDoctor: 全 required 充足で allRequiredOk=true（ローカルモード最小構成）', () => {
  withDoctorEnv({ queueBackend: 'local', config: {}, allowedOwners: ['vektor-inc'] }, (options) => {
    const summary = summarizeDoctor(runDoctor(options));
    assert.equal(summary.allRequiredOk, true);
    assert.equal(summary.missingRequired.length, 0);
  });
});

test('summarizeDoctor: 必須欠損があると allRequiredOk=false・missingRequired に列挙する', () => {
  withDoctorEnv({ queueBackend: 'github', config: {}, ghAuthenticated: false }, (options) => {
    const summary = summarizeDoctor(runDoctor(options));
    assert.equal(summary.allRequiredOk, false);
    const ids = summary.missingRequired.map((r) => r.id);
    // github モードで owner 未設定・gh 未認証・assigneeFilter 未設定・allowed_owners 未設定が欠損。
    assert.ok(ids.includes('gh-auth'));
    assert.ok(ids.includes('github.owner'));
    assert.ok(ids.includes('orchestrator.assigneeFilter'));
    assert.ok(ids.includes('org.allowed_owners'));
  });
});

test('summarizeDoctor: モードで required 集合が変わり要約カウントに反映される', () => {
  const localSummary = withDoctorEnv(
    { queueBackend: 'local', config: {}, allowedOwners: ['vektor-inc'] },
    (options) => summarizeDoctor(runDoctor(options)),
  );
  const githubSummary = withDoctorEnv(
    { queueBackend: 'github', config: {}, allowedOwners: ['vektor-inc'] },
    (options) => summarizeDoctor(runDoctor(options)),
  );
  // GitHub モードのほうが required 件数が多い（gh/owner/repo/assigneeFilter が加わる）。
  assert.ok(githubSummary.requiredCount > localSummary.requiredCount);
});

test('formatDoctorReport: 充足時は up 案内、欠損時は /vk-orchestrator-setup 案内を含む', () => {
  withDoctorEnv({ queueBackend: 'local', config: {}, allowedOwners: ['vektor-inc'] }, (options) => {
    const report = formatDoctorReport(runDoctor(options));
    assert.match(report, /vk-orchestrator up/);
    assert.match(report, /✅/);
  });
  withDoctorEnv({ queueBackend: 'github', config: {}, ghAuthenticated: false }, (options) => {
    const report = formatDoctorReport(runDoctor(options));
    assert.match(report, /vk-orchestrator-setup/);
    assert.match(report, /❌/);
  });
});

test('runDoctor: 壊れた config.json（不正 JSON）では例外を投げる（bin 側で友好的に扱う前提）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-doctor-broken-'));
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, '{ broken json');
    // config を注入せず configPath だけ渡すと、内部の loadUnifiedConfig が不正 JSON で throw する。
    assert.throws(() => runDoctor({ configPath }), /読み込みに失敗/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bin doctor: 壊れた config でも生クラッシュせず友好的メッセージで終了する（人間可読）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-doctor-cli-'));
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, '{ broken json');
    const result = spawnSync(process.execPath, [BIN_PATH, 'doctor'], {
      encoding: 'utf8',
      env: { ...process.env, VK_ORCHESTRATOR_CONFIG: configPath },
    });
    // 生スタックで落ちない（診断コマンドは exit 0）。
    assert.equal(result.status, 0);
    const out = `${result.stdout}\n${result.stderr}`;
    assert.match(out, /\[doctor\] 設定の読み込みに失敗しました/);
    // 生の Node スタック（"at loadUnifiedConfig ..."）を握りつぶしていること。
    assert.doesNotMatch(out, /^\s*at loadUnifiedConfig/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bin doctor --json: 壊れた config でも生クラッシュせず stdout を汚さない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-doctor-cli-json-'));
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, '{ broken json');
    const result = spawnSync(process.execPath, [BIN_PATH, 'doctor', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, VK_ORCHESTRATOR_CONFIG: configPath },
    });
    assert.equal(result.status, 0);
    // stdout には要件配列を出さない（部分的な壊れた JSON を吐かない）。エラーは stderr に JSON で。
    assert.equal(result.stdout.trim(), '');
    assert.match(result.stderr, /"hint"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
