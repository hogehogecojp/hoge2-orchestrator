#!/usr/bin/env node
// VK Orchestrator CLI エントリ。
//
// これまで task-queue の `npm start` / `run-once` / check-status.mjs / unblock.mjs に
// 分かれていた入口を 1 つの CLI に統合する。サブコマンド:
//
//   vk-orchestrator start [--once] [--assignee <login>]
//   vk-orchestrator check-status
//   vk-orchestrator unblock <issue-number>
//   vk-orchestrator task add|list|set-status ...
//
// dotenv の読み込みはここで最初に行い、以降のモジュールは src/config.js 経由で設定を取得する。

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { formatErrorSummary } from '../src/engine/format-error.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// リポジトリ直下の .env を読む（bin/ の一つ上）。
// 依存未インストール（npm install 前）でもヘルプ表示は動くよう、読み込み失敗は握りつぶす。
try {
  const { config: loadDotenv } = await import('dotenv');
  loadDotenv({ path: resolve(__dirname, '..', '.env') });
} catch {
  // dotenv 未インストール時は環境変数をそのまま使う。
}

// 統合設定(config.json)を読み込み、env に反映する（env > config.json > 既定）。
// config.js は Node 標準モジュールのみに依存するため npm install 前でも安全。
const [, , sub] = process.argv;

const {
  loadUnifiedConfig,
  applyConfigToEnv,
  ensureGitHubToken,
  migrateLegacyOrchestratorConfig,
  migrateLegacyVkAgentsGuiKeys,
} = await import('../src/config.js');
migrateLegacyOrchestratorConfig();
migrateLegacyVkAgentsGuiKeys();

// 統合設定の読み込み・env 反映は、config.json の不正 JSON などで例外を投げうる。
// doctor は「設定が壊れている人を助ける」診断ツールなので、ここで生スタックで落とさず、
// doctor case（下の try/catch）に委ねて分かりやすいメッセージへ変換させる。
// update も同じ扱いにする。設定が壊れている状態を直す手段が「新しい版に入れ替える」こと
// なのに、その入れ替え自体が設定の破損で止まってしまうと詰んでしまうため、既定値で続行する。
// それ以外のサブコマンドは有効な設定が前提のため、従来どおり要約を出して終了する
// （main の catch と同じ formatErrorSummary で、生スタックは見せない）。
const CONFIG_ERROR_TOLERANT_SUBCOMMANDS = new Set(['doctor', 'update']);
let unifiedConfig = {};
try {
  unifiedConfig = loadUnifiedConfig();
  applyConfigToEnv(unifiedConfig);
  ensureGitHubToken();
} catch (err) {
  if (!CONFIG_ERROR_TOLERANT_SUBCOMMANDS.has(sub)) {
    console.error(formatErrorSummary(err));
    process.exit(1);
  }
  // doctor はフォールスルー：runDoctor が config を読み直して例外を投げ、case 側で友好的に扱う。
  // update は既定値（unifiedConfig = {}）のまま進み、設定が壊れていても入れ替えを実行できる。
  if (sub === 'update') {
    console.warn(`[update] 設定ファイルを読めなかったため既定値で続行します: ${err.message}`);
  }
}

// 同梱の VK Terminals のインストールディレクトリを解決する。未導入なら分かりやすく終了。
async function resolveVkDirOrExit() {
  const { resolveVkTerminalsDir } = await import('../src/config.js');
  try {
    return resolveVkTerminalsDir();
  } catch {
    console.error(
      'VK Terminals が見つかりません（未導入、または optional 依存のビルド失敗で除外されています）。\n' +
      '  導入するには: npm run setup:terminals（ビルドログを表示しながら導入し、結果を検証します）\n' +
      (process.platform === 'darwin'
        ? '  macOS では Xcode Command Line Tools が必要です → `xcode-select --install`'
        : `  現在のプラットフォームは ${process.platform} です。VK Terminals(GUI) は macOS 専用のため\n` +
          '  この環境では起動できません。別マシンの VK Terminals API を使う場合は `up` ではなく\n' +
          '  `start` を使い、VK_TERMINALS_HOST を対象マシンに向けてください。')
    );
    process.exit(1);
  }
}

// up 起動時のセットアップ充足チェック（doctor ベースに一般化）。
//
// 従来は vk-agents 展開の有無だけを警告していたが、doctor の要件チェックリストを使い、
// モード（queue.backend）に応じた required && !ok の項目が 1 つでもあれば
// `/vk-orchestrator-setup` の実行を案内する。既存ユーザーの up を壊さないよう非致命（警告のみ）。
//
// 全 required が ok なら A（統合 config）に setup.completedAt を記録し、次回以降の案内を省く
// （真実はあくまで毎回の doctor。フラグは案内スキップ用のヒントに過ぎない）。
async function warnIfNotReady() {
  const { runDoctor, summarizeDoctor } = await import('../src/doctor.js');
  let requirements;
  try {
    requirements = runDoctor();
  } catch (err) {
    console.warn(`[up] セットアップ診断（doctor）に失敗しました（処理は継続）: ${err.message}`);
    return;
  }
  const summary = summarizeDoctor(requirements);

  if (!summary.allRequiredOk) {
    console.warn(
      `[up] 初回セットアップが未完了です（未充足の必須項目 ${summary.missingRequired.length} 件）。\n` +
      summary.missingRequired.map((r) => `  - ${r.label}: ${r.hint}`).join('\n') + '\n' +
      '  Claude Code でこのリポジトリを開き `/vk-orchestrator-setup` を実行してください（詳細は `vk-orchestrator doctor`）。'
    );
    return;
  }

  // 全 required 充足 → A に setup.completedAt を記録（既記録ならスキップして冪等）。
  try {
    const { resolveConfigPath, loadUnifiedConfig, writeJsonAtomic } = await import('../src/config.js');
    const configPath = resolveConfigPath();
    const cfg = loadUnifiedConfig(configPath);
    if (!cfg?.setup?.completedAt) {
      cfg.setup = { ...(cfg.setup ?? {}), completedAt: new Date().toISOString() };
      writeJsonAtomic(configPath, cfg);
      console.log(`[up] 初回セットアップ完了を記録しました → ${configPath}`);
    }
  } catch (err) {
    console.warn(`[up] setup.completedAt の記録に失敗しました（処理は継続）: ${err.message}`);
  }
}

