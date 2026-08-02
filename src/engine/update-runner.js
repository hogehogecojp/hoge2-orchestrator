/**
 * アップデートの実行（副作用側）。
 *
 * 判断はすべて純粋関数（update-channel.js / update-manifest.js / update-apply.js /
 * self-update.js / update-messages.js）に置き、このファイルはネットワーク・fs・
 * 子プロセスの操作だけを担う。
 *
 * 実行できる場所（静止点）を厳しく限定している:
 *   (a) `up` の最初（GUI も engine もまだ動いていない位置）
 *   (b) 明示的な `vk-orchestrator update`（GUI が応答しないこと＋起動ロックが空いていることを確認）
 *
 * 走行中に入れ替えてはいけない理由は 2 つある。
 *   1. bin/vk-orchestrator.js は必要になった時点でモジュールを読み込む（遅延読み込み）ため、
 *      走行中に中身が入れ替わると古いプロセスが新旧混在のコードを読み込む。
 *   2. POSIX の rename はディレクトリでも働くが、そのディレクトリで動いているプロセスは
 *      古い実体を掴み続ける（＝走っている GUI は古いコードのまま動き続ける）。
 *
 * 入れ替えそのものは「新しい側から起動したプロセス」が行う（自分自身が乗っている
 * ディレクトリを自分で差し替えない）。`update --apply` がそのための内部モードで、
 * 展開先の bin から起動されて rename 2 回を実行し、そのまま元の起動処理へ戻す。
 */

import { createHash } from 'crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { execFile, spawnSync } from 'child_process';
import { basename, dirname, join, resolve } from 'path';
import { tmpdir } from 'os';

import {
  getUpdateConfig,
  loadUnifiedConfig,
  updateStatePath,
  updateWorkDir,
  writeJsonAtomic,
} from '../config.js';
import { RELEASE_MARKER_FILENAME, resolveUpdateChannel } from './update-channel.js';
import {
  evaluateUpgradePath,
  parseUpdateManifest,
  resolveDownloadTarget,
} from './update-manifest.js';
import {
  PRESERVED_RELATIVE_PATHS,
  STAGE_TARGET_FILENAME,
  STAGING_DIR_PREFIX,
  backupDirFor,
  computePreservedPaths,
  evaluateUpdateBlockers,
  planSwap,
  recoverInterruptedUpdate,
  stagingDirFor,
  validateUpdateJournalPaths,
} from './update-apply.js';
import { orchestratorUpdateDecision } from './self-update.js';
// Windows では npm が .cmd シムのため spawn では起動できない。解決はここへ寄せる。
import { resolveNpmLauncher } from '../platform/external-commands.js';
import { formatVersionLine, selectUpdateNotice } from './update-messages.js';
import {
  FETCH_TAGS_TIMEOUT_MS,
  NON_INTERACTIVE_GIT_ENV,
  latestSemverTag,
  parseLsRemoteTags,
} from '../../scripts/vk-terminals-tags.mjs';

/** 更新情報ファイルの取得に許す待ち時間。起動処理を長く止めない。 */
export const MANIFEST_FETCH_TIMEOUT_MS = 10_000;
/** 配布 zip の取得に許す待ち時間。1.4MB 程度なので十分。 */
export const DOWNLOAD_TIMEOUT_MS = 120_000;
/**
 * 受け取ってよい本文の絶対上限。
 * 配布 zip は 1.5MB 程度で、更新情報ファイルはさらに小さい。上限が無いと、
 * 配布元が巨大な応答を返したときにそのままメモリへ載せてしまう。
 */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/** 更新情報ファイル（JSON）の上限。 */
export const MAX_MANIFEST_BYTES = 1024 * 1024;
/** 追う転送先（リダイレクト）の上限ホップ数。 */
export const MAX_REDIRECT_HOPS = 5;

// ---------------------------------------------------------------------------
// 作業記録（~/.vk-orchestrator/update-state.json）
// ---------------------------------------------------------------------------

/**
 * 作業記録を読む。無ければ空オブジェクト。壊れていても起動を止めない。
 * @param {{ statePath?: string }} [options]
 * @returns {object}
 */
export function readUpdateState({ statePath = updateStatePath() } = {}) {
  if (!existsSync(statePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 作業記録を更新する（既存の内容へ差分マージ）。
 *
 * 既知の境界（今は直していない）: 記録はホーム配下の 1 ファイルを共有するため、
 * 同じユーザーがインストールを 2 本使っていると入れ替えの記録も共有される。
 * A の入れ替えが中断した記録が残っているあいだに B が更新を完走すると、
 * A の復旧材料が B の値で上書きされる。A の中断窓は rename 2 回ぶん（ミリ秒）で、
 * かつインストール 2 本の併用が前提なので、実際に踏む可能性は低いと判断した。
 * 直すなら記録をインストールごとのファイルへ分け、鍵は updateLockPathFor と同じ
 * 同一性表現から作ればよい（ロックと記録で鍵の作り方が揃う）。
 *
 * @param {object} patch
 * @param {{ statePath?: string }} [options]
 * @returns {object} 書き込んだ内容
 */
export function writeUpdateState(patch, { statePath = updateStatePath() } = {}) {
  const next = { ...readUpdateState({ statePath }), ...patch };
  writeJsonAtomic(statePath, next);
  return next;
}

/**
 * 確認結果を作業記録へ残す。
 *
 * 設定画面（設定ディスクリプタの組み立て）とサイドバーは、この記録を読んで表示する。
 * どちらも同期処理でネットワークに出られないため、確認した側が残しておく必要がある。
 * @param {object} report runUpdateCheck の戻り値
 * @param {{ statePath?: string }} [options]
 * @returns {object}
 */
export function saveUpdateSnapshot(report, { statePath = updateStatePath() } = {}) {
  return writeUpdateState(
    {
      lastReport: {
        channel: report.channel,
        current: report.current ?? null,
        latest: report.latest ?? null,
        updateAvailable: report.updateAvailable === true,
        decision: report.decision ?? null,
        notice: report.notice ?? null,
        summary: report.summary ?? '',
        checkFailed: report.checkFailed === true,
        autoUpdate: report.autoUpdate !== false,
        branch: report.branch ?? null,
        changelogUrl: report.manifest?.changelogUrl ?? null,
        bundled: report.manifest?.bundled ?? null,
        savedAt: new Date().toISOString(),
      },
    },
    { statePath }
  );
}

/**
 * アップデート直後の起動で、確認結果の記録を通信せずに現状へ合わせる。
 *
 * 更新後の再起動では版確認そのものをスキップする（多重更新を防ぐため）。そのままだと
 * 記録は更新前のままなので、切り替え直後に設定画面を開くと「お使いの版」に旧版が出る。
 * 利用者の信頼が一番揺らぐ瞬間なので、通信の要る部分（最新版が何か）は次の確認に任せ、
 * ローカルで分かること（今の版・新しい版は無い・お知らせ無し）だけをここで直す。
 *
 * @param {{ repoRoot: string, statePath?: string, now?: Date }} input
 * @returns {object|null} 更新した記録。記録が無ければ null（作らない）
 */
export function refreshSnapshotAfterUpdate({ repoRoot, statePath = updateStatePath(), now = new Date() }) {
  const state = readUpdateState({ statePath });
  const previous = state.lastReport;
  if (!previous || typeof previous !== 'object') return null;

  const current = readInstalledVersion(repoRoot);
  if (!current) return null;

  const lastReport = {
    ...previous,
    current,
    // 切り替えた直後なので「新しい版がある」状態ではない。最新版が本当に何かは次の確認で埋まる。
    latest: current,
    updateAvailable: false,
    decision: { action: 'skip', reason: 'up-to-date' },
    notice: null,
    checkFailed: false,
    summary: formatVersionLine({
      current,
      latest: current,
      updateAvailable: false,
      lastCheckedAt: state.lastCheckedAt ?? null,
    }),
    savedAt: now.toISOString(),
  };
  return writeUpdateState({ lastReport }, { statePath });
}

// ---------------------------------------------------------------------------
// 環境の測定（純粋関数へ渡す入力を作る）
// ---------------------------------------------------------------------------

/**
 * インストールディレクトリの実状態から入手経路を判定する。
 * @param {string} repoRoot
 * @param {{ env?: object, spawnSyncImpl?: Function }} [options]
 * @returns {{ channel:string, reason:string }}
 */
export function detectUpdateChannel(repoRoot, { env = process.env, spawnSyncImpl = spawnSync } = {}) {
  const hasReleaseMarker = existsSync(join(repoRoot, RELEASE_MARKER_FILENAME));
  const hasGitDir = existsSync(join(repoRoot, '.git'));

  let gitToplevel = null;
  if (hasGitDir) {
    const r = spawnSyncImpl('git', ['rev-parse', '--show-toplevel'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (r.status === 0) gitToplevel = String(r.stdout ?? '').trim() || null;
  }

  // git は実体パス（シンボリックリンクを解決した後のパス）を返すため、比較側も実体パスに寄せる。
  // ここを揃えないと、シンボリックリンク経由で起動しただけで「別ディレクトリ」と判定されてしまう。
  let realRoot = repoRoot;
  try {
    realRoot = realpathSync(repoRoot);
  } catch {
    // 解決できなければそのまま比較する（不一致なら unknown に倒れる＝安全側）。
  }

  return resolveUpdateChannel({
    envChannel: env.VK_ORCHESTRATOR_UPDATE_CHANNEL ?? null,
    hasReleaseMarker,
    hasGitDir,
    gitToplevel,
    repoRoot: realRoot,
  });
}

// ---------------------------------------------------------------------------
// 更新情報ファイルの取得
// ---------------------------------------------------------------------------

/**
 * URL のホストと scheme が受理条件（https のみ・許可ホストと完全一致）を満たすかを見る。
 * @param {string} url
 * @param {string[]} allowedHosts
 * @returns {{ ok:true, url:URL } | { ok:false, code:string, message:string }}
 */
export function checkUrlAllowed(url, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: 'url-invalid', message: `URL を解釈できません（${url}）。` };
  }
  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'insecure-scheme',
      message: `https 以外では取得しません（${parsed.protocol.replace(':', '')}）。`,
    };
  }
  const hosts = (Array.isArray(allowedHosts) ? allowedHosts : [])
    .map((h) => String(h ?? '').trim().toLowerCase())
    .filter((h) => h !== '');
  if (!hosts.includes(parsed.hostname.toLowerCase())) {
    return {
      ok: false,
      code: 'host-not-allowed',
      message: `許可していないホストからは取得しません（${parsed.hostname}）。`,
    };
  }
  return { ok: true, url: parsed };
}

/**
 * 転送先（リダイレクト）を 1 ホップずつ検証しながら取得する。
 *
 * fetch の既定は転送先を自動で追うため、配布元が 302 を返すだけで任意のホスト（http を含む）
 * へ取得が飛ぶ。それでは「更新情報ファイルが指す任意のホストへ取りに行かない」という
 * 受理条件が最初の 1 ホップにしか効かない。そこで自動追従を切り、各ホップを同じ条件で
 * 検証してから次へ進む。
 *
 * @param {string} initialUrl
 * @param {{ allowedHosts: string[], fetchImpl?: Function, timeoutMs: number, maxHops?: number }} options
 * @returns {Promise<{ ok:true, response:object, url:string } | { ok:false, code:string, message:string }>}
 */
export async function fetchWithHostAllowList(initialUrl, {
  allowedHosts,
  fetchImpl = null,
  timeoutMs,
  maxHops = MAX_REDIRECT_HOPS,
} = {}) {
  const doFetch = fetchImpl ?? global.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, code: 'fetch-unavailable', message: 'このランタイムには fetch がありません。' };
  }

  // 待ち時間の期限は「全体で 1 つ」にする。ホップごとに張り直すと、転送を挟むだけで
  // 合計の待ち時間が上限の回数倍（既定なら 6 倍）まで伸び、起動処理を長く止めてしまう。
  const signal = AbortSignal.timeout(timeoutMs);

  let current = initialUrl;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    const allowed = checkUrlAllowed(current, allowedHosts);
    if (!allowed.ok) return allowed;

    let response;
    try {
      response = await doFetch(allowed.url.toString(), {
        signal,
        // 自動追従を切る。追従したあとでは、どのホストから受け取ったのかを検証できない。
        redirect: 'manual',
      });
    } catch (err) {
      return { ok: false, code: 'network-error', message: `取得できませんでした: ${err?.message ?? err}` };
    }

    const status = Number(response?.status ?? 0);
    const isRedirect = status >= 300 && status < 400;
    if (!isRedirect) {
      if (response?.ok === false) {
        return { ok: false, code: 'http-error', message: `取得に失敗しました（HTTP ${status}）。` };
      }
      return { ok: true, response, url: allowed.url.toString() };
    }

    const location = response.headers?.get?.('location');
    if (!location) {
      return { ok: false, code: 'redirect-invalid', message: `転送先が示されていません（HTTP ${status}）。` };
    }
    // 相対指定の Location も解決してから、次のループで改めて検証する。
    current = new URL(location, allowed.url).toString();
  }

  return { ok: false, code: 'too-many-redirects', message: '転送が多すぎます。' };
}

