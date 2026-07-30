/**
 * 更新情報ファイル（配布サーバーに置く JSON）の契約。
 *
 * 配布 zip と同じディレクトリに `vk-orchestrator-latest.json` を並べ、
 * 「今の最新は何版か・どの zip をどのハッシュで取ればよいか」をここから読む。
 * WordPress のプラグイン更新 API は使わない（zip はプラグインでもテーマでもないため
 * 問い合わせが 500 になる）ので、静的な JSON を自前の契約として扱う。
 *
 * このモジュールは検証だけを行う純粋関数の集まりで、ネットワークにも fs にも触らない。
 *
 * 受理条件は意図的に厳しくしている。とくに配布 URL は
 *   - https のみ（http は拒否）
 *   - ホストは「設定で解決した許可ホスト」と完全一致必須
 *   - sha256 必須（64 桁の 16 進数）
 * とし、更新情報ファイルが指す任意のホストへ取りに行かないようにする
 * （配布サーバーが乗っ取られても、別ホストへの誘導だけは成立しないようにするため）。
 */

/** このコードが理解できる更新情報ファイルの版。これより大きい版は拒否する。 */
export const UPDATE_MANIFEST_SCHEMA_VERSION = 1;

/** 更新情報ファイルが指す製品名。ほかの製品の更新情報を誤って適用しない。 */
export const UPDATE_MANIFEST_PRODUCT = 'vk-orchestrator';

const SHA256_RE = /^[0-9a-f]{64}$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * "1.5.0" / "v1.5.0" → [1,5,0]。semver でなければ null。
 * @param {unknown} value
 * @returns {number[]|null}
 */
function toTuple(value) {
  const m = String(value ?? '').trim().replace(/^v/, '').match(SEMVER_RE);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpTuple(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function invalid(message) {
  return { ok: false, code: 'manifest-invalid', message };
}

/**
 * 更新情報ファイルの JSON を検証して、扱いやすい形に正規化する。
 *
 * 未知のフィールドは黙って無視する（配布側が先に項目を増やしても古いアプリが壊れないように）。
 * 逆に schemaVersion が上がった場合は「解釈できない」と分かるので明確に拒否する。
 *
 * @param {unknown} json JSON.parse 済みの値
 * @returns {{ ok: true, manifest: object } | { ok: false, code: string, message: string }}
 */
export function parseUpdateManifest(json) {
  if (!isPlainObject(json)) {
    return invalid('更新情報ファイルの中身が JSON オブジェクトではありません。');
  }

  const schemaVersion = json.schemaVersion;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    return invalid('schemaVersion が正の整数ではありません。');
  }
  if (schemaVersion > UPDATE_MANIFEST_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'manifest-unsupported',
      message: `この版のアプリでは解釈できない更新情報ファイルです（schemaVersion: ${schemaVersion}）。アプリを手動で入れ直してください。`,
    };
  }

  const product = nonEmptyString(json.product);
  if (product === null) return invalid('product が空です。');
  if (product !== UPDATE_MANIFEST_PRODUCT) {
    return {
      ok: false,
      code: 'manifest-product-mismatch',
      message: `別の製品の更新情報ファイルです（product: ${product}）。`,
    };
  }

  const version = nonEmptyString(json.version);
  if (version === null) return invalid('version が空です。');
  if (!toTuple(version)) return invalid(`version が x.y.z 形式ではありません（${version}）。`);

  const download = json.download;
  if (!isPlainObject(download)) return invalid('download が指定されていません。');
  const url = nonEmptyString(download.url);
  if (url === null) return invalid('download.url が空です。');
  const sha256 = nonEmptyString(download.sha256)?.toLowerCase() ?? null;
  if (sha256 === null) return invalid('download.sha256 が空です。');
  if (!SHA256_RE.test(sha256)) return invalid('download.sha256 が 64 桁の 16 進数ではありません。');
  const size = Number.isFinite(download.size) && download.size > 0 ? Math.trunc(download.size) : null;

  const minUpgradableFrom = nonEmptyString(json.minUpgradableFrom);
  if (minUpgradableFrom !== null && !toTuple(minUpgradableFrom)) {
    return invalid(`minUpgradableFrom が x.y.z 形式ではありません（${minUpgradableFrom}）。`);
  }

  const bundledRaw = isPlainObject(json.bundled) ? json.bundled : {};

  return {
    ok: true,
    manifest: {
      schemaVersion,
      product,
      version,
      tag: nonEmptyString(json.tag),
      releasedAt: nonEmptyString(json.releasedAt),
      download: { url, size, sha256 },
      downloadLatest: isPlainObject(json.downloadLatest)
        ? { url: nonEmptyString(json.downloadLatest.url) }
        : null,
      minNode: nonEmptyString(json.minNode),
      bundled: {
        vkTerminals: nonEmptyString(bundledRaw.vkTerminals),
        vkAgents: nonEmptyString(bundledRaw.vkAgents),
      },
      lockSha256: nonEmptyString(json.lockSha256)?.toLowerCase() ?? null,
      requiresSetupAgents: json.requiresSetupAgents === true,
      minUpgradableFrom,
      changelogUrl: nonEmptyString(json.changelogUrl),
    },
  };
}