// up 起動時に vk-orchestrator 自身を最新リリースへ追従させる。
//
// 入手経路（git clone した作業ツリー / 配布 zip の展開）を判定し、経路ごとの手順で更新する。
//   - git … main ブランチ上で `git pull --ff-only` に限定。dirty / 非 main / ff 不可など、
//           開発者の作業や履歴を壊しうる状況では警告して現行プロセスのまま起動を続行する。
//   - zip … 新しい配布 zip を取得して展開・検証し、インストールディレクトリを入れ替える。
//
// 自動で当てるのは「起動時のみ」。GUI もタスクもまだ動いていないこの位置だけが、
// 走行中のターミナルを巻き込まずに入れ替えられる静止点になる（常駐中は知らせるだけ）。
async function reconcileOrchestratorVersion() {
  const repoRoot = resolve(__dirname, '..');
  const alreadyUpdated = process.env.VK_ORCHESTRATOR_SELF_UPDATED === '1';

  const {
    performZipUpdate,
    pruneStaleStagingDirs,
    recoverPendingUpdate,
    refreshSnapshotAfterUpdate,
    runUpdateCheck,
    saveUpdateSnapshot,
  } = await import('../src/engine/update-runner.js');
  const { formatNoticeForLog } = await import('../src/engine/update-messages.js');

  // 前回の入れ替えが途中で終わっていたら、続行するか元へ戻す。必ず毎起動で通す
  // （ここを通さないと「install が無い」状態のまま起動しようとして何も動かなくなる）。
  // repoRoot を渡すのは、作業記録が「このインストール」のものかを確かめさせるため。
  try {
    recoverPendingUpdate({ repoRoot, logger: console });
  } catch (err) {
    console.warn(`[up] 中断したアップデートの確認に失敗しました（処理は継続）: ${err.message}`);
  }

  if (alreadyUpdated) {
    console.log('[up] アップデート後の起動のため、新しい版の確認をスキップします。');
    // 確認はスキップするが、記録の「お使いの版」だけは通信せずに今の版へ直す。
    // ここを省くと、切り替え直後に設定画面を開いたときに旧版が表示されてしまう。
    try {
      refreshSnapshotAfterUpdate({ repoRoot });
    } catch (err) {
      console.warn(`[up] 確認結果の記録の更新に失敗しました（処理は継続）: ${err.message}`);
    }
    // 展開先の片付けはここでは行わない。展開先はもう install へ rename されていて
    // 片付ける対象が無く、かつこの時点では入れ替えを行った親プロセスがまだ更新ロックを
    // 保持している（--apply から返るまで解放されない）。呼ぶと「ほかのアップデート処理が
    // 実行中」という案内が、切り替え成功の直後に毎回出てしまう。
    return;
  }

  // 過去に失敗した更新の展開先を片付ける。展開先には利用者の資産（.env / config.json）の
  // 複製と node_modules が入るため、放っておくと版が変わるたびに溜まり続ける。
  // 復旧に必要な展開先（作業記録が入れ替え中を示している間）は残す。
  try {
    pruneStaleStagingDirs(repoRoot, { logger: console });
  } catch (err) {
    console.warn(`[up] 使われていない展開先の片付けに失敗しました（処理は継続）: ${err.message}`);
  }

  // 実行可否を測る。自動経路にもガードが必要で、これが無いと「もう 1 つ起動した npm start」が
  // 動いている GUI と engine の足元でインストールディレクトリを差し替えてしまう
  // （走行中プロセスは古い実体を掴み続けるため、書き込みが控え側へ落ちて黙って失われる）。
  const blockers = await measureCurrentUpdateBlockers(repoRoot);
  const busy = blockers.some((b) => b.code === 'busy-gui' || b.code === 'busy-engine');

  console.log('[up] 新しい版があるかを確認します...');
  let report;
  try {
    report = await runUpdateCheck({ repoRoot, cfg: unifiedConfig, busy });
  } catch (err) {
    console.warn(`[up] 新しい版の確認に失敗しました（処理は継続）: ${err.message}`);
    return;
  }

  // 設定画面・サイドバーが同じ内容を出せるよう、確認結果を作業記録へ残す。
  try {
    saveUpdateSnapshot(report);
  } catch (err) {
    console.warn(`[up] 確認結果の記録に失敗しました（処理は継続）: ${err.message}`);
  }

  // 起動時ログと設定画面のお知らせに同じ文字列を流す（文言カタログが唯一の正）。
  console.log(`[up] ${report.summary}`);
  const noticeLog = formatNoticeForLog(report.notice);
  if (noticeLog) {
    if (report.notice.tone === 'warning') console.warn(`[up] ${noticeLog}`);
    else console.log(`[up] ${noticeLog}`);
  }

  if (report.decision.action !== 'update') return;

  if (blockers.length > 0) {
    console.warn(
      '[up] すでに VK Orchestrator が動作しているため、アップデートを見送りました（現行版のまま起動します）。\n' +
      blockers.map((b) => `  - ${b.message}\n    → ${b.hint}`).join('\n')
    );
    return;
  }

  if (report.channel === 'git') {
    await applyGitUpdate(repoRoot, report);
    return;
  }

  if (report.channel === 'zip') {
    const updateConfig = (await import('../src/config.js')).getUpdateConfig(unifiedConfig);
    const result = await performZipUpdate({
      repoRoot,
      manifest: report.manifest,
      allowedHosts: updateConfig.allowedHosts,
      // 入れ替え後は、いま実行しようとしていたコマンドをそのまま新しい版で実行し直す。
      argv: process.argv.slice(2),
      logger: console,
    });
    if (!result.ok) {
      console.warn(
        `[up] アップデートを適用できませんでした（現行版のまま起動します）: ${result.message}`
      );
      return;
    }
    process.exit(result.exitCode);
  }
}

// 「今アップデートしてよいか」を実環境から測る。自動経路（up 起動時）と
// 明示経路（update コマンド）と入れ替え直前の再確認で、同じ測り方を共有する。
async function measureCurrentUpdateBlockers(repoRoot) {
  const { checkHealth } = await import('../src/terminals/index.js');
  const { defaultStartLockFile } = await import('../src/engine/start-lock.js');
  const { detectUpdateChannel, measureUpdateBlockers } = await import('../src/engine/update-runner.js');
  const { resolveVkTerminalsApiPort } = await import('../src/config.js');

  let healthResponding = false;
  try {
    healthResponding = await checkHealth(resolveVkTerminalsApiPort(), { timeoutMs: 1_500 });
  } catch {
    // 疎通確認そのものが失敗した場合は「動いていない」とみなす（起動を止めない）。
  }
  return measureUpdateBlockers({
    channel: detectUpdateChannel(repoRoot).channel,
    healthResponding,
    lockFile: defaultStartLockFile(),
  });
}

