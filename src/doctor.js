// 初回セットアップ充足判定（doctor）。
//
// 単一の setupCompleted フラグは持たず、要件チェックリストを「実状態」から毎回計算して返す
// （手編集・再インストールでフラグと実態がズレないようにするため。isVkAgentsSetup と同じ思想）。
//
// 検知ロジックはここ（コード側）に単一ソースで持ち、SKILL.md（会話セットアップ）と
// bin の up 案内は、この doctor の結果を読むだけにする。
//
// doctor はローカル高速判定に限定し、ネットワーク検知（ラベル存在確認など）はしない。
// gh 認証だけは `gh auth token`（execFileSync 注入可）で確認する。
//
// required は固定値ではなく、選択中のモードから計算する。モードは 2 軸ある:
//
// 1) キューの保存先（queue.backend）
//   - GitHub モード: gh 認証 / github.owner / github.repo / orchestrator.assigneeFilter /
//                    org.allowed_owners(owner を含む) を required にする。
//   - ローカルモード: それらは任意。必須は Node / プラットフォーム / 実行面モードの前提 /
//                    vk-agents 展開 / queue.backend / org.allowed_owners。
//
// 2) 実行面モード（terminals.mode）
//   - vk-terminals モード: VK Terminals 導入を required にする（GUI 前提。platform の
//                          label / hint も GUI 前提の文言）。tmux 要件は出さない。
//   - tmux モード: GUI を一切起動しないので VK Terminals 導入は任意（required: false）。
//                  代わりに tmux コマンドの導入を required にし、platform は GUI 非依存の
//                  文言（コンテナ環境でも可）に差し替える。

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { execFileSync as realExecFileSync } from 'child_process';
import {
  resolveConfigPath,
  loadUnifiedConfig,
  getQueueBackend,
  resolveVkTerminalsDir as realResolveVkTerminalsDir,
  resolveTerminalsMode,
  isVkAgentsSetup,
  vkAgentsSkillsManifestPath,
  resolveVkAgentsCanonicalConfigPath,
  getGitHubTokenFromGh,
} from './config.js';

const DEFAULT_OWNER = 'vektor-inc';
const DEFAULT_REPO = 'task-queue';