/**
 * 応答本文をバイト列として読む。上限を超えた時点で打ち切る。
 * @param {object} response
 * @param {number} maxBytes
 * @param {number|null} [expectedBytes] 更新情報ファイルが宣言しているサイズ
 * @returns {Promise<{ ok:true, buffer:Buffer } | { ok:false, code:string, message:string }>}
 */
export async function readBodyWithLimit(response, maxBytes, expectedBytes = null) {
  // 上限は「更新情報ファイルが宣言する大きさ＋少しの余裕」。宣言が無ければ絶対上限。
  const limit = expectedBytes !== null
    ? Math.min(Math.ceil(expectedBytes * 1.1) + 1024, maxBytes)
    : maxBytes;

  // Content-Length は「読み始める前に弾けるかどうか」の材料としてだけ使い、
  // 宣言サイズとの厳密一致は求めない。転送時に圧縮が掛かる構成では Content-Length が
  // 圧縮後の値になるため、一致を要求すると更新が丸ごと止まってしまう。
  // 中身が本当に同じかどうかは sha256 の照合が保証する。
  const declared = Number(response?.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    return {
      ok: false,
      code: 'too-large',
      message: `受け取れる大きさを超えています（${declared} バイト、上限 ${limit} バイト）。`,
    };
  }

  // 本文を少しずつ読み、上限を超えた時点で捨てる（全部メモリに載せてから測らない）。
  const body = response?.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel?.();
          return { ok: false, code: 'too-large', message: `受け取れる大きさを超えています（${limit} バイト超）。` };
        }
        chunks.push(Buffer.from(value));
      }
    } catch (err) {
      return { ok: false, code: 'network-error', message: `受信中に切断されました: ${err?.message ?? err}` };
    }
    return { ok: true, buffer: Buffer.concat(chunks) };
  }

  // ストリームを持たない応答（テストの差し替え等）は一括で受け取り、受け取った量で判定する。
  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > limit) {
      return { ok: false, code: 'too-large', message: `受け取れる大きさを超えています（${buffer.byteLength} バイト）。` };
    }
    return { ok: true, buffer };
  } catch (err) {
    return { ok: false, code: 'network-error', message: `本文を読めませんでした: ${err?.message ?? err}` };
  }
}

/**
 * 更新情報ファイルを取得して検証する。
 *
 * ネットワークの失敗（オフライン・配布元が落ちている）は例外にせず、
 * 判別できるコードで返す（呼び出し側は現行版のまま起動を続けるため）。
 * 取得先とその転送先は、配布 zip と同じ受理条件（https のみ・許可ホストと完全一致）で検証する。
 *
 * @param {string} url
 * @param {{ fetchImpl?: Function, timeoutMs?: number, allowedHosts?: string[] }} [options]
 * @returns {Promise<{ ok:true, manifest:object } | { ok:false, code:string, message:string }>}
 */
export async function fetchUpdateManifest(url, {
  fetchImpl = null,
  timeoutMs = MANIFEST_FETCH_TIMEOUT_MS,
  allowedHosts = [],
} = {}) {
  const fetched = await fetchWithHostAllowList(url, { allowedHosts, fetchImpl, timeoutMs });
  if (!fetched.ok) {
    return {
      ok: false,
      code: fetched.code,
      message: `更新情報ファイルを取得できませんでした: ${fetched.message}`,
    };
  }

  const body = await readBodyWithLimit(fetched.response, MAX_MANIFEST_BYTES);
  if (!body.ok) {
    return { ok: false, code: body.code, message: `更新情報ファイルを読めませんでした: ${body.message}` };
  }

  let json;
  try {
    json = JSON.parse(body.buffer.toString('utf8'));
  } catch (err) {
    return {
      ok: false,
      code: 'manifest-invalid',
      message: `更新情報ファイルを JSON として読めませんでした: ${err?.message ?? err}`,
    };
  }

  return parseUpdateManifest(json);
}

// ---------------------------------------------------------------------------
// 確認（update --check / 起動時 / 常駐中の再確認で共有する）
// ---------------------------------------------------------------------------

/**
 * 新しい版があるかを確認して、表示・判断に必要な情報を 1 つのレポートに束ねる。
 *
 * 副作用は「作業記録の lastCheckedAt の更新」だけ（インストールの外なので安全）。
 * `--check` からも、起動時の自動アップデートからも、常駐中の再確認からも同じものを使う。
 *
 * @param {object} [options]
 * @returns {Promise<object>} レポート
 */