/**
 * 配布 zip の URL を検証して、取得に使う情報だけを返す。
 *
 * @param {object} manifest parseUpdateManifest が返した manifest
 * @param {{ allowedHosts?: string[] }} [options] 設定で解決した許可ホスト
 * @returns {{ ok: true, url: string, sha256: string, size: number|null }
 *          | { ok: false, code: string, message: string }}
 */
export function resolveDownloadTarget(manifest, { allowedHosts = [] } = {}) {
  const url = nonEmptyString(manifest?.download?.url);
  if (url === null) {
    return { ok: false, code: 'download-invalid', message: '配布 zip の URL が指定されていません。' };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: 'download-invalid', message: `配布 zip の URL を解釈できません（${url}）。` };
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'download-insecure-scheme',
      message: `配布 zip は https でのみ取得します（指定: ${parsed.protocol.replace(':', '')}）。`,
    };
  }

  const hosts = (Array.isArray(allowedHosts) ? allowedHosts : [])
    .map((h) => String(h ?? '').trim().toLowerCase())
    .filter((h) => h !== '');
  if (hosts.length === 0) {
    return {
      ok: false,
      code: 'download-host-not-allowed',
      message: '配布 zip の取得を許可するホストが設定されていません。',
    };
  }
  if (!hosts.includes(parsed.hostname.toLowerCase())) {
    return {
      ok: false,
      code: 'download-host-not-allowed',
      message: `許可していないホストの配布 zip は取得しません（${parsed.hostname}）。`,
    };
  }

  const sha256 = nonEmptyString(manifest?.download?.sha256)?.toLowerCase() ?? null;
  if (sha256 === null || !SHA256_RE.test(sha256)) {
    return { ok: false, code: 'download-invalid', message: '配布 zip の sha256 が不正です。' };
  }

  return { ok: true, url: parsed.toString(), sha256, size: manifest.download.size ?? null };
}

/**
 * 「その版へ上げてよいか」を判定する。
 *
 * - 現行が manifest の版と同じか新しければ up-to-date
 * - 現行が minUpgradableFrom 未満なら manual-required（自動更新せず手動再インストールへ案内）
 * - Node の版が minNode 未満なら node-too-old
 *
 * @param {object} input
 * @param {object} input.manifest parseUpdateManifest が返した manifest
 * @param {string|null} input.current 現在の version
 * @param {string|null} [input.nodeVersion] 実行中の Node の version（例 process.versions.node）
 * @returns {{ action: 'update'|'skip', reason: string }}
 */
export function evaluateUpgradePath({ manifest, current, nodeVersion = null } = {}) {
  const latestTuple = toTuple(manifest?.version);
  if (!latestTuple) return { action: 'skip', reason: 'version-unresolved' };
  const currentTuple = toTuple(current);
  if (!currentTuple) return { action: 'skip', reason: 'invalid-version' };
  if (cmpTuple(latestTuple, currentTuple) <= 0) return { action: 'skip', reason: 'up-to-date' };

  const minFrom = toTuple(manifest?.minUpgradableFrom);
  if (minFrom && cmpTuple(currentTuple, minFrom) < 0) {
    return { action: 'skip', reason: 'manual-required' };
  }

  const minNode = toTuple(manifest?.minNode);
  const running = toTuple(nodeVersion);
  if (minNode && running && cmpTuple(running, minNode) < 0) {
    return { action: 'skip', reason: 'node-too-old' };
  }

  return { action: 'update', reason: 'newer-release' };
}