function getPath(obj, path) {
  return path.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

function hasNonEmpty(obj, path) {
  const value = getPath(obj, path);
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/**
 * vk-agents 正本 config（保存先 C）から org.allowed_owners を読み出す。
 * 読めない・未設定なら空配列を返す（ok 判定は false 側に倒れる）。
 * @param {string} canonicalConfigPath
 * @returns {string[]}
 */
function readAllowedOwners(canonicalConfigPath) {
  if (!canonicalConfigPath || !existsSync(canonicalConfigPath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(canonicalConfigPath, 'utf8'));
  } catch {
    return [];
  }
  const list = parsed?.org?.allowed_owners;
  if (!Array.isArray(list)) return [];
  return list.map((item) => String(item ?? '').trim()).filter((item) => item !== '');
}

/**
 * tmux コマンドのバージョン文字列（例: "tmux 3.4"）を返す。
 * 未導入なら execFileSync が throw するので、呼び出し側で未導入扱いにする。
 *
 * gh 認証用の options.execFileSync とは分けた専用フックにしている（execFileSync を
 * 共用すると、引数を見ないフェイクで「tmux 常に導入済み」に倒れてテストが書けない）。
 * @returns {string}
 */
function realResolveTmuxVersion() {
  return String(
    realExecFileSync('tmux', ['-V'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000, // doctor はローカル高速判定。ハングで固まらせない（timeout は throw → 未導入扱い）
      maxBuffer: 64 * 1024, // 想定は "tmux 3.4" 程度。異常な巨大出力は throw させる
    }) ?? '',
  ).trim();
}

/**
 * 要件チェックリストを実状態から計算して返す。
 *
 * 依存注入でテスト可能にするため、副作用のある入力（fs / gh / platform / node / config パス）は
 * すべて options で差し替えられる。
 * @param {{
 *   homeDir?: string,
 *   configPath?: string,
 *   config?: object,
 *   queueBackend?: 'github'|'local',
 *   terminalsMode?: 'vk-terminals'|'tmux',
 *   manifestPath?: string,
 *   canonicalConfigPath?: string,
 *   execFileSync?: Function,
 *   resolveVkTerminalsDir?: () => string,
 *   resolveTmuxVersion?: () => string,
 *   platform?: string,
 *   nodeVersion?: string,
 * }} [options]
 * @returns {Array<{ id:string, group:string, label:string, required:boolean, ok:boolean, current:string, hint:string, target:'A'|'B'|'C'|'external'|'manifest' }>}
 */
export function runDoctor(options = {}) {
  const homeDir = options.homeDir ?? homedir();
  const configPath = options.configPath ?? resolveConfigPath();
  const cfg = options.config ?? loadUnifiedConfig(configPath);
  const backend = options.queueBackend ?? getQueueBackend(cfg);
  const githubMode = backend === 'github';
  const terminalsMode = options.terminalsMode ?? resolveTerminalsMode(cfg);
  const tmuxMode = terminalsMode === 'tmux';
  const platform = options.platform ?? process.platform;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const manifestPath = options.manifestPath ?? vkAgentsSkillsManifestPath(homeDir);
  const canonicalConfigPath =
    options.canonicalConfigPath ?? resolveVkAgentsCanonicalConfigPath(cfg, { homeDir });
  const execFileSyncImpl = options.execFileSync ?? realExecFileSync;
  const resolveVkTerminals = options.resolveVkTerminalsDir ?? realResolveVkTerminalsDir;
  const resolveTmuxVersion = options.resolveTmuxVersion ?? realResolveTmuxVersion;

  const requirements = [];

  // 0-1 Node.js 20+
  const nodeMajor = Number(String(nodeVersion).split('.')[0]);
  requirements.push({
    id: 'node',
    group: '前提',
    label: 'Node.js 20 以上',
    required: true,
    target: 'external',
    ok: Number.isFinite(nodeMajor) && nodeMajor >= 20,
    current: `v${nodeVersion}`,
    hint: 'Node.js 20 以上をインストールしてください（例: nvm install 20 / brew install node）。',
  });

  // 0-2 プラットフォーム（実行面モードで文言が変わる。tmux モードは GUI 非依存）
  const platformOk = platform === 'darwin' || platform === 'linux';
  requirements.push({
    id: 'platform',
    group: '前提',
    label: tmuxMode ? '対応プラットフォーム（macOS / Linux）' : '対応プラットフォーム（macOS / WSL2）',
    required: true,
    target: 'external',
    ok: platformOk,
    current: platform,
    hint: tmuxMode
      ? 'tmux モードは GUI を起動しないため、macOS / Linux（コンテナ・SSH 先・WSL2 を含む）であれば動作します。'
      : platform === 'darwin'
        ? 'macOS では VK Terminals(GUI) をそのまま起動できます。'
        : 'macOS または WSL2(WSLg) 上の Ubuntu で GUI を起動できます。それ以外の環境では別マシンの VK Terminals API を使う構成（~/.vk-terminals/config.json の apiHost + `vk-orchestrator start`）を検討してください。',
  });

  // terminals.mode（実行面のモード選択。以降の required がこの値で変わる）
  // ※ 他の項目に付いている 0-x / 2-x は SKILL.md のヒアリング順の ID で、配列の順番ではない。
  //    実行面モード関連はヒアリング項目に無いため番号を振らない。
  requirements.push({
    id: 'terminals.mode',
    group: '前提',
    label: '実行面モード（モード選択）',
    required: true,
    target: 'A',
    ok: true, // 既定 vk-terminals が常に解決されるため、選択自体は常に充足。以降の required はこの値で変わる。
    current: tmuxMode ? 'tmux' : 'vk-terminals（既定）',
    hint: 'config.json の terminals.mode で vk-terminals（既定・GUI）/ tmux を選べます。以降の必須項目はこのモードで変わります。',
  });

  // 0-4 VK Terminals 導入（vk-terminals モードで必須。tmux モードは GUI を使わないので任意）
  let vkTerminalsOk = false;
  let vkTerminalsDir = '';
  try {
    vkTerminalsDir = resolveVkTerminals();
    vkTerminalsOk = Boolean(vkTerminalsDir);
  } catch {
    vkTerminalsOk = false;
  }
  requirements.push({
    id: 'vk-terminals',
    group: '前提',
    label: 'VK Terminals 導入',
    required: !tmuxMode,
    target: 'external',
    ok: vkTerminalsOk,
    current: vkTerminalsOk ? vkTerminalsDir : '未導入',
    hint: tmuxMode
      ? 'tmux モードでは VK Terminals(GUI) は不要です（vk-terminals モードに切り替えるときだけ `npm run setup:terminals` で導入してください）。'
      : '`npm run setup:terminals` で導入してください（GUI は macOS 専用。非対応 OS では別マシンの VK Terminals API を使う構成を利用）。',
  });

  // tmux コマンド導入（tmux モードのみ。vk-terminals モードでは行自体を出さない）
  if (tmuxMode) {
    let tmuxVersion = '';
    try {
      // 外部コマンドの stdout をそのままレポート／--json に載せない。
      // 先頭行のみ・ANSI エスケープと制御文字を除去・長さを制限する（想定値は "tmux 3.4" 程度）。
      // 改行入りの値でレポートの行構造が崩れ、偽の ✅/❌ 行を混ぜ込めるのを防ぐ。
      tmuxVersion = String(resolveTmuxVersion() ?? '')
        .split('\n')[0]
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '') // ANSI CSI シーケンス
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, '') // C0/C1 制御文字
        .trim()
        .slice(0, 64);
    } catch {
      tmuxVersion = '';
    }
    const tmuxOk = tmuxVersion !== '';
    requirements.push({
      id: 'tmux',
      group: '前提',
      label: 'tmux コマンド導入',
      required: true,
      target: 'external',
      ok: tmuxOk,
      current: tmuxOk ? tmuxVersion : '未導入',
      hint: 'tmux をインストールしてください（例: `brew install tmux` / Ubuntu は `sudo apt install tmux`）。',
    });
  }

  // 0-5 vk-agents スキル展開
  const agentsSetupOk = isVkAgentsSetup({ manifestPath, homeDir });
  requirements.push({
    id: 'vk-agents-setup',
    group: '前提',
    label: 'vk-agents スキル展開',
    required: true,
    target: 'manifest',
    ok: agentsSetupOk,
    current: agentsSetupOk ? '展開済み' : '未展開',
    hint: '`npm run setup:agents` で skills/rules を ~/.claude へ展開してください（未展開だと /vk-kore が存在しません）。',
  });

  // 1-1 queue.backend（モード選択）
  requirements.push({
    id: 'queue.backend',
    group: 'オーケストレーター',
    label: 'キューの保存先（モード選択）',
    required: true,
    target: 'A',
    ok: true, // 既定 local が常に解決されるため、選択自体は常に充足。以降の required はこの値で変わる。
    current: githubMode ? 'GitHub' : 'ローカル（既定）',
    hint: 'config.json の queue.backend でローカル（既定）/ GitHub を選べます。以降の必須項目はこのモードで変わります。',
  });

  // 0-3 gh 認証（GitHub モードで必須）
  let ghAuthOk = false;
  try {
    ghAuthOk = Boolean(getGitHubTokenFromGh(execFileSyncImpl));
  } catch {
    ghAuthOk = false;
  }
  requirements.push({
    id: 'gh-auth',
    group: 'GitHub',
    label: 'GitHub CLI 認証（gh auth token）',
    required: githubMode,
    target: 'external',
    ok: ghAuthOk,
    current: ghAuthOk ? '認証済み' : '未認証',
    hint: '`gh auth login` で認証してください（gh 未導入なら `brew install gh` / Ubuntu は `sudo apt install gh`）。',
  });

  // 2-1 github.owner（GitHub モードで必須。既定 vektor-inc のままは危険）
  const ownerSet = hasNonEmpty(cfg, 'github.owner');
  const owner = ownerSet ? String(getPath(cfg, 'github.owner')).trim() : DEFAULT_OWNER;
  requirements.push({
    id: 'github.owner',
    group: 'GitHub',
    label: 'GitHub オーナー（github.owner）',
    required: githubMode,
    target: 'A',
    ok: ownerSet,
    current: ownerSet ? owner : `（未設定・既定 ${DEFAULT_OWNER}）`,
    hint: 'config.json の github.owner に自分のユーザー／組織名を設定してください（既定 vektor-inc のままだと他組織のキューを見に行きます）。',
  });

  // 2-2 github.repo（GitHub モードのみ。既定 task-queue で可）
  const repoSet = hasNonEmpty(cfg, 'github.repo');
  const repo = repoSet ? String(getPath(cfg, 'github.repo')).trim() : DEFAULT_REPO;
  requirements.push({
    id: 'github.repo',
    group: 'GitHub',
    label: 'タスク登録リポジトリ名（github.repo）',
    required: githubMode,
    target: 'A',
    // 既定 task-queue も有効な値なので、名前が解決できていれば ok（実在確認はネットワーク検知のため行わない）。
    ok: true,
    current: repoSet ? repo : `${DEFAULT_REPO}（既定）`,
    hint: 'config.json の github.repo に task-queue の Issue を登録するリポジトリ名を設定してください（既定 task-queue で可）。',
  });

  // 2-5 orchestrator.assigneeFilter（GitHub モードで必須。空＝一切取り込まない）
  const assigneeSet = hasNonEmpty(cfg, 'orchestrator.assigneeFilter');
  requirements.push({
    id: 'orchestrator.assigneeFilter',
    group: 'GitHub',
    label: '担当者フィルタ（orchestrator.assigneeFilter）',
    required: githubMode,
    target: 'A',
    ok: assigneeSet,
    current: assigneeSet ? String(getPath(cfg, 'orchestrator.assigneeFilter')).trim() : '（未設定・一切取り込まない）',
    hint: 'config.json の orchestrator.assigneeFilter に GitHub ログイン名（自分だけなら自分の login）か all を設定してください（空＝一切取り込まない安全側既定）。',
  });

  // 3-1 org.allowed_owners に owner を含める（両モードで必須。硬ゲート通過用）
  const allowedOwners = readAllowedOwners(canonicalConfigPath);
  const allowedOwnersOk = allowedOwners.includes(owner);
  requirements.push({
    id: 'org.allowed_owners',
    group: 'vk-agents',
    label: `org.allowed_owners に "${owner}" を含む`,
    required: true,
    target: 'C',
    ok: allowedOwnersOk,
    current: allowedOwners.length ? allowedOwners.join(', ') : '（未設定）',
    hint: `vk-agents 正本 config の org.allowed_owners に "${owner}" を追加してください（値を A の config.json に入れてから \`vk-orchestrator apply\` で投影。未追加だと staff 系スキル／vk-kore の硬ゲートで弾かれます）。`,
  });

  return requirements;
}