export async function runUpdateCheck({
  repoRoot,
  cfg = null,
  now = new Date(),
  fetchImpl = null,
  recordCheck = true,
  statePath = updateStatePath(),
  channel: channelOverride = null,
  dirty = null,
  branch = null,
  busy = false,
  currentVersion = null,
  nodeVersion = process.versions.node,
} = {}) {
  const config = cfg ?? loadUnifiedConfig();
  const updateConfig = getUpdateConfig(config);
  const state = readUpdateState({ statePath });

  const channelResult = channelOverride
    ? { channel: channelOverride, reason: 'caller-override' }
    : detectUpdateChannel(repoRoot);
  const channel = channelResult.channel;

  const current = currentVersion ?? readInstalledVersion(repoRoot);

  const report = {
    channel,
    channelReason: channelResult.reason,
    current,
    latest: null,
    updateAvailable: false,
    decision: { action: 'skip', reason: 'version-unresolved' },
    blockers: [],
    manifest: null,
    lastCheckedAt: state.lastCheckedAt ?? null,
    checkFailed: false,
    offline: false,
    distUnreachable: false,
    autoUpdate: updateConfig.autoUpdate,
    backupPath: state.backupPath ?? null,
    preserved: [],
    notice: null,
    summary: '',
  };

  // git チャネルはリモートタグを、zip チャネルは更新情報ファイルを見る。
  // `off` は仕組み全体を止める脱出ハッチなので、外向きの通信そのものを行わない
  // （確認だけ続けると「止めたのに配布元へ接続している」と説明が食い違う）。
  if (channel === 'off') {
    report.checkSkipped = true;
  } else if (channel === 'git') {
    const remote = await resolveLatestGitTag(repoRoot);
    report.latest = remote.latest;
    if (!remote.ok) {
      report.checkFailed = true;
      report.offline = true;
    }
  } else {
    const fetched = await fetchUpdateManifest(updateConfig.manifestUrl, {
      fetchImpl,
      allowedHosts: updateConfig.allowedHosts,
    });
    if (fetched.ok) {
      report.manifest = fetched.manifest;
      report.latest = fetched.manifest.version;
    } else {
      report.checkFailed = true;
      if (fetched.code === 'network-error' || fetched.code === 'fetch-unavailable') report.offline = true;
      else report.distUnreachable = true;
      report.manifestError = { code: fetched.code, message: fetched.message };
    }
  }

  if (!report.checkFailed && !report.checkSkipped && recordCheck) {
    try {
      writeUpdateState({ lastCheckedAt: now.toISOString() }, { statePath });
      report.lastCheckedAt = now.toISOString();
    } catch {
      // 確認時刻を残せなくても確認そのものは成立している。
    }
  }

  // 版の比較。zip では更新情報ファイル固有の条件（minUpgradableFrom / minNode）も見る。
  const gitState = channel === 'git' ? await measureGitState(repoRoot) : { dirty: false, branch: 'main' };
  const decision = orchestratorUpdateDecision({
    current,
    latest: report.latest,
    dirty: dirty ?? gitState.dirty,
    branch: branch ?? gitState.branch,
    optOut: !updateConfig.autoUpdate,
    channel,
    busy,
  });
  report.decision = decision;
  report.branch = branch ?? gitState.branch;
  report.dirty = dirty ?? gitState.dirty;

  if (report.manifest) {
    const upgrade = evaluateUpgradePath({
      manifest: report.manifest,
      current,
      nodeVersion,
    });
    // 更新情報ファイル側で止める理由（古すぎる版・Node が古い）は、
    // 版比較の結果より優先して伝える。
    if (upgrade.action === 'skip' && upgrade.reason !== 'up-to-date' && decision.action === 'update') {
      report.decision = upgrade;
    }
    if (upgrade.reason === 'manual-required') {
      report.blockers.push({
        code: 'manual-required',
        message: 'お使いの版が古すぎるため、自動では切り替えられません。',
        hint: '配布された最新の zip をダウンロードして、新しい場所へ展開し直してください。',
      });
    }
    if (upgrade.reason === 'node-too-old') {
      report.blockers.push({
        code: 'node-too-old',
        message: `新しい版は Node.js ${report.manifest.minNode} 以上が必要です（現在: ${nodeVersion}）。`,
        hint: 'Node.js を更新してから、もう一度実行してください。',
      });
    }
  }

  report.updateAvailable =
    report.latest !== null && report.decision.reason !== 'up-to-date' && report.decision.reason !== 'version-unresolved'
      ? isNewer(report.latest, current)
      : false;

  report.notice = selectUpdateNotice({
    channel,
    autoUpdate: updateConfig.autoUpdate,
    latest: report.latest,
    updateAvailable: report.updateAvailable,
    decisionReason: report.decision.reason,
    branch: report.branch,
    offline: report.offline,
    distUnreachable: report.distUnreachable,
    lastCheckedAt: report.lastCheckedAt,
    now,
  });
  report.summary = formatVersionLine({
    current,
    latest: report.latest,
    updateAvailable: report.updateAvailable,
    lastCheckedAt: report.lastCheckedAt,
    checkFailed: report.checkFailed,
  });

  return report;
}

/**
 * インストールディレクトリの package.json から現在の版を読む。
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function readInstalledVersion(repoRoot) {
  try {
    return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function isNewer(latest, current) {
  const norm = (v) => String(v ?? '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  const a = norm(latest);
  const b = norm(current);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i += 1) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
  }
  return false;
}

/** vk-orchestrator 自身のリモート（git チャネルでの版確認先）。 */
export const ORCHESTRATOR_REPO_URL = 'https://github.com/vektor-inc/vk-orchestrator.git';

/** git コマンドの待ち時間の上限（ローカル操作）。 */
const GIT_LOCAL_TIMEOUT_MS = 10_000;

/**
 * git を非同期に実行して標準出力を返す。失敗・打ち切りなら null。
 *
 * 同期実行（execFileSync / spawnSync）にすると、常駐ループから呼んだときに
 * リモート照会 15 秒＋ローカル 2 回で最悪 35 秒、タスクの起動や状態監視ごと止まる。
 * この経路は待つ理由が無いので非同期にする。
 * @param {string[]} args
 * @param {{ cwd:string, timeout:number, env?:object }} options
 * @returns {Promise<string|null>}
 */
function gitOutputAsync(args, { cwd, timeout, env = null }) {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: env ?? process.env,
      },
      (err, stdout) => resolvePromise(err ? null : String(stdout ?? '').trim())
    );
  });
}

/**
 * git チャネルでのリモート最新タグ解決（失敗しても例外にしない）。
 * 待ち時間の上限と認証プロンプト抑止は同期版（fetchTags）と同じ値を使う。
 */
async function resolveLatestGitTag(repoRoot) {
  const out = await gitOutputAsync(['ls-remote', '--tags', ORCHESTRATOR_REPO_URL], {
    cwd: repoRoot,
    timeout: FETCH_TAGS_TIMEOUT_MS,
    env: { ...process.env, ...NON_INTERACTIVE_GIT_ENV },
  });
  if (out === null) return { ok: false, latest: null };
  const latest = latestSemverTag(parseLsRemoteTags(out));
  return latest ? { ok: true, latest } : { ok: false, latest: null };
}

/** git チャネルでの作業ツリー状態（未コミット変更・ブランチ）。 */
async function measureGitState(repoRoot) {
  const [status, branch] = await Promise.all([
    gitOutputAsync(['status', '--porcelain'], { cwd: repoRoot, timeout: GIT_LOCAL_TIMEOUT_MS }),
    gitOutputAsync(['branch', '--show-current'], { cwd: repoRoot, timeout: GIT_LOCAL_TIMEOUT_MS }),
  ]);
  return {
    // 状態が読めないときは「変更あり」に倒す（分からないなら触らない）。
    dirty: status === null ? true : status !== '',
    branch: branch ?? '',
  };
}

// ---------------------------------------------------------------------------
// 実行（ダウンロード → 検証 → 入れ替え → 起動し直し）
// ---------------------------------------------------------------------------

/**
 * 配布 zip をダウンロードして sha256 を照合する。
 * @param {object} input
 * @returns {Promise<{ ok:true, zipPath:string } | { ok:false, code:string, message:string }>}
 */
export async function downloadZip({
  url,
  sha256,
  size = null,
  destDir,
  allowedHosts = [],
  fetchImpl = null,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
}) {
  const fetched = await fetchWithHostAllowList(url, { allowedHosts, fetchImpl, timeoutMs });
  if (!fetched.ok) {
    return { ok: false, code: fetched.code, message: `配布 zip を取得できませんでした: ${fetched.message}` };
  }

  // 更新情報ファイルが宣言している大きさを上限に使う（宣言が無ければ絶対上限）。
  const body = await readBodyWithLimit(fetched.response, MAX_DOWNLOAD_BYTES, size);
  if (!body.ok) {
    return { ok: false, code: body.code, message: `配布 zip を取得できませんでした: ${body.message}` };
  }

  // ディスクへ書くのは照合を通したあとだけにする（中身が確かでないファイルを残さない）。
  const actual = createHash('sha256').update(body.buffer).digest('hex');
  if (actual !== sha256) {
    return {
      ok: false,
      code: 'checksum-mismatch',
      message: `配布 zip の内容が更新情報ファイルと一致しません（期待: ${sha256}, 実際: ${actual}）。`,
    };
  }

  mkdirSync(destDir, { recursive: true });
  const zipPath = join(destDir, 'vk-orchestrator.zip');
  writeFileSync(zipPath, body.buffer);
  return { ok: true, zipPath };
}