// git clone した作業ツリーでの更新（main の ff 追従 → 必要なら npm install → 起動し直し）。
//
// relaunch は「元の起動処理へ戻すかどうか」。up 起動時の追従では true（新しいコードで
// 起動し直す）。明示的な `vk-orchestrator update` では false（更新するだけが目的で、
// 起動し直すと同じ update をもう一度走らせることになる）。
async function applyGitUpdate(repoRoot, report, { relaunch = true } = {}) {
  const { spawnSync } = await import('child_process');
  const gitOutput = (args) => {
    const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    if (r.status !== 0) return null;
    return r.stdout.trim();
  };
  const gitBlobHash = (path) => gitOutput(['rev-parse', `HEAD:${path}`]);

  const beforeLock = gitBlobHash('package-lock.json');
  console.log(`[up] ${report.current} → ${report.latest} へ更新します（main を ff 追従）...`);
  const pull = spawnSync('git', ['pull', '--ff-only'], { cwd: repoRoot, stdio: 'inherit' });
  if (pull.status !== 0) {
    console.warn('[up] git pull --ff-only に失敗しました。現行版で起動します。');
    return;
  }

  const afterLock = gitBlobHash('package-lock.json');
  if (beforeLock !== afterLock) {
    console.log('[up] 依存関係が変わったため npm install を実行します...');
    const install = spawnSync('npm', ['install'], { cwd: repoRoot, stdio: 'inherit' });
    if (install.status !== 0) {
      console.warn(
        '[up] npm install に失敗しました。現行プロセスのまま起動を続行します。\n' +
        '  手動で `npm install` を実行してください。'
      );
      return;
    }
  }

  if (!relaunch) {
    console.log(`[update] ${report.latest} へのアップデートが完了しました。次の起動から新しいコードで動きます。`);
    return;
  }

  console.log('[up] アップデートが完了しました。新しいコードで起動し直します...');
  const child = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, VK_ORCHESTRATOR_SELF_UPDATED: '1' },
  });
  if (child.error) {
    console.warn(
      `[up] 新しい版で起動し直せませんでした。現行プロセスのまま起動を続行します: ${child.error.message}\n` +
      '  もう一度 `npm start` を実行してください。'
    );
    return;
  }
  process.exit(child.status ?? 1);
}

// up 起動時に、同梱している vk-agents（スキル・ルール）の版ズレを解消する。
//
// フックを「更新完了時」ではなく起動時の版ズレ解消フェーズに置くのが要点。更新経路にだけ
// 付けると、git 経路での pull 後・手動での zip 上書き・別マシンからの同期を取りこぼす。
// ~/.claude を書き換える処理なので、版が変わったときだけ走らせる。
async function reconcileVkAgentsDeployment() {
  const {
    DEFAULT_VENDORED_VK_AGENTS_DIR,
    isVkAgentsSetup,
    readVendoredVkAgentsVersion,
    readVkAgentsManifestSource,
    writeVkAgentsManifestSource,
    writeVkAgentsSettings,
    vkAgentsGlobalSettingsPath,
  } = await import('../src/config.js');
  const { evaluateAgentsVersionState, resolveAgentsSyncAction } =
    await import('../src/engine/agents-redeploy.js');
  const { formatAgentsVersionNotice } = await import('../src/engine/update-messages.js');

  const agentsDir = DEFAULT_VENDORED_VK_AGENTS_DIR;
  const vendorVersion = readVendoredVkAgentsVersion(agentsDir);
  const recorded = readVkAgentsManifestSource();
  const input = {
    vendorVersion,
    recordedVersion: recorded?.sourceVersion ?? null,
    manifestExists: isVkAgentsSetup(),
  };
  // sync.sh は ~/.claude を書き換えるため、同梱のほうが新しいと確かに分かるときだけ走らせる
  // （判定は純粋関数側。同梱が古い状態で走らせると利用者の ~/.claude を巻き戻す）。
  const state = evaluateAgentsVersionState(input);
  const { run } = resolveAgentsSyncAction(input);

  // 展開する・しないに関わらず、伝えるべきことがあれば 1 行知らせる。
  // とくに「同梱のほうが古い」は利用者が自分で新しくしている通常の状態なので、
  // 黙っていると「なぜ展開されないのか」が分からない。
  const notice = formatAgentsVersionNotice(state);
  if (notice) {
    if (notice.level === 'warn') console.warn(`[up] ${notice.text}`);
    else console.log(`[up] ${notice.text}`);
  }

  if (!run) return;

  const { spawnSync } = await import('child_process');
  const { evaluateSyncExit } = await import('../src/setup/sync-exit.js');
  const syncPath = resolve(agentsDir, 'scripts', 'sync.sh');

  try {
    writeVkAgentsSettings(unifiedConfig, { globalSettingsPath: vkAgentsGlobalSettingsPath(), force: true });
  } catch (err) {
    console.warn(`[up] vk-agents 設定の書き出しに失敗しました（展開は続行）: ${err.message}`);
  }

  const r = spawnSync('bash', [syncPath, '--claude-global'], {
    cwd: agentsDir,
    stdio: 'inherit',
    env: process.env,
  });
  const outcome = evaluateSyncExit(r.status);
  if (!outcome.proceed) {
    console.warn(
      '[up] エージェント定義の展開に失敗しました（処理は継続）。\n' +
      '  手動で `npm run setup:agents` を実行してください。'
    );
    return;
  }
  if (outcome.warning) console.warn(outcome.warning);

  try {
    const recordPath = writeVkAgentsManifestSource(agentsDir, { sourceVersion: vendorVersion });
    console.log(`[up] エージェント定義の展開元を記録しました → ${recordPath}`);
  } catch (err) {
    console.warn(`[up] 展開元の記録に失敗しました（処理は継続）: ${err.message}`);
  }
}