/**
 * 要件配列を要約する。
 * @param {ReturnType<typeof runDoctor>} requirements
 * @returns {{ total:number, okCount:number, requiredCount:number, requiredOkCount:number, missingRequired:Array, allRequiredOk:boolean }}
 */
export function summarizeDoctor(requirements) {
  const required = requirements.filter((r) => r.required);
  const missingRequired = required.filter((r) => !r.ok);
  return {
    total: requirements.length,
    okCount: requirements.filter((r) => r.ok).length,
    requiredCount: required.length,
    requiredOkCount: required.filter((r) => r.ok).length,
    missingRequired,
    allRequiredOk: missingRequired.length === 0,
  };
}

/**
 * 人間可読の診断レポート（✅/❌/⚠️ と次にやること）を組み立てる。
 * @param {ReturnType<typeof runDoctor>} requirements
 * @param {ReturnType<typeof summarizeDoctor>} [summary]
 * @returns {string}
 */
export function formatDoctorReport(requirements, summary = summarizeDoctor(requirements)) {
  const lines = [];
  lines.push('VK Orchestrator セットアップ診断');
  lines.push('');

  let currentGroup = null;
  for (const r of requirements) {
    if (r.group !== currentGroup) {
      currentGroup = r.group;
      lines.push(`[${currentGroup}]`);
    }
    const mark = r.ok ? '✅' : r.required ? '❌' : '⚠️';
    const kind = r.required ? '必須' : '任意';
    lines.push(`  ${mark} ${r.label}（${kind}） … ${r.current}`);
  }

  lines.push('');
  if (summary.allRequiredOk) {
    lines.push(`✅ 必須項目はすべて充足しています（${summary.requiredOkCount}/${summary.requiredCount}）。`);
    lines.push('   `vk-orchestrator up` で起動できます。');
  } else {
    lines.push(`❌ 未充足の必須項目が ${summary.missingRequired.length} 件あります。次のことをしてください:`);
    for (const r of summary.missingRequired) {
      lines.push(`  - ${r.label}: ${r.hint}`);
    }
    lines.push('');
    lines.push('Claude Code でこのリポジトリを開き `/vk-orchestrator-setup` を実行すると、対話でまとめてセットアップできます。');
  }

  return lines.join('\n');
}