/**
 * zip を展開する。macOS / Linux の標準コマンドを使う（Node に zip 展開は無い）。
 * @param {string} zipPath
 * @param {string} destDir
 * @returns {{ ok:true, rootDir:string } | { ok:false, code:string, message:string }}
 */
export function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  let r = spawnSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    if (process.platform === 'darwin') {
      // unzip が無い環境向けのフォールバック（macOS 標準の ditto）。
      r = spawnSync('ditto', ['-x', '-k', zipPath, destDir], { stdio: 'inherit' });
    }
    if (r.error || r.status !== 0) {
      return {
        ok: false,
        code: 'extract-failed',
        message: 'zip を展開できませんでした（unzip コマンドが必要です）。',
      };
    }
  }

  // 配布 zip は vk-orchestrator/ の 1 階層を含む。既知の形を先に見て確定させる。
  const inner = join(destDir, 'vk-orchestrator');
  if (existsSync(join(inner, 'package.json'))) return { ok: true, rootDir: inner };
  if (existsSync(join(destDir, 'package.json'))) return { ok: true, rootDir: destDir };

  // 既知の形でない場合は候補を全部数える。readdirSync の順で最初のものを採ると
  // 環境によって選ばれるディレクトリが変わりうるため、2 つ以上あればエラーにする。
  const candidates = readdirSync(destDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(destDir, e.name))
    .filter((dir) => existsSync(join(dir, 'package.json')));
  if (candidates.length === 1) return { ok: true, rootDir: candidates[0] };
  if (candidates.length > 1) {
    return {
      ok: false,
      code: 'extract-ambiguous',
      message: `展開した中に package.json を持つディレクトリが ${candidates.length} 個あり、どれを使うか決められません。`,
    };
  }
  return { ok: false, code: 'extract-invalid', message: '展開した中に package.json が見つかりませんでした。' };
}

/**
 * 展開した中身が、更新情報ファイルが名乗っている版そのものかを確かめる。
 *
 * sha256 は「その zip であること」しか保証しない。配布サーバーには版名付き zip が
 * 残り続ける設計なので、これだけだと「version は新しいと名乗り、URL と sha256 は実在の
 * 旧版を指す」更新情報ファイルで、既知の不具合を含む旧版へ落とすことが成立してしまう。
 *
 * @param {string} stagedDir
 * @param {object} manifest
 * @returns {{ ok:true } | { ok:false, code:string, message:string }}
 */
export function verifyStagedIdentity(stagedDir, manifest) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(stagedDir, 'package.json'), 'utf8'));
  } catch (err) {
    return { ok: false, code: 'staged-package-unreadable', message: `展開した package.json を読めませんでした: ${err.message}` };
  }
  if (pkg?.name !== 'vk-orchestrator') {
    return {
      ok: false,
      code: 'staged-product-mismatch',
      message: `展開した中身が VK Orchestrator ではありません（name: ${pkg?.name ?? '不明'}）。`,
    };
  }
  const norm = (v) => String(v ?? '').trim().replace(/^v/, '');
  if (norm(pkg.version) !== norm(manifest?.version)) {
    return {
      ok: false,
      code: 'staged-version-mismatch',
      message: `展開した中身の版が更新情報ファイルと一致しません（更新情報: ${manifest?.version ?? '不明'}、中身: ${pkg.version ?? '不明'}）。`,
    };
  }
  return { ok: true };
}

/**
 * 利用者の資産を展開先へ写す。
 *
 * 「展開先へ写す → 入れ替え → 旧側を backup として残す」の順にすることで、
 * 資産は常に「展開先」と「backup」の 2 か所に存在する。退避してから復元する方式は
 * 復元前に落ちると資産がインストールの外に取り残されるため採らない。
 *
 * @param {string} installDir
 * @param {string} stagedDir
 * @returns {{ preserved:string[], rejected:Array<{path:string,reason:string}> }}
 */
export function copyPreservedAssets(installDir, stagedDir) {
  const existing = [];
  for (const rel of PRESERVED_RELATIVE_PATHS) {
    const abs = join(installDir, rel);
    if (!existsSync(abs)) continue;
    let symlink = false;
    try {
      symlink = lstatSync(abs).isSymbolicLink();
    } catch {
      symlink = true; // 状態が読めないものは触らない（安全側）
    }
    existing.push({ path: rel, symlink });
  }

  const { preserved, rejected } = computePreservedPaths({ existing });
  for (const rel of preserved) {
    const from = join(installDir, rel);
    const to = join(stagedDir, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, dereference: false, force: true });
  }
  return { preserved, rejected };
}

/**
 * 展開先の依存関係（node_modules）が信頼できる状態かを判定する。
 *
 * 配布 zip には `npm ci --omit=optional` 済みの node_modules が入っており、CI でスモークも
 * 通っている。したがって通常は同梱をそのまま信頼してよく、オフラインでも完結する。
 * 信頼できないのは次の場合だけで、そのときに限り `npm ci` へフォールバックする。
 *
 *   - node_modules が入っていない（zip の作りが変わった・展開が不完全）
 *   - package-lock.json の sha256 が更新情報ファイルの lockSha256 と一致しない（改変の疑い）
 *
 * @param {string} stagedDir
 * @param {string|null} expectedLockSha256
 * @returns {{ trusted: boolean, reason: string }}
 */
export function evaluateBundledDependencies(stagedDir, expectedLockSha256) {
  if (!existsSync(join(stagedDir, 'node_modules'))) {
    return { trusted: false, reason: 'node-modules-missing' };
  }
  if (!expectedLockSha256) {
    // 照合材料が無いだけなら同梱を信頼する（オフライン完結を優先する）。
    return { trusted: true, reason: 'lock-sha256-unknown' };
  }
  let actual = null;
  try {
    actual = createHash('sha256').update(readFileSync(join(stagedDir, 'package-lock.json'))).digest('hex');
  } catch {
    return { trusted: false, reason: 'lock-unreadable' };
  }
  if (actual !== expectedLockSha256) return { trusted: false, reason: 'lock-sha256-mismatch' };
  return { trusted: true, reason: 'bundled' };
}

/**
 * 展開先で `npm ci --omit=optional` を実行する（同梱を信頼できないときのフォールバック）。
 * @param {string} stagedDir
 * @returns {{ ok:boolean, message?:string }}
 */
export function installStagedDependencies(stagedDir) {
  const npm = resolveNpmLauncher();
  const r = spawnSync(npm.command, [...npm.prefixArgs, 'ci', '--omit=optional'], {
    cwd: stagedDir,
    stdio: 'inherit',
  });
  if (r.error) {
    const detail = npm.hint ? `${r.error.message}\n  ${npm.hint}` : r.error.message;
    return { ok: false, message: `npm ci を実行できませんでした: ${detail}` };
  }
  if (r.status !== 0) return { ok: false, message: 'npm ci が失敗しました（ネットワーク接続をご確認ください）。' };
  return { ok: true };
}

/**
 * 展開先に対して doctor を実行し、起動できる状態かを確かめる（CI と同じスモーク）。
 * ここで落ちたら入れ替えず展開先を破棄する。
 * @param {string} stagedDir
 * @returns {{ ok:boolean, message?:string }}
 */