// up 起動時に vk-terminals を最新へ追従させる。
//
// 既定では GitHub のリモートタグを見て最新 semver を導入対象とし、node_modules に
// 入っている version とズレていれば（または未導入なら）その版を入れ直す。これにより
// vk-terminals 側がタグを打つだけで、各ユーザーは `up` するだけで最新 GUI に上がる
// （orchestrator の package.json bump / push / pull が不要になる）。
//
// 追従対象の決め方（優先順）:
//   1. env VK_TERMINALS_TAG="1.5.2" … 明示ピン／ロールバック。リモート照会せずこの版に固定。
//   2. env VK_TERMINALS_NO_AUTO_UPDATE=1 … 自動追従を無効化し package.json 固定タグに照合（従来動作。オフライン向け）。
//   3. 既定 … リモートの最新 semver タグ。照会失敗時は package.json 固定タグへフォールバック。
//
// インストールは `npm install vk-terminals@…#<タグ> --no-save` で行う。--no-save により
// ユーザーの clone の package.json / lock を汚さず node_modules だけ差し替える。
// --include=optional を付けないと git 依存の optional build が走らない点に注意。
async function reconcileVkTerminalsVersion() {
  const { readFileSync } = await import('fs');
  const repoRoot = resolve(__dirname, '..');

  // package.json 固定タグ（フォールバック用）。spec "git+…#<タグ>" から取り出す。
  let pinnedTag = null;
  try {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    const spec =
      pkg.optionalDependencies?.['vk-terminals'] ?? pkg.dependencies?.['vk-terminals'] ?? '';
    pinnedTag = spec.match(/#(.+)$/)?.[1] ?? null;
  } catch {
    return; // package.json が読めない状況では何もしない
  }

  // 実際に入っている version（未導入なら null）。
  let installed = null;
  try {
    const { resolveVkTerminalsDir } = await import('../src/config.js');
    installed = JSON.parse(
      readFileSync(resolve(resolveVkTerminalsDir(), 'package.json'), 'utf8')
    ).version;
  } catch {
    // 未導入 → 下でインストールする
  }

  // 追従対象タグの決定。
  let targetTag = null;
  const envTag = process.env.VK_TERMINALS_TAG?.trim();
  const autoUpdate = process.env.VK_TERMINALS_NO_AUTO_UPDATE !== '1';
  if (envTag) {
    targetTag = envTag; // 明示ピン
  } else if (autoUpdate) {
    try {
      const { fetchTags, latestSemverTag } = await import('../scripts/vk-terminals-tags.mjs');
      targetTag = latestSemverTag(fetchTags());
      if (!targetTag) {
        console.warn('[up] vk-terminals のリモート最新タグを解決できませんでした。固定タグにフォールバックします。');
      }
    } catch {
      console.warn('[up] vk-terminals のリモート照会に失敗しました（オフライン等）。固定タグにフォールバックします。');
    }
  }
  targetTag ??= pinnedTag; // 未解決なら package.json 固定タグ

  // 照合できるのはタグが semver（"1.5.1" / "v1.5.1"）で version と比較できる場合のみ。
  const normTag = targetTag?.replace(/^v/, '');
  const isSemverTag = normTag != null && /^\d+\.\d+\.\d+$/.test(normTag);

  if (installed && !isSemverTag) return; // SHA 固定等は照合不能なのでスキップ
  if (installed && isSemverTag && installed === normTag) return; // 既に対象版 → 何もしない
  if (!targetTag) return; // 導入対象が決められない

  const spec = `vk-terminals@git+https://github.com/vektor-inc/vk-terminals.git#${targetTag}`;
  const { spawnSync } = await import('child_process');
  console.log(
    installed
      ? `vk-terminals を更新します（導入済み: ${installed} → 対象: ${targetTag}）...`
      : `vk-terminals が未導入です。${targetTag} をインストールします...`
  );
  const r = spawnSync(
    'npm',
    ['install', spec, '--no-save', '--include=optional', '--foreground-scripts'],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  if (r.status !== 0) {
    console.warn(
      '[up] vk-terminals のインストールに失敗しました。古い版のまま起動する可能性があります。\n' +
      '  手動で `npm run setup:terminals` を実行してください。'
    );
  }
}

// `vk-orchestrator update [--check]` の実装。
//
// --check      … 副作用なしの確認だけ。診断コマンドと同じ流儀で、更新があっても exit 0 を返す
//                （更新有無の判定は --json の updateAvailable を読む）。
// （引数なし）  … 展開 → 照合 → 展開先の動作確認 → 入れ替え → 起動し直し。
//                アプリやオーケストレーターが動いていれば実行せず拒否する。
// --apply      … 内部用。展開先から起動されて実際の入れ替えだけを行う。
async function runUpdateSubcommand(args) {
  const repoRoot = resolve(__dirname, '..');
  const asJson = args.includes('--json');
  const {
    applyStagedUpdate,
    performZipUpdate,
    runUpdateCheck,
    saveUpdateSnapshot,
  } = await import('../src/engine/update-runner.js');
  const { formatUpdateReport } = await import('../src/engine/update-messages.js');

  // --- 内部用: 展開先から起動され、入れ替えだけを行う ---
  if (args.includes('--apply')) {
    process.exit(await runUpdateApply(args, repoRoot, applyStagedUpdate));
  }

  const checkOnly = args.includes('--check');
  const { getUpdateConfig } = await import('../src/config.js');
  const updateConfig = getUpdateConfig(unifiedConfig);

  // 稼働中かどうかは実行系だけが気にする（--check は副作用なしなのでいつでも通す）。
  const blockers = checkOnly ? [] : await measureCurrentUpdateBlockers(repoRoot);
  const busy = blockers.some((b) => b.code === 'busy-gui' || b.code === 'busy-engine');

  const report = await runUpdateCheck({
    repoRoot,
    cfg: unifiedConfig,
    busy,
  });
  report.blockers = [...blockers, ...report.blockers];

  try {
    saveUpdateSnapshot(report);
  } catch {
    // 表示用の記録なので、残せなくても確認結果は返す。
  }

  if (checkOnly) {
    if (asJson) {
      console.log(JSON.stringify(buildUpdateJson(report), null, 2));
    } else {
      console.log(formatUpdateReport(report));
    }
    return; // 診断系なので exit 0 固定
  }

  if (report.blockers.length) {
    if (asJson) console.error(JSON.stringify(buildUpdateJson(report), null, 2));
    else console.error(formatUpdateReport(report));
    process.exit(1);
  }

  if (report.decision.action !== 'update') {
    if (asJson) console.log(JSON.stringify(buildUpdateJson(report), null, 2));
    else console.log(formatUpdateReport(report));
    return;
  }

  // 非対話（ログへのリダイレクト・CI 等）では確認が取れないため、明示の --yes を要求する。
  if (!process.stdin.isTTY && !args.includes('--yes')) {
    console.error(
      '[update] 対話端末ではないため、アップデートを実行しません。\n' +
      '  意図した実行であれば `vk-orchestrator update --yes` を指定してください。'
    );
    process.exit(1);
  }

  if (report.channel === 'git') {
    await applyGitUpdate(repoRoot, report, { relaunch: false });
    return;
  }

  // zip の入れ替えは新しい側から起動したプロセスが行う。argv を空にして、入れ替え後の
  // 起動し直しでは何も実行しない（`update` は「更新するだけ」が目的）。
  const result = await performZipUpdate({
    repoRoot,
    manifest: report.manifest,
    allowedHosts: updateConfig.allowedHosts,
    argv: [],
    logger: console,
  });
  if (!result.ok) {
    console.error(`[update] アップデートを適用できませんでした: ${result.message}`);
    process.exit(1);
  }
  process.exit(result.exitCode);
}

// 内部モード `update --apply --from <展開先> --target <入れ替え先>` の実装。
//
// 受理条件の検証は update-runner.js の validateApplyArguments に集約している
// （引数をそのまま信じると、任意のディレクトリが rename と再帰削除の対象になる）。
// このモードは展開先から起動されるので、ここでの「自分自身」は展開先になる。
async function runUpdateApply(args, selfRoot, applyStagedUpdate) {
  const { validateApplyArguments } = await import('../src/engine/update-runner.js');

  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const from = valueOf('--from');
  const target = valueOf('--target');
  if (!from || !target) {
    console.error('[update] --apply には --from <展開先> と --target <入れ替え先> が必要です（内部用）。');
    return 1;
  }

  const validated = validateApplyArguments({ from, target, selfRoot });
  if (!validated.ok) {
    console.error(`[update] 入れ替えを行いません: ${validated.message}`);
    return 1;
  }

  let forwardedArgv = [];
  const rawArgv = valueOf('--argv');
  if (rawArgv) {
    try {
      const parsed = JSON.parse(rawArgv);
      if (Array.isArray(parsed)) forwardedArgv = parsed.map((a) => String(a));
    } catch {
      console.warn('[update] 起動し直すときの引数を読めませんでした。引数なしで起動し直します。');
    }
  }

  // 入れ替えの直前にもう一度、稼働していないことを確かめる。展開・依存の入れ直し・
  // 動作確認で数分かかるため、入口で測った結果はここでは古くなっている。
  const blockers = await measureCurrentUpdateBlockers(validated.installDir);

  return applyStagedUpdate({
    stagedDir: validated.stagedDir,
    installDir: validated.installDir,
    argv: forwardedArgv,
    logger: console,
    blockers,
  });
}

// `update --json` の出力形。スクリプトからはこの形だけを読めばよい。
function buildUpdateJson(report) {
  return {
    channel: report.channel,
    current: report.current ?? null,
    latest: report.latest ?? null,
    updateAvailable: report.updateAvailable === true,
    decision: report.decision ?? null,
    blockers: report.blockers ?? [],
    manifest: report.manifest
      ? {
          version: report.manifest.version,
          releasedAt: report.manifest.releasedAt,
          bundled: report.manifest.bundled,
          changelogUrl: report.manifest.changelogUrl,
        }
      : null,
    lastCheckedAt: report.lastCheckedAt ?? null,
    backupPath: report.backupPath ?? null,
    preserved: report.preserved ?? [],
  };
}

// 移設した engine 側スクリプトは import しただけで自走する（副作用実行）。
// --once / --assignee 等のフラグは各スクリプトが process.argv を直接読むため、
// ここではサブコマンド名の分岐だけを行い、対応スクリプトを動的 import する。
async function main() {
  switch (sub) {
    case 'start':
      await import('../src/engine/index.js');
      break;
    case 'check-status':
      await import('../src/engine/check-status.mjs');
      break;
    case 'unblock':
      await import('../src/engine/unblock.mjs');
      break;
    case 'task': {
      const { runLocalTaskCommand } = await import('../src/local-queue/task-cli.js');
      await runLocalTaskCommand(process.argv.slice(3));
      break;
    }
    case 'doctor': {
      // 初回セットアップ充足判定。既定は人間可読レポート、--json で要件配列＋要約を出力。
      // 診断コマンドのため、未充足でも例外扱いにはせず exit 0 で返す（スクリプトからは --json の
      // requirements[].ok / summary.allRequiredOk を読んで判定する）。
      const asJson = process.argv.includes('--json');
      const { runDoctor, summarizeDoctor, formatDoctorReport } = await import('../src/doctor.js');
      // doctor は「設定が壊れている人を助ける」ツールなので、config.json の不正 JSON などで
      // runDoctor 自身が例外を投げても、生スタックで落ちず分かりやすいメッセージにして返す。
      // 人間可読・--json 双方で破綻しないよう、ここで捕捉する（main の catch まで抜けさせない）。
      try {
        const requirements = runDoctor();
        const summary = summarizeDoctor(requirements);
        if (asJson) {
          console.log(JSON.stringify({ requirements, summary }, null, 2));
        } else {
          console.log(formatDoctorReport(requirements, summary));
        }
      } catch (err) {
        const hint = 'config.json が正しい JSON か確認してください（既定の探索先は VK_ORCHESTRATOR_CONFIG > ~/.vk-orchestrator/config.json > リポ直下 config.json）。';
        if (asJson) {
          console.error(JSON.stringify({ error: err.message, hint }, null, 2));
        } else {
          console.error(`[doctor] 設定の読み込みに失敗しました: ${err.message}\n  ${hint}`);
        }
      }
      break;
    }
    case 'update': {
      await runUpdateSubcommand(process.argv.slice(3));
      break;
    }
    case 'apply': {
      // vk-agents 共通設定は従来どおり apply/up タイミングで派生設定へ投影する。
      const { writeVkAgentsSettings } = await import('../src/config.js');
      const vkAgents = writeVkAgentsSettings(unifiedConfig);
      if (vkAgents) {
        console.log(`vk-agents 設定を書き出しました → ${vkAgents.configPath}`);
        console.log(`vk-agents 派生設定を書き出しました → ${vkAgents.globalSettingsPath}`);
      } else {
        console.warn('[apply] vk-agents 設定の投影はスキップしました（config.json 未作成、またはパス未解決）。');
      }
      break;
    }
    case 'up': {
      // --- tmux モード分岐 ---
      // 実行面が tmux のときは Electron(VK Terminals) を一切起動しない。
      // orchestrator 本体(engine)も tmux セッションの window 内で常駐させる（親プロセスで
      // 動かすと端末切断で止まるため）。ワーカーペインは engine が同 window を split して
      // 並べ、利用者は `tmux attach -t <session>` で覗く（Ctrl-b d で離脱しても動作継続）。
      {
        const { resolveTerminalsMode, resolveTmuxSession, writeVkAgentsSettings } =
          await import('../src/config.js');
        if (resolveTerminalsMode(unifiedConfig) === 'tmux') {
          const { spawnSync } = await import('child_process');
          const session = resolveTmuxSession(unifiedConfig);

          // vk-agents 派生設定を投影（VK Terminals モードと同じ。tmux で起動する Claude が
          // GUI 経由と同じ最新設定を使えるようにする）。
          const vkAgents = writeVkAgentsSettings(unifiedConfig);
          if (vkAgents) {
            console.log(`vk-agents 設定を反映しました → ${vkAgents.configPath}`);
            console.log(`vk-agents 派生設定を反映しました → ${vkAgents.globalSettingsPath}`);
          } else {
            console.warn('[up] vk-agents 設定の投影はスキップしました（config.json 未作成、またはパス未解決）。');
          }
          // 起動前に orchestrator 自身の版ズレを解消する（VK Terminals パスと同じ順序）。
          // 自己更新が走ると子プロセスで再実行して exit するため、doctor はその後に置く
          // （更新前コードの診断を利用者に見せないため）。
          await reconcileOrchestratorVersion();
          await reconcileVkAgentsDeployment();
          // doctor ベースの起動時案内（未定義関数を呼んでいて ReferenceError になっていた箇所）。
          // doctor は terminals.mode を見てモード別に required を計算するので、tmux モードでも
          // 「VK Terminals 未導入」を必須欠損にせず正しくゲートできる。
          await warnIfNotReady();

          // engine を起動する start コマンドを tmux window 内で実行する。tmux server が
          // 既存だと server の古い env を引くため、必要な env はコマンド文字列へ焼き込む。
          const repoRoot = resolve(__dirname, '..');
          const forwarded = process.argv.slice(3).filter((a) => a !== '--no-orchestrator' && a !== '--no-attach');
          const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
          const envKeys = ['VK_TERMINALS_MODE', 'VK_TMUX_SESSION', 'VK_TMUX_CLAUDE_CMD',
            'TASK_WP_ENV_ENABLED', 'TASK_CWD', 'VK_TERMINALS_HOST', 'VK_TERMINALS_PORT'];
          const envAssignments = envKeys
            .filter((k) => process.env[k] != null && process.env[k] !== '')
            .map((k) => `${k}=${shq(process.env[k])}`);
          // config で tmux を選び env 未設定でも、子 start が確実に tmux モードになるよう固定。
          if (!process.env.VK_TERMINALS_MODE) envAssignments.unshift('VK_TERMINALS_MODE=tmux');
          const startCmd =
            `env ${envAssignments.join(' ')} node ${shq(__filename)} start ${forwarded.map(shq).join(' ')}`.trim();

          const has = spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' });
          if (has.status !== 0) {
            const created = spawnSync(
              'tmux',
              ['-u', 'new-session', '-d', '-s', session, '-n', 'orchestrator', '-c', repoRoot, startCmd],
              { stdio: 'inherit' }
            );
            if (created.status !== 0) {
              console.error(`[up] tmux セッション "${session}" を作成できませんでした（tmux は入っていますか？）。`);
              process.exit(1);
            }
            console.log(`tmux セッション "${session}" を作成し、orchestrator を起動しました。`);
          } else {
            // 既存セッションに orchestrator window が無ければ起動（start-lock が二重起動を防ぐ）。
            const wins = spawnSync('tmux', ['list-windows', '-t', session, '-F', '#{window_name}'],
              { encoding: 'utf8' });
            const hasOrch = (wins.stdout || '').split('\n').some((n) => n.trim() === 'orchestrator');
            if (!hasOrch) {
              spawnSync('tmux', ['-u', 'new-window', '-t', session, '-n', 'orchestrator', '-c', repoRoot, startCmd],
                { stdio: 'inherit' });
              console.log(`既存セッション "${session}" に orchestrator を起動しました。`);
            } else {
              console.log(`セッション "${session}" で orchestrator は起動済みです。`);
            }
          }

          // 対話端末ならそのまま attach して見せる。非対話（ログリダイレクト等）や
          // --no-attach 指定時は案内だけ出して抜ける（セッションは動き続ける）。
          if (process.stdout.isTTY && !process.argv.includes('--no-attach')) {
            spawnSync('tmux', ['-u', 'attach', '-t', session], { stdio: 'inherit' });
          } else {
            console.log(`\`tmux attach -t ${session}\` で入れます（Ctrl-b d で離脱、切断されても動作継続）。`);
          }
          break;
        }
      }
      // --- 以降は従来の VK Terminals(Electron) 起動フロー（不変） ---
      // 設定を反映したうえで、同梱の VK Terminals(GUI) を起動し、その GUI の中に
      // orchestrator 用ペインを1つ開いて `vk-orchestrator start` を走らせる。
      //
      // orchestrator を外部ターミナル（npm start を叩いた端末）の子プロセスにするのではなく、
      // GUI 内の素のシェルペイン（noClaude）で動かすことで、
      //   - ペインタイトルに「オーケストレーター」が立ち（他ペインと一目で区別できる）
      //   - GUI を閉じればペインごと orchestrator も終了する
      // という運用になる。これで「ペインを開いて claude を止めて start を打つ」手動手順が不要になる。
      //
      // API が listen してからでないとペイン作成もできないため、waitForHealth で疎通を待つ。
      // GUI だけ起動したい場合は `--no-orchestrator` を付ける。
      const { spawn } = await import('child_process');
      const { randomUUID } = await import('crypto');
      const { writeVkAgentsSettings, writeSettingsDescriptor, resolveConfigPath, writeVkTerminalsTasksViewConfig,
        writeVkTerminalsTasksWidgetConfig,
        writeVkTerminalsCommandsConfig,
        resolveVkTerminalsApiHost, resolveVkTerminalsApiPort, getVkTerminalsGpuMode, gpuLaunchOptions } =
        await import('../src/config.js');
      const {
        checkHealth,
        waitForHealth,
        fetchHealth,
        findFreePort,
        evaluateHealthInstance,
        createNewPane,
        sendToTerminal,
        setPaneLock,
      } = await import('../src/terminals/index.js');

      // GUI 起動前に、orchestrator 自身と固定タグ・実際に入っている版のズレを解消しておく。
      await reconcileOrchestratorVersion();
      await reconcileVkTerminalsVersion();
      await reconcileVkAgentsDeployment();
      await warnIfNotReady();

      const vkDir = await resolveVkDirOrExit();
      const vkAgents = writeVkAgentsSettings(unifiedConfig);
      if (vkAgents) {
        console.log(`vk-agents 設定を反映しました → ${vkAgents.configPath}`);
        console.log(`vk-agents 派生設定を反映しました → ${vkAgents.globalSettingsPath}`);
      } else {
        console.warn('[up] vk-agents 設定の投影はスキップしました（config.json 未作成、またはパス未解決）。');
      }

      // GUI の設定パネルから統合 config.json を直接編集できるよう、設定ディスクリプタを
      // 書き出し、env VK_TERMINALS_SETTINGS でそのパスを GUI へ渡す。
      const configPath = resolveConfigPath();
      const descriptorPath = writeSettingsDescriptor(vkDir, configPath);
      console.log(`設定パネル用ディスクリプタを書き出しました → ${descriptorPath}（編集対象: ${configPath}）`);

      try {
        const tasksView = writeVkTerminalsTasksViewConfig();
        console.log(`tasks-view snapshot パスを VK Terminals 設定へ反映しました → ${tasksView.tasksViewPath}`);
      } catch (err) {
        console.warn(`[up] tasks-view snapshot パスの VK Terminals 設定反映に失敗しました（処理は継続）: ${err.message}`);
      }

      try {
        const tasksWidget = writeVkTerminalsTasksWidgetConfig();
        console.log(`tasks-widget 宣言パスを VK Terminals 設定へ反映しました → ${tasksWidget.tasksWidgetPath}`);
      } catch (err) {
        console.warn(`[up] tasks-widget 宣言パスの VK Terminals 設定反映に失敗しました（処理は継続）: ${err.message}`);
      }

      try {
        const commands = writeVkTerminalsCommandsConfig();
        console.log(`commands.jsonl パスを VK Terminals 設定へ反映しました → ${commands.commandsPath}`);
      } catch (err) {
        console.warn(`[up] commands.jsonl パスの VK Terminals 設定反映に失敗しました（処理は継続）: ${err.message}`);
      }

      const startOrchestrator = !process.argv.includes('--no-orchestrator');

      // GUI(Electron) の GPU 起動モードを解決し、電子へ渡すフラグと追加 env を組み立てる。
      // 既定は非 macOS で 'off'（Chromium の GPU 初期化失敗による `Exiting GPU process`
      // 等のエラーログを抑制。描画はソフトウェアだがターミナル用途で実害なし）。
      // env `VK_TERMINALS_GPU` / VK Terminals 本体 config `gpu` で 'default'
      // （Chromium 任せ）へ切り替え可能。
      // フラグは `npm start -- <flags>` で `electron .` 側へ渡す。
      const gpuMode = getVkTerminalsGpuMode();
      const { args: gpuArgs, env: gpuEnv } = gpuLaunchOptions(gpuMode);
      const guiArgs = gpuArgs.length ? ['start', '--', ...gpuArgs] : ['start'];
      const preferredPort = resolveVkTerminalsApiPort();
      const host = resolveVkTerminalsApiHost();
      if (!process.env.VK_TERMINALS_HOST) process.env.VK_TERMINALS_HOST = host;

      let apiPort = preferredPort;
      const instanceId = randomUUID();
      const preferredPortInUse = await checkHealth(preferredPort, { timeoutMs: 1_500 });
      if (preferredPortInUse) {
        try {
          apiPort = await findFreePort(host);
          console.warn(
            `[up] VK Terminals API (${host}:${preferredPort}) は既に応答しています。\n` +
            `  既存ウィンドウへの誤接続を避けるため、新しい VK Terminals は空きポート ${apiPort} で起動します。\n` +
            '  このポートは今回の起動用に自動確保したランダムポートです。tailscale serve やモバイルページからは通常どおり接続できません。\n' +
            '  それらを使う場合は、既存の VK Terminals を終了してから `npm start` を実行してください。'
          );
        } catch (err) {
          console.warn(
            `[up] VK Terminals API (${host}:${preferredPort}) は既に応答していますが、代替ポートを確保できませんでした。\n` +
            `  orchestrator ペインは作成しません（要求ポート: ${preferredPort}、host: ${host}）。\n` +
            `  既存の VK Terminals を終了してから \`npm start\` を実行するか、apiHost 設定を確認してください。\n` +
            `  詳細: ${err.message}`
          );
          break;
        }
      }

      console.log(`VK Terminals(GUI) を起動します（${vkDir}, gpu=${gpuMode}, api=${host}:${apiPort}）...`);
      const gui = spawn('npm', guiArgs, {
        cwd: vkDir,
        stdio: 'inherit',
        // ウィンドウタイトルバー／ヘッダーの表記を 'VK Orchestrator' にする。
        // 未指定なら vk-terminals 側の既定 'VK Terminals' が使われる。
        // 呼び出し元が明示指定していればそれを尊重する。
        env: {
          ...process.env,
          ...gpuEnv,
          // orchestrator 側の互換 env は VK_TERMINALS_PORT、本体側の env は
          // VK_TERMINALS_API_PORT。up で同時起動する場合だけ、待受ポートと接続ポートを揃える。
          VK_TERMINALS_PORT: String(apiPort),
          VK_TERMINALS_API_PORT: String(apiPort),
          VK_TERMINALS_INSTANCE_ID: instanceId,
          VK_TERMINALS_SETTINGS: descriptorPath,
          VK_TERMINALS_APP_TITLE: process.env.VK_TERMINALS_APP_TITLE || 'VK Orchestrator',
        },
      });
      gui.on('exit', (code) => process.exit(code ?? 0));

      if (startOrchestrator) {
        const port = apiPort;
        console.log(`VK Terminals API (${host}:${port}) の起動を待っています...`);
        let latestHealth = null;
        const healthy = await waitForHealth(port, {
          timeoutMs: 60_000,
          intervalMs: 1_000,
          check: async (p) => {
            latestHealth = await fetchHealth(p, { timeoutMs: 3_000 });
            return latestHealth?.ok === true;
          },
        });

        if (gui.exitCode !== null) break; // 疎通待ちの間に GUI が閉じられた

        if (!healthy) {
          console.warn(
            `[up] VK Terminals API (${host}:${port}) に疎通できませんでした。` +
            `orchestrator ペインは作成しません。\n` +
            `  VK_TERMINALS_HOST / ~/.vk-terminals/config.json の apiHost（現在: ${host}）を確認するか、` +
            `GUI 内のペインで手動で \`node ${__filename} start\` を実行してください。`
          );
          break;
        }

        const instanceCheck = evaluateHealthInstance(latestHealth, instanceId);
        if (!instanceCheck.ok) {
          if (instanceCheck.reason === 'instance-mismatch') {
            console.warn(
              `[up] VK Terminals API (${host}:${port}) は別インスタンスとして応答しました。\n` +
              `  今回起動した instanceId は ${instanceId} ですが、応答した instanceId は ${instanceCheck.instanceId} です。\n` +
              '  既存ウィンドウに orchestrator ペインを作らないため中断します。\n' +
              '  既存の VK Terminals を終了してから `npm start` を実行してください。'
            );
          } else {
            console.warn(
              `[up] VK Terminals API (${host}:${port}) に疎通できましたが、health 応答を確認できませんでした。\n` +
              '  orchestrator ペインは作成しません。\n' +
              `  GUI 内のペインで手動で \`node ${__filename} start\` を実行してください。`
            );
          }
          break;
        }

        // GUI 内に「claude を起動しない素のシェルペイン」を開き、そこで orchestrator を走らせる。
        // `up` に付いた自前フラグ(--no-orchestrator)以外の引数は start へ引き継ぐ（--assignee 等）。
        const forwarded = process.argv.slice(3).filter((a) => a !== '--no-orchestrator');
        try {
          const repoRoot = resolve(__dirname, '..');
          // orchestrator ペインは常時監視するものではないためサイドバーに格納して開く。
          // VK Terminals が stashed 未対応の版では未知フィールドとして無視される。
          const termId = await createNewPane(port, repoRoot, { noClaude: true, stashed: true });
          console.log(`orchestrator ペインを作成しました (termId: ${termId})`);

          // 作成した orchestrator ペインを「閉じる保護」でロックする。
          // 誤ってペインを閉じると orchestrator 本体プロセスが道連れで停止する事故
          // （vk-orchestrator#102）を防ぐため、生成直後に閉じる操作を保護する。
          // set-lock は vk-terminals 1.21.0 で導入されたため、未対応の旧版では失敗しうる。
          // ロック失敗で orchestrator 起動を妨げないよう、専用の try/catch で警告して継続する
          // （graceful degradation。ペインは従来どおり動くが保護は掛からない）。
          try {
            await setPaneLock(port, termId, { close: false });
            console.log('orchestrator ペインを閉じる保護でロックしました');
          } catch (err) {
            console.warn(`[up] orchestrator ペインのロックに失敗しました（処理は継続）: ${err.message}`);
          }

          // 素のシェルの起動を少し待ってからコマンドを流し込む（プロンプト出現前の取りこぼし対策）。
          await new Promise((r) => setTimeout(r, 1_200));

          // 絶対パスの bin を叩くことで、ペインの cwd や PATH/npx 解決に依存せず確実に起動する。
          //
          // timeoutMs は既定（3 秒）ではなく明示で 10 秒にする。GUI 起動直後は上の 1.2 秒待ちだけで
          // 投入するため、VK Terminals API を持つ Electron main プロセスが初期化で 3 秒以上詰まりうる。
          // ここはポーリング予算を守る必要のない一発起動パスで、打ち切ると `npm start` の主経路で
          // 「手動で start を実行してください」に落ちてしまうため、長めに待つ方が素直（issue #218）。
          const cmd = ['node', JSON.stringify(__filename), 'start', ...forwarded].join(' ');
          await sendToTerminal(port, termId, cmd + '\r', { timeoutMs: 10_000 });
          console.log(`orchestrator を GUI 内ペインで起動しました: ${cmd}`);
        } catch (err) {
          console.warn(
            `[up] orchestrator ペインの作成／起動に失敗しました（GUI は起動済み）: ${err.message}\n` +
            `  GUI 内のペインで手動で \`node ${__filename} start\` を実行してください。`
          );
        }
      }
      break;
    }
    case 'setup-agents': {
      const { spawnSync } = await import('child_process');
      const {
        DEFAULT_VENDORED_VK_AGENTS_DIR,
        vkAgentsGlobalSettingsPath,
        writeVkAgentsSettings,
        writeVkAgentsManifestSource,
      } = await import('../src/config.js');
      const { evaluateSyncExit } = await import('../src/setup/sync-exit.js');

      const agentsDir = DEFAULT_VENDORED_VK_AGENTS_DIR;
      const syncPath = resolve(agentsDir, 'scripts', 'sync.sh');
      const globalSettingsPath = vkAgentsGlobalSettingsPath();

      const written = writeVkAgentsSettings(unifiedConfig, {
        globalSettingsPath,
        force: true,
      });
      if (!written) {
        console.error('[setup:agents] vk-agents 設定の生成先を解決できませんでした。');
        process.exit(1);
      }
      console.log(`vk-agents 設定を書き出しました → ${written.configPath}`);
      console.log(`vk-agents 派生設定を書き出しました → ${written.globalSettingsPath}`);

      console.log('vk-agents の skills/rules を Claude グローバル設定へ展開します...');
      const r = spawnSync('bash', [syncPath, '--claude-global'], {
        cwd: agentsDir,
        stdio: 'inherit',
        env: process.env,
      });
      // sync.sh は部分成功（一部の書き込みを見送った）を終了コード 2 で通知する。
      // 配布が完了している可能性があるため中断はせず、警告を出したうえで展開元の
      // 記録まで続行する（2 は異常終了でも起こり得るので警告側で断定はしない）。
      const syncOutcome = evaluateSyncExit(r.status);
      if (!syncOutcome.proceed) {
        console.error(`[setup:agents] sync.sh の実行に失敗しました: ${syncPath}`);
        process.exit(syncOutcome.exitCode);
      }
      if (syncOutcome.warning) {
        console.warn(syncOutcome.warning);
      }

      const sourceRecordPath = writeVkAgentsManifestSource(agentsDir);
      console.log(`vk-agents 展開元を記録しました → ${sourceRecordPath}`);
      break;
    }
    case 'setup-terminals': {
      // VK Terminals を明示的に導入する。optionalDependencies はビルド失敗でも
      // npm が exit 0 を返して黙って除外するため、通常の `npm install` だと
      // 「入ったつもりで入っていない」状態に気づけない。ここではビルドログを
      // 表示（--foreground-scripts）したうえで、実際に解決できるかで成否を判定する。
      const { spawnSync } = await import('child_process');
      const { resolveVkTerminalsDir } = await import('../src/config.js');
      const repoRoot = resolve(__dirname, '..');

      if (process.platform !== 'darwin') {
        console.warn(
          `⚠ 現在のプラットフォームは ${process.platform} です。VK Terminals(GUI) は node-pty /\n` +
          `  electron のネイティブビルドを伴い macOS 専用です。macOS 以外では GUI を起動できません。\n` +
          `  別マシンの VK Terminals API を叩く構成（VK_TERMINALS_HOST 指定 + start）なら導入は不要です。\n`
        );
      }

      console.log('VK Terminals を導入します（ビルドログを表示します）...\n');
      spawnSync('npm', ['install', '--foreground-scripts', '--include=optional'], {
        cwd: repoRoot,
        stdio: 'inherit',
      });

      try {
        const dir = resolveVkTerminalsDir();
        console.log(`\n✅ VK Terminals を導入しました → ${dir}`);
      } catch {
        console.error(
          '\n❌ VK Terminals の導入に失敗しました（optional 依存のビルドが失敗し除外されています）。\n' +
          '   上のビルドログのエラーを確認してください。よくある原因:\n' +
          (process.platform === 'darwin'
            ? '   - Xcode Command Line Tools 未導入 → `xcode-select --install` を実行して再試行\n'
            : `   - macOS 以外のため node-pty / electron をビルドできない（GUI は macOS のみ対応）\n`) +
          '   - C/C++ ビルドツール不足、または clone 時のネットワークエラー'
        );
        process.exit(1);
      }
      break;
    }
    default:
      console.log(`vk-orchestrator <command>

commands:
  up [--no-orchestrator]                config.json を反映し VK Terminals(GUI) と orchestrator を起動
                                        （--no-orchestrator で GUI のみ起動）
  start [--once] [--assignee <login>]   キューを監視して実行（--once で 1 周のみ）
  doctor [--json]                       初回セットアップの充足状況を診断（✅/❌ と次にやるコマンド。--json で要件配列を出力）
  update [--check] [--json] [--yes]     新しい版があるかを確認し、あれば切り替える
                                        （--check は確認のみで何も変更しない。切り替えはアプリを終了してから実行）
  update --apply --from <展開先> --target <入れ替え先>
                                        内部用。展開先から起動されて入れ替えだけを行う（手動実行は不要。
                                        展開先の記録と一致する組み合わせでなければ実行しません）
  check-status                          現在のキュー／pane 状態を表示
  unblock                               waiting-input の issue を status:ready に戻す
  task add|list|set-status              queue.backend: local 専用の純ローカルタスク操作
  apply                                 vk-agents 共通設定を正本 config と Claude 派生設定へ反映
  setup-agents                          同梱 vk-agents-public から skills/rules を ~/.claude へ展開
  setup-terminals                       VK Terminals を（ビルドログ付きで）明示的に導入し導入結果を検証
`);
      process.exit(sub ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(formatErrorSummary(err));
  process.exit(1);
});