export function smokeTestStaged(stagedDir) {
  const r = spawnSync(process.execPath, [join(stagedDir, 'bin', 'vk-orchestrator.js'), 'doctor', '--json'], {
    cwd: stagedDir,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, VK_ORCHESTRATOR_UPDATE_CHANNEL: 'off' },
  });
  if (r.error) return { ok: false, message: `展開先の動作確認を実行できませんでした: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, message: '展開先の動作確認（doctor）が失敗しました。' };
  return { ok: true };
}

/**
 * 同梱の GUI（vk-terminals）を展開先へ移送する。
 *
 * 配布 zip には GUI が入っていない（npm 経由で取得する optional 依存のため）。
 * 更新情報ファイルの bundled.vkTerminals と、いま入っている GUI の版が一致するときだけ
 * 旧 node_modules/vk-terminals を移送して再ビルドを省く。一致しなければ移送せず、
 * 入れ替え後の追従処理（reconcileVkTerminalsVersion）に任せる。
 *
 * @param {object} input
 * @returns {{ moved:boolean, reason:string }}
 */
export function carryOverVkTerminals({ installDir, stagedDir, bundledVersion }) {
  const from = join(installDir, 'node_modules', 'vk-terminals');
  if (!existsSync(from)) return { moved: false, reason: 'not-installed' };
  if (!bundledVersion) return { moved: false, reason: 'bundled-version-unknown' };

  let installed = null;
  try {
    installed = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return { moved: false, reason: 'installed-version-unknown' };
  }
  const norm = (v) => String(v ?? '').trim().replace(/^v/, '');
  if (norm(installed) !== norm(bundledVersion)) return { moved: false, reason: 'version-mismatch' };

  const to = join(stagedDir, 'node_modules', 'vk-terminals');
  try {
    mkdirSync(dirname(to), { recursive: true });
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true, dereference: false });
  } catch (err) {
    return { moved: false, reason: `copy-failed: ${err.message}` };
  }
  return { moved: true, reason: 'version-match' };
}

/**
 * 手順配列（planSwap の戻り値）を実行する。
 * @param {Array<object>} steps
 * @param {{ logger?: object }} [options]
 */
export function executeSwapSteps(steps, { logger = console } = {}) {
  for (const step of steps) {
    switch (step.op) {
      case 'write-journal':
        writeJsonAtomic(step.path, step.journal);
        break;
      case 'rename':
        renameSync(step.from, step.to);
        break;
      case 'copy-dir':
        cpSync(step.from, step.to, { recursive: true, dereference: false });
        break;
      case 'remove-dir':
        rmSync(step.path, { recursive: true, force: true });
        break;
      default:
        logger.warn?.(`[update] 未知の手順を無視しました: ${step.op}`);
    }
  }
}

/**
 * 前回の入れ替えが途中で終わっていたら、続行するか巻き戻す。
 *
 * 起動時に必ず呼ぶ。何度呼んでも同じ結果になる（冪等）。
 *
 * 処理する前に、作業記録に書かれたパスが「いま動いているインストール」のものかを確かめる。
 * この処理は記録の内容を rename と再帰削除の対象にするため、検証せずに進めると
 * 別のインストール（clone 側と zip 側を併用している等）や書き換えられた記録によって
 * 無関係なディレクトリを消してしまう。
 *
 * @param {{ repoRoot?: string, statePath?: string, logger?: object, lockDir?: string, workDir?: string }} [options]
 * @returns {{ action:string, reason:string }}
 */
export function recoverPendingUpdate({
  repoRoot = null,
  statePath = updateStatePath(),
  logger = console,
  lockDir = updateWorkDir(),
  workDir = updateWorkDir(),
} = {}) {
  const state = readUpdateState({ statePath });
  if (state.phase !== 'swapping') {
    return recoverInterruptedUpdate(state.phase ? state : null);
  }

  // 記録が指すインストールが自分自身かを確認する。実体解決（シンボリックリンクの解決）まで
  // 揃えてから比較しないと、同じ場所を指していても別物と判定されてしまう。
  //
  // 復旧が必要な状況では install 自体が存在しないことがある（rename 1 回目の直後）。
  // そのため実体解決は「親ディレクトリ」に対して行い、末尾の名前を足して比較する
  // （親は必ず存在する。install そのものを realpath すると、この正当な状況で弾いてしまう）。
  const installDir = identityPath(repoRoot);
  if (installDir === null) {
    logger.warn?.('[update] 復旧対象を特定できないため、中断したアップデートの後始末を行いません。');
    return { action: 'none', reason: 'install-dir-unknown' };
  }
  const validation = validateUpdateJournalPaths({
    journal: {
      ...state,
      backupPath: identityPath(state.backupPath) ?? state.backupPath,
      stagedPath: identityPath(state.stagedPath) ?? state.stagedPath,
    },
    installDir,
    recordedInstallDir: identityPath(state.installPath),
    // 展開先を置いてよいのは「インストールの親」（validate 側が既に許可する）と、
    // 親が書けない環境での退避先の 2 通りだけ。
    allowedStagedParents: [identityPath(workDir) ?? workDir],
  });
  if (!validation.ok) {
    // 記録を消さずに残す（別のインストールが自分の記録として使う可能性があるため）。
    logger.warn?.(
      `[update] 中断したアップデートの記録が、このインストールのものと一致しないため何もしません（${validation.reason}）。`
    );
    return { action: 'none', reason: `journal-rejected: ${validation.reason}` };
  }

  // 復旧も入れ替えと同じ 3 つのパスを rename するため、更新処理と同じロックの下で行う。
  // ロックを取らないと、入れ替えの「2 回目の rename 済み・記録の確定前」という短い窓に
  // 復旧が入り込み、入れ替わったばかりの新版をどけて旧版へ戻してしまう
  //（更新側は成功として記録を確定するため、更新したつもりで旧版のまま残る）。
  const lock = acquireUpdateLock(installDir, { lockDir });
  if (!lock.ok) {
    logger.log?.('[update] ほかのアップデート処理が実行中のため、中断したアップデートの後始末は行いません。');
    return { action: 'none', reason: 'update-in-progress' };
  }

  try {
    return applyRecovery({ state, statePath, logger });
  } finally {
    lock.release();
  }
}

/** 復旧の実行部分（ロックを取得済みの状態で呼ぶ）。 */
function applyRecovery({ state: staleState, statePath, logger }) {
  // ロックを待っている間に更新処理が終わっていることがあるので、記録を読み直す
  // （待つ前の読み取りで判断すると、確定済みの入れ替えを巻き戻してしまう）。
  const state = readUpdateState({ statePath });
  if (state.phase !== 'swapping') {
    return { action: 'none', reason: 'no-pending-swap' };
  }
  // 検証はロック取得前の内容に対して行っている。待っている間に記録の指す先が変わっていたら、
  // 検証していない値で rename することになるため何もしない。
  const samePaths =
    state.installPath === staleState.installPath &&
    state.backupPath === staleState.backupPath &&
    state.stagedPath === staleState.stagedPath;
  if (!samePaths) {
    logger.warn?.('[update] 待機中に作業記録が変わったため、中断したアップデートの後始末は行いません。');
    return { action: 'none', reason: 'journal-changed' };
  }

  const journal = {
    ...state,
    installExists: state.installPath ? existsSync(state.installPath) : false,
    backupExists: state.backupPath ? existsSync(state.backupPath) : false,
    stagedExists: state.stagedPath ? existsSync(state.stagedPath) : false,
  };
  const outcome = recoverInterruptedUpdate(journal);

  try {
    if (outcome.action === 'complete') {
      logger.log?.('[update] 前回のアップデートが途中で終わっていたため、続きを実行します...');
      renameSync(state.stagedPath, state.installPath);
      writeUpdateState({ phase: 'completed', recoveredAt: new Date().toISOString() }, { statePath });
    } else if (outcome.action === 'revert') {
      logger.warn?.('[update] 前回のアップデートが確定していないため、元の版へ戻します...');
      if (journal.installExists && journal.backupExists) {
        // 新しい側が入っている可能性のある install を退避して backup を戻す。
        const aside = `${state.installPath}.unconfirmed-${Date.now()}`;
        renameSync(state.installPath, aside);
        renameSync(state.backupPath, state.installPath);
        rmSync(aside, { recursive: true, force: true });
      } else if (journal.backupExists) {
        renameSync(state.backupPath, state.installPath);
      }
      writeUpdateState({ phase: 'reverted', recoveredAt: new Date().toISOString() }, { statePath });
    }
  } catch (err) {
    logger.warn?.(`[update] 中断したアップデートの後始末に失敗しました: ${err.message}`);
    return { action: outcome.action, reason: `recover-failed: ${err.message}` };
  }

  return outcome;
}

/**
 * パス比較用の同一性表現を返す。
 *
 * 「親ディレクトリを実体解決して、末尾の名前を足す」形にする。パスそのものを実体解決すると、
 * 入れ替えの途中で対象が存在しない状況（rename 1 回目の直後）で解決に失敗し、正当な復旧まで
 * 弾いてしまう。親は必ず存在するので、この形なら存在・不存在に関わらず同じ基準で比較できる。
 * @param {unknown} p
 * @returns {string|null}
 */
function identityPath(p) {
  if (typeof p !== 'string' || p.trim() === '') return null;
  const abs = resolve(p.trim());
  const parent = dirname(abs);
  try {
    return join(realpathSync(parent), basename(abs));
  } catch {
    return abs;
  }
}

// ---------------------------------------------------------------------------
// 更新処理の排他
// ---------------------------------------------------------------------------

/**
 * 更新処理の排他ロックを取る。
 *
 * 更新は「ダウンロード → npm ci → 展開先の動作確認（最大 120 秒）→ 入れ替え」で数分かかる。
 * その間に別の更新処理が始まると、同じ展開先を掴んだり、先発が入れ替えの途中で
 * 後発が展開先を消したりする（インストールが一時的に存在しない状態が生まれる）。
 *
 * ロックはインストールごと（installDir から作った名前）に持つ。生きていないプロセスの
 * ロックは奪う（起動中に電源が落ちた場合に永久に更新できなくならないようにする）。
 *
 * @param {string} installDir
 * @param {{ lockDir?: string }} [options]
 * @returns {{ ok:true, release:() => void } | { ok:false, code:string, message:string }}
 */
export function acquireUpdateLock(installDir, { lockDir = updateWorkDir(), purpose = 'update' } = {}) {
  const lockFile = updateLockPathFor(installDir, lockDir, purpose);
  mkdirSync(lockDir, { recursive: true });

  const record = JSON.stringify({ pid: process.pid, installDir: resolve(installDir), startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockFile, record, { flag: 'wx' });
      return {
        ok: true,
        lockFile,
        release: () => {
          try {
            const current = JSON.parse(readFileSync(lockFile, 'utf8'));
            if (current?.pid === process.pid) rmSync(lockFile, { force: true });
          } catch {
            // 後始末は best effort。
          }
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') {
        return { ok: false, code: 'lock-error', message: `更新の排他ロックを作れませんでした: ${err.message}` };
      }
    }

    if (isUpdateLockHeld(lockFile)) {
      return {
        ok: false,
        code: 'update-in-progress',
        message: 'ほかのアップデート処理が実行中です。終わるのを待ってから、もう一度実行してください。',
      };
    }
    // 死んだプロセスが残したロックは奪う。
    try {
      rmSync(lockFile, { force: true });
    } catch {
      // 消せなければ次の試行で EEXIST になり、update-in-progress として返る。
    }
  }

  return {
    ok: false,
    code: 'update-in-progress',
    message: 'アップデートの排他ロックを取得できませんでした。時間をおいて、もう一度実行してください。',
  };
}

/**
 * インストールごとのロックのパス。
 *
 * 鍵はインストールパスの「同一性表現」（親を実体解決して名前を足したもの）から作る。
 * 単に文字列を使うと、シンボリックリンク経由で起動した場合と実体パスで起動した場合で
 * 別のロックになり、同じインストールに対して 2 つの更新処理が同時に走ってしまう。
 *
 * purpose で用途を分ける。片付け（prune）を更新（update）と同じロックにすると、
 * 片付けが走っている数秒のあいだに実行された `vk-orchestrator update` が
 * 「ほかのアップデート処理が実行中です」で失敗する。実際に走っているのは片付けだけなので、
 * 利用者に見せる結論が事実と合わない。
 *
 * @param {string} installDir
 * @param {string} [lockDir]
 * @param {'update'|'prune'} [purpose]
 * @returns {string}
 */
export function updateLockPathFor(installDir, lockDir = updateWorkDir(), purpose = 'update') {
  const canonical = identityPath(installDir) ?? resolve(installDir);
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  const prefix = purpose === 'prune' ? 'prune' : 'update';
  return join(lockDir, `${prefix}-${key}.lock`);
}

/**
 * 中身が書かれる前のロックを「保持中」とみなす猶予（作成直後の一瞬を守るためだけの短い窓）。
 *
 * ロックは O_EXCL でファイルを作ってから中身を書くため、作成直後・書き込み前の空ファイルを
 * 別プロセスが読むと JSON として解釈できない。これを「壊れている＝奪ってよい」と扱うと、
 * 2 つのプロセスが同時にロックを持つ状態に戻ってしまう。
 */
export const UPDATE_LOCK_WRITE_GRACE_MS = 30 * 60 * 1000;

/**
 * プロセス ID が生きていても、これより古いロックは見捨てる上限。
 *
 * 更新処理の途中でマシンが落ちたあと、同じ ID が別のプロセスへ再利用されると
 * 「生きている」と判定され続けて永久に更新できなくなる。実際の更新は
 * ダウンロード＋依存の入れ直し＋動作確認（最大 120 秒）で、長くても数十分には収まる。
 */
export const UPDATE_LOCK_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * 更新ロックが「生きている処理」によって保持されているかを判定する。
 *
 * 起動ロック（isStartLockHeld）と分けているのは、更新ロックには
 *   - 中身が書かれる前の一瞬を守る猶予
 *   - プロセス ID の再利用で永久に詰まらないための上限
 * という 2 つの時間の条件が要るため。
 *
 * @param {string} lockFile
 * @param {{ now?: number }} [options]
 * @returns {boolean}
 */
export function isUpdateLockHeld(lockFile, { now = Date.now() } = {}) {
  if (!lockFile || !existsSync(lockFile)) return false;

  let ageMs = Number.POSITIVE_INFINITY;
  try {
    ageMs = now - statSync(lockFile).mtimeMs;
  } catch {
    return false; // 状態が読めないなら存在しない扱い
  }

  let pid = null;
  let readable = true;
  try {
    pid = JSON.parse(readFileSync(lockFile, 'utf8'))?.pid ?? null;
  } catch {
    readable = false;
  }

  // 中身がまだ書かれていない（または壊れている）。作成直後なら保持中として扱う。
  if (!readable || !Number.isInteger(pid) || pid <= 0) {
    return ageMs < UPDATE_LOCK_WRITE_GRACE_MS;
  }

  // 古すぎるロックは、プロセス ID が生きていても見捨てる（ID 再利用の救済）。
  if (ageMs >= UPDATE_LOCK_MAX_AGE_MS) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH はプロセス不在。EPERM は存在するが権限がない状態なので「生存」とみなす。
    return err.code !== 'ESRCH';
  }
}

/**
 * 展開先を用意する（ダウンロード → 照合 → 展開 → 資産の写し → 動作確認）。
 *
 * @param {object} input
 * @returns {Promise<{ ok:true, stagedDir:string, sameDevice:boolean, preserved:string[] }
 *          | { ok:false, code:string, message:string }>}
 */
export async function stageUpdate({
  installDir,
  manifest,
  allowedHosts,
  fetchImpl = null,
  logger = console,
}) {
  const target = resolveDownloadTarget(manifest, { allowedHosts });
  if (!target.ok) return target;

  const parentDir = dirname(installDir);
  let stagedParent = parentDir;
  // 既定はインストールディレクトリの兄弟。同一ファイルシステムが構造的に保証されるため、
  // 入れ替えの rename が原子的に働く。
  let sameDevice = true;
  if (!isWritableDir(parentDir)) {
    // 親が書けない環境（読み取り専用の配置など）ではホーム配下へ退避する。
    // rename が使えないためコピー方式になり原子的でなくなるので、作業記録での復旧が前提。
    // 展開先の名前に版とプロセス ID が入るので、ここで版ごとの階層は作らない
    // （階層を挟むと後片付けが 1 段深くなるだけで得がない）。
    stagedParent = updateWorkDir();
    mkdirSync(stagedParent, { recursive: true });
    sameDevice = false;
    logger.warn?.(
      `[update] インストール先の親ディレクトリに書き込めないため、${stagedParent} へ展開します（入れ替えはコピー方式になります）。`
    );
  }

  // 展開先の名前に自分のプロセス ID を含める。版だけで決めると、同時に走った更新処理が
  // 同じ展開先を掴み、後から始まった側の削除が先発の作業を壊す。
  const stagedDir = stagingDirFor(stagedParent, manifest.version, process.pid);
  rmSync(stagedDir, { recursive: true, force: true });

  const downloadDir = mkdtempSync(join(tmpdir(), 'vk-orchestrator-update-'));
  try {
    logger.log?.(`[update] 新しい版 ${manifest.version} をダウンロードします...`);
    const downloaded = await downloadZip({
      url: target.url,
      sha256: target.sha256,
      size: target.size,
      destDir: downloadDir,
      allowedHosts,
      fetchImpl,
    });
    if (!downloaded.ok) return downloaded;

    logger.log?.('[update] ダウンロードした内容を確認し、展開します...');
    const extractDir = join(downloadDir, 'extracted');
    const extracted = extractZip(downloaded.zipPath, extractDir);
    if (!extracted.ok) return extracted;

    // 中身が「更新情報ファイルが名乗っている版」であることを確かめる。
    // sha256 だけでは、実在の旧版を新しい版として配らせることを防げない。
    const identity = verifyStagedIdentity(extracted.rootDir, manifest);
    if (!identity.ok) return identity;

    mkdirSync(dirname(stagedDir), { recursive: true });
    try {
      renameSync(extracted.rootDir, stagedDir);
    } catch {
      // 一時ディレクトリと展開先が別ファイルシステムのときは rename できない。
      cpSync(extracted.rootDir, stagedDir, { recursive: true, dereference: false });
    }
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }

  const assets = copyPreservedAssets(installDir, stagedDir);
  for (const r of assets.rejected) {
    logger.warn?.(`[update] ${r.path} は引き継ぎませんでした（理由: ${r.reason}）。`);
  }

  const carried = carryOverVkTerminals({
    installDir,
    stagedDir,
    bundledVersion: manifest.bundled?.vkTerminals ?? null,
  });
  if (carried.moved) logger.log?.('[update] 導入済みの VK Terminals をそのまま引き継ぎます。');

  // 同梱の node_modules を信頼できないときだけ npm ci へ落とす。
  const deps = evaluateBundledDependencies(stagedDir, manifest.lockSha256 ?? null);
  if (!deps.trusted) {
    logger.warn?.(
      `[update] 同梱の依存関係をそのまま使えないため npm ci で入れ直します（理由: ${deps.reason}）...`
    );
    const installed = installStagedDependencies(stagedDir);
    if (!installed.ok) {
      rmSync(stagedDir, { recursive: true, force: true });
      return { ok: false, code: 'staged-install-failed', message: installed.message };
    }
  }

  // この展開先がどのインストールを入れ替えるためのものかを記録する。
  // 入れ替える側（--apply）はこの記録と引数を突き合わせ、意図した組み合わせだけを実行する。
  writeJsonAtomic(join(stagedDir, STAGE_TARGET_FILENAME), { installPath: resolve(installDir) });

  logger.log?.('[update] 展開した内容が起動できるか確認します...');
  let smoke = smokeTestStaged(stagedDir);
  if (!smoke.ok && deps.trusted) {
    // 同梱を信頼して進めたのに起動確認で落ちた場合だけ、npm ci をやり直して再確認する。
    logger.warn?.(`[update] 展開先の動作確認が失敗したため npm ci で依存関係を入れ直します: ${smoke.message}`);
    const installed = installStagedDependencies(stagedDir);
    if (installed.ok) smoke = smokeTestStaged(stagedDir);
  }
  if (!smoke.ok) {
    rmSync(stagedDir, { recursive: true, force: true });
    return { ok: false, code: 'staged-smoke-failed', message: smoke.message };
  }

  return { ok: true, stagedDir, sameDevice, preserved: assets.preserved };
}

function isWritableDir(dir) {
  try {
    const probe = join(dir, `.vk-orchestrator-write-probe-${process.pid}`);
    writeFileSync(probe, '', { flag: 'wx' });
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function isSameDevice(a, b) {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 入れ替えと起動し直し
// ---------------------------------------------------------------------------

/**
 * `update --apply` の引数を検証する。
 *
 * このモードは受け取ったパスを rename と再帰削除の対象にする。ヘルプに内部用として
 * 載せている（障害時に読めないと困る）ので、誤って手で叩かれても無関係なディレクトリを
 * 触らないよう、ここで厳しく弾く。
 *
 *   - --from は「このプロセスが動いているディレクトリ」と一致すること。
 *     入れ替えは新しい側から起動したプロセスが行う設計なので、必ず自分自身になる。
 *   - --from は規定の展開先の名前で、package.json を持つこと。
 *   - --target は、展開を用意した側が展開先へ記録した入れ替え先と一致すること。
 *     引数だけを信じると任意のディレクトリを入れ替え対象にできてしまう。
 *
 * @param {object} input
 * @param {string} input.from --from の値
 * @param {string} input.target --target の値
 * @param {string} input.selfRoot このプロセスのルート（resolve(__dirname, '..')）
 * @returns {{ ok:true, stagedDir:string, installDir:string } | { ok:false, code:string, message:string }}
 */
export function validateApplyArguments({ from, target, selfRoot }) {
  const stagedDir = identityPath(from);
  const selfDir = identityPath(selfRoot);
  if (stagedDir === null || selfDir === null) {
    return { ok: false, code: 'apply-args-invalid', message: '--from / 実行位置を解決できません。' };
  }
  if (stagedDir !== selfDir) {
    return {
      ok: false,
      code: 'apply-from-mismatch',
      message:
        '--from がこのプロセスの実行位置と一致しません（入れ替えは展開先から起動したプロセスが行います）。\n' +
        `  指定: ${from}\n  実行位置: ${selfDir}`,
    };
  }
  if (!basename(stagedDir).startsWith(STAGING_DIR_PREFIX)) {
    return {
      ok: false,
      code: 'apply-from-not-staging',
      message: `--from がアップデート用の展開先ではありません（${STAGING_DIR_PREFIX}… という名前である必要があります）: ${from}`,
    };
  }
  if (!existsSync(join(stagedDir, 'package.json'))) {
    return { ok: false, code: 'apply-from-invalid', message: `--from に package.json がありません: ${from}` };
  }

  const markerPath = join(stagedDir, STAGE_TARGET_FILENAME);
  let recordedTarget = null;
  try {
    recordedTarget = identityPath(JSON.parse(readFileSync(markerPath, 'utf8'))?.installPath);
  } catch {
    recordedTarget = null;
  }
  if (recordedTarget === null) {
    return {
      ok: false,
      code: 'apply-target-unrecorded',
      message: `この展開先には入れ替え先の記録がありません（${STAGE_TARGET_FILENAME}）。アップデートをやり直してください。`,
    };
  }

  const installDir = identityPath(target);
  if (installDir === null || installDir !== recordedTarget) {
    return {
      ok: false,
      code: 'apply-target-mismatch',
      message:
        '--target が、この展開先に記録された入れ替え先と一致しません（内部用のコマンドです）。\n' +
        `  指定: ${target}\n  記録: ${recordedTarget}`,
    };
  }
  if (!existsSync(join(installDir, 'package.json'))) {
    return { ok: false, code: 'apply-target-invalid', message: `--target に package.json がありません: ${target}` };
  }

  return { ok: true, stagedDir, installDir };
}

/**
 * 展開先から起動されて、実際の入れ替えを行う（内部モード `update --apply`）。
 *
 * 自分自身が乗っているディレクトリを自分で差し替えないための構造がここ。
 * 呼び出し元（旧インストールから起動されたプロセス）は展開先の bin を叩いてこの処理に入り、
 * この処理が rename 2 回で入れ替えたあと、新しいインストールから元の起動処理を再実行する。
 *
 * @param {object} input
 * @param {string} input.stagedDir 検証済みの新しい版（このプロセスが動いている場所）
 * @param {string} input.installDir 入れ替え対象
 * @param {string[]} [input.argv] 入れ替え後に起動し直す元の引数（例 ['up']）
 * @param {object} [input.logger]
 * @param {string} [input.statePath]
 * @param {Array<{code:string,message:string,hint:string}>} [input.blockers]
 *   入れ替え直前に測り直した実行可否。空でなければ入れ替えを行わない
 * @returns {number} 終了コード
 */
export function applyStagedUpdate({
  stagedDir,
  installDir,
  argv = [],
  logger = console,
  statePath = updateStatePath(),
  blockers = [],
}) {
  // 入れ替えの直前にもう一度確認する。展開・依存の入れ直し・動作確認で数分かかるため、
  // 入口で測った結果は古くなっている（その間に利用者がアプリを起動しうる）。
  if (Array.isArray(blockers) && blockers.length > 0) {
    logger.error?.(
      '[update] アップデートを中断しました（この間にアプリが起動したため）。\n' +
      blockers.map((b) => `  - ${b.message}\n    → ${b.hint}`).join('\n') + '\n' +
      `  展開した内容は ${stagedDir} に残してあります。アプリを終了してから、もう一度実行してください。`
    );
    return 1;
  }

  // 入れ替え先の記録は、この展開先が新しいインストールになる前に取り除く
  // （新しいインストールに残しても意味がなく、次回の検証を混乱させる）。
  try {
    rmSync(join(stagedDir, STAGE_TARGET_FILENAME), { force: true });
  } catch {
    // 消せなくても入れ替えは進めてよい（検証はもう終わっている）。
  }

  const from = readInstalledVersion(installDir);
  const to = readInstalledVersion(stagedDir);
  const backupPath = backupDirFor(installDir, from);

  // 世代は 1 つだけ残す。前回の backup が残っていたら先に消す。
  try {
    rmSync(backupPath, { recursive: true, force: true });
  } catch (err) {
    logger.warn?.(`[update] 以前の控えを削除できませんでした（処理は継続）: ${err.message}`);
  }

  const steps = planSwap({
    installDir,
    stagedDir,
    sameDevice: isSameDevice(dirname(installDir), dirname(stagedDir)),
    backupPath,
    journalPath: statePath,
    from,
    to,
    argv,
  });

  logger.log?.(`[update] ${from ?? '不明'} から ${to ?? '不明'} へ切り替えます...`);
  try {
    executeSwapSteps(steps, { logger });
  } catch (err) {
    logger.error?.(
      `[update] 切り替えに失敗しました: ${err.message}\n` +
      '  次回の起動時に自動で元の版へ戻します。もう一度 `npm start` を実行してください。'
    );
    return 1;
  }

  logger.log?.(`[update] 新しい版 ${to ?? ''} に切り替えました（元の版は ${backupPath} に残しています）。`);

  // 戻すべき起動処理が無い（明示的な `update` で更新だけを行った）場合はここで終わる。
  // 引数なしで起動し直すとヘルプが出るだけで、利用者を混乱させる。
  if (!Array.isArray(argv) || argv.length === 0) {
    logger.log?.('[update] 次回の起動から新しい版で動きます。');
    return 0;
  }

  // 入れ替え後は新しいインストールから元の起動処理へ戻す。stdio を引き継ぐことで
  // 端末（TTY）をそのまま渡し、利用者から見て「起動し直しただけ」に見えるようにする。
  const bin = join(installDir, 'bin', 'vk-orchestrator.js');
  const child = spawnSync(process.execPath, [bin, ...argv], {
    cwd: installDir,
    stdio: 'inherit',
    env: { ...process.env, VK_ORCHESTRATOR_SELF_UPDATED: '1' },
  });
  if (child.error) {
    logger.warn?.(
      `[update] 新しい版で起動し直せませんでした: ${child.error.message}\n` +
      '  もう一度 `npm start` を実行してください。'
    );
    return 0; // 入れ替え自体は成功しているので失敗扱いにしない
  }
  return child.status ?? 0;
}

/**
 * 展開 → 検証 → 入れ替え（別プロセス）→ 起動し直しまでを通しで行う。
 *
 * @param {object} input
 * @param {string} input.repoRoot インストールディレクトリ
 * @param {object} input.manifest 検証済みの更新情報
 * @param {string[]} input.allowedHosts
 * @param {string[]} [input.argv] 入れ替え後に起動し直す元の引数
 * @param {object} [input.logger]
 * @param {Function|null} [input.fetchImpl]
 * @returns {Promise<{ ok:true, exitCode:number } | { ok:false, code:string, message:string }>}
 */
export async function performZipUpdate({
  repoRoot,
  manifest,
  allowedHosts,
  argv = [],
  logger = console,
  fetchImpl = null,
}) {
  // 排他ロックを stage 〜 swap の全体に掛ける。数分かかる処理なので、
  // この間に別の更新処理が始まると同じ展開先を掴んで互いを壊しうる。
  const lock = acquireUpdateLock(repoRoot);
  if (!lock.ok) return lock;

  try {
    // 前回の失敗で残った展開先を掃除する（.env / config.json の複製を溜め込まないため）。
    // 更新ロックはこの関数が既に持っているので、自分の更新を「実行中」と見なさないよう
    // insideUpdate を渡す。
    pruneStaleStagingDirs(repoRoot, { logger, insideUpdate: true });

    const staged = await stageUpdate({
      installDir: repoRoot,
      manifest,
      allowedHosts,
      fetchImpl,
      logger,
    });
    if (!staged.ok) return staged;

    // 入れ替えは「新しい側から起動したプロセス」に任せる。
    const bin = join(staged.stagedDir, 'bin', 'vk-orchestrator.js');
    const child = spawnSync(
      process.execPath,
      [bin, 'update', '--apply', '--from', staged.stagedDir, '--target', repoRoot, '--argv', JSON.stringify(argv)],
      { cwd: staged.stagedDir, stdio: 'inherit', env: { ...process.env } }
    );
    if (child.error) {
      // 起動できなかった＝入れ替えは始まっていないので、利用者の資産の複製を残さず片付ける。
      rmSync(staged.stagedDir, { recursive: true, force: true });
      return {
        ok: false,
        code: 'apply-spawn-failed',
        message: `切り替え処理を起動できませんでした: ${child.error.message}`,
      };
    }
    if ((child.status ?? 0) !== 0) {
      // 入れ替え処理が中断した場合、展開先は復旧に必要なことがある（作業記録が swapping のとき）。
      // 記録が入れ替え中でなければ、入れ替えは始まっていないので片付けてよい。
      if (readUpdateState().phase !== 'swapping') {
        rmSync(staged.stagedDir, { recursive: true, force: true });
      }
    }
    return { ok: true, exitCode: child.status ?? 0 };
  } finally {
    lock.release();
  }
}

/**
 * 過去の失敗で残った展開先を掃除する。
 *
 * 展開先には利用者の資産（.env / config.json）の複製と node_modules が入る。
 * 削除の機会が「同じ版で次に stage したとき」だけだと、版が変わるたびに溜まり続ける。
 * 自分のプロセス ID を含む名前だけは残す（走行中のものを消さないため）。
 *
 * 消してよいのは「もう誰も使っていない展開先」だけ。次のものは残す。
 *
 *   - 自分のプロセスの展開先
 *   - 名前の末尾のプロセス ID が生きている展開先（＝別プロセスが今まさに使っている）
 *   - 入れ替え先の記録が自分のインストール以外を指している展開先
 *   - 作業記録が入れ替え中を示しているときの、その記録が指す展開先（復旧に必要）
 *
 * とくに 2 番目が要る。片付けは毎起動の先頭で走るため、別の端末で走っている
 * `vk-orchestrator update` の展開先を消してしまい、更新を失敗させる
 * （まれに「控えの削除中」に当たると、続く rename が失敗してインストールが
 * 一時的に存在しない状態になる）。
 *
 * @param {string} installDir
 * @param {{ logger?: object, statePath?: string, workDir?: string, lockDir?: string,
 *          insideUpdate?: boolean }} [options]
 *   insideUpdate … 更新処理の中から呼ぶ場合に true（自分の更新を「実行中」と見なさないため）
 */
export function pruneStaleStagingDirs(installDir, {
  logger = console,
  statePath = updateStatePath(),
  workDir = updateWorkDir(),
  lockDir = updateWorkDir(),
  insideUpdate = false,
} = {}) {
  // 更新処理が走っている最中は片付け自体を見送る（走行中の展開先に触れないための一次防御）。
  // ここでは更新ロックを「取らずに読む」だけにする。取ってしまうと、片付けの数秒のあいだに
  // 実行された `vk-orchestrator update` が「ほかのアップデート処理が実行中です」で失敗し、
  // 実際に走っているのは片付けだけなのに、利用者に見せる結論が事実と合わなくなる。
  if (!insideUpdate && isUpdateLockHeld(updateLockPathFor(installDir, lockDir, 'update'))) {
    logger.log?.('[update] アップデート処理が実行中のため、展開先の片付けは見送ります。');
    return;
  }

  // 片付けどうしが重ならないよう、片付け専用のロックを取る。
  let lock = null;
  if (!insideUpdate) {
    lock = acquireUpdateLock(installDir, { lockDir, purpose: 'prune' });
    if (!lock.ok) {
      logger.log?.('[update] ほかの片付け処理が実行中のため、展開先の片付けは見送ります。');
      return;
    }
  }

  try {
    const state = readUpdateState({ statePath });
    const swapping = state.phase === 'swapping';
    const keepStaged = swapping && state.stagedPath ? resolve(state.stagedPath) : null;
    const ownInstall = identityPath(installDir);
    const parents = [dirname(installDir), workDir];
    const ownSuffix = `-${process.pid}`;

    for (const parent of parents) {
      let entries = [];
      try {
        entries = readdirSync(parent, { withFileTypes: true });
      } catch {
        continue; // 読めない場所は放っておく
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(STAGING_DIR_PREFIX)) continue;
        const dir = join(parent, entry.name);

        // 走行中の自分の展開先は消さない。
        if (entry.name.endsWith(ownSuffix)) continue;
        // 別プロセスが今まさに使っている展開先は消さない。
        if (isStagingDirInUse(entry.name)) continue;
        // 自分のインストール宛でない展開先は消さない（別インストールの更新処理のもの）。
        const target = readStagedTarget(dir);
        if (target !== null && ownInstall !== null && target !== ownInstall) continue;
        // 入れ替えの途中なら、記録が指す展開先は復旧に必要なので消さない。
        if (keepStaged !== null && keepStaged === resolve(dir)) continue;

        try {
          rmSync(dir, { recursive: true, force: true });
          logger.log?.(`[update] 使われていない展開先を削除しました → ${dir}`);
        } catch (err) {
          logger.warn?.(`[update] 展開先を削除できませんでした（処理は継続）: ${dir} (${err.message})`);
        }
      }
    }
  } finally {
    lock?.release();
  }
}

/**
 * 展開先の名前の末尾に付いたプロセス ID が生きているかを見る。
 * 生きていれば、そのプロセスが今まさにその展開先を使っている。
 *
 * 既知の境界（今は直していない）: ロックの判定（isUpdateLockHeld）と違い、ここには
 * 年齢の上限を置いていない。そのため、更新の途中で落ちたあとに同じ ID が別のプロセスへ
 * 再利用されているあいだ、その展開先は片付けの対象外になり続ける。実害は利用者の資産
 * （.env / config.json）の複製が消えないことだけで、動作には影響しないため見送った。
 * 直すなら展開先の作成時刻（mtime）に上限を足せばよい。
 *
 * @param {string} dirName 展開先のディレクトリ名（パスではなく名前）
 * @returns {boolean}
 */
export function isStagingDirInUse(dirName) {
  const m = String(dirName ?? '').match(/-(\d+)$/);
  if (!m) return false; // 識別子の無い古い形式は判定できない
  const pid = Number(m[1]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH はプロセス不在。EPERM は存在するが権限がない状態なので「生存」とみなす。
    return err.code !== 'ESRCH';
  }
}

/**
 * 展開先に残っている「入れ替え先の記録」を読む。無ければ null。
 * @param {string} stagedDir
 * @returns {string|null}
 */
function readStagedTarget(stagedDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(stagedDir, STAGE_TARGET_FILENAME), 'utf8'));
    return identityPath(parsed?.installPath);
  } catch {
    return null;
  }
}

/**
 * 今アップデートを実行してよいかを、実環境を測って判定する。
 *
 * @param {object} input
 * @param {'git'|'zip'|'off'|'unknown'} input.channel
 * @param {boolean} input.healthResponding VK Terminals API が応答したか
 * @param {string} [input.lockFile] 起動ロックのパス
 * @returns {Array<{code:string,message:string,hint:string}>}
 */
export function measureUpdateBlockers({ channel, healthResponding, lockFile }) {
  return evaluateUpdateBlockers({
    channel,
    healthResponding,
    startLockHeld: isStartLockHeld(lockFile),
  });
}

/**
 * 起動ロックが「生きているプロセス」によって取られているかを判定する。
 * 死んだプロセスが残した記録（stale lock）は取られていない扱いにする。
 * @param {string} lockFile
 * @returns {boolean}
 */
export function isStartLockHeld(lockFile) {
  if (!lockFile || !existsSync(lockFile)) return false;
  let pid = null;
  try {
    pid = JSON.parse(readFileSync(lockFile, 'utf8'))?.pid ?? null;
  } catch {
    return false; // 壊れた記録は stale と同じ扱い
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH はプロセス不在。EPERM は存在するが権限がない状態なので「生存」とみなす。
    return err.code !== 'ESRCH';
  }
}
