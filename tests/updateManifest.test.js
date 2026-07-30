/**
 * 更新情報ファイル（配布サーバーに置く JSON）の検証のユニットテスト。
 *
 * 更新情報ファイルは配布サーバー上の静的ファイルなので、そこに書かれた URL を無条件で
 * 信用してはいけない。https 限定・許可ホスト完全一致・sha256 必須という受理条件を
 * 緩めていないことをここで固定する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  UPDATE_MANIFEST_SCHEMA_VERSION,
  evaluateUpgradePath,
  parseUpdateManifest,
  resolveDownloadTarget,
} from '../src/engine/update-manifest.js';

const SHA = 'a'.repeat(64);
const ALLOWED = ['license.vektor-inc.co.jp'];

function validJson(overrides = {}) {
  return {
    schemaVersion: 1,
    product: 'vk-orchestrator',
    version: '1.5.0',
    tag: 'v1.5.0',
    releasedAt: '2026-07-30T00:12:00.000Z',
    download: {
      url: 'https://license.vektor-inc.co.jp/check/packages/vk-orchestrator-1.5.0.zip',
      size: 1_418_747,
      sha256: SHA,
    },
    downloadLatest: { url: 'https://license.vektor-inc.co.jp/check/packages/vk-orchestrator.zip' },
    minNode: '20.0.0',
    bundled: { vkTerminals: '1.48.0', vkAgents: 'v0.14.0' },
    lockSha256: 'b'.repeat(64),
    requiresSetupAgents: true,
    minUpgradableFrom: '0.20.0',
    changelogUrl: 'https://github.com/vektor-inc/vk-orchestrator/blob/main/CHANGELOG.md',
    ...overrides,
  };
}

describe('parseUpdateManifest', () => {
  it('妥当な更新情報ファイルを受理して正規化する', () => {
    const result = parseUpdateManifest(validJson());
    assert.equal(result.ok, true);
    assert.equal(result.manifest.version, '1.5.0');
    assert.equal(result.manifest.download.sha256, SHA);
    assert.equal(result.manifest.download.size, 1_418_747);
    assert.equal(result.manifest.bundled.vkTerminals, '1.48.0');
    assert.equal(result.manifest.requiresSetupAgents, true);
  });

  it('未知のフィールドがあっても受理する（配布側が先に項目を増やしても壊れない）', () => {
    const result = parseUpdateManifest(validJson({ futureField: { nested: true }, notes: 'x' }));
    assert.equal(result.ok, true);
    assert.equal(result.manifest.version, '1.5.0');
    assert.equal('futureField' in result.manifest, false, '未知フィールドは持ち込まない');
  });

  it('schemaVersion が 2 なら manifest-unsupported として拒否する', () => {
    const result = parseUpdateManifest(validJson({ schemaVersion: 2 }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'manifest-unsupported');
  });

  it('現行の schemaVersion は 1', () => {
    assert.equal(UPDATE_MANIFEST_SCHEMA_VERSION, 1);
  });

  it('sha256 が無ければ拒否する', () => {
    const json = validJson();
    delete json.download.sha256;
    const result = parseUpdateManifest(json);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'manifest-invalid');
  });

  it('sha256 の形式が違えば拒否する', () => {
    const result = parseUpdateManifest(validJson({ download: { url: 'https://x/y.zip', sha256: 'deadbeef' } }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'manifest-invalid');
  });

  it('download そのものが無ければ拒否する', () => {
    const json = validJson();
    delete json.download;
    assert.equal(parseUpdateManifest(json).code, 'manifest-invalid');
  });

  it('version が x.y.z 形式でなければ拒否する', () => {
    assert.equal(parseUpdateManifest(validJson({ version: 'latest' })).code, 'manifest-invalid');
  });

  it('別製品の更新情報ファイルは拒否する', () => {
    assert.equal(parseUpdateManifest(validJson({ product: 'vk-terminals' })).code, 'manifest-product-mismatch');
  });

  it('JSON オブジェクトでなければ拒否する', () => {
    assert.equal(parseUpdateManifest(null).code, 'manifest-invalid');
    assert.equal(parseUpdateManifest([1, 2]).code, 'manifest-invalid');
    assert.equal(parseUpdateManifest('{}').code, 'manifest-invalid');
  });
});

describe('resolveDownloadTarget', () => {
  const manifest = parseUpdateManifest(validJson()).manifest;

  it('許可ホストの https なら受理する', () => {
    const result = resolveDownloadTarget(manifest, { allowedHosts: ALLOWED });
    assert.equal(result.ok, true);
    assert.equal(result.sha256, SHA);
    assert.match(result.url, /^https:\/\/license\.vektor-inc\.co\.jp\//);
  });

  it('http は拒否する', () => {
    const httpManifest = parseUpdateManifest(
      validJson({ download: { url: 'http://license.vektor-inc.co.jp/x.zip', sha256: SHA } })
    ).manifest;
    const result = resolveDownloadTarget(httpManifest, { allowedHosts: ALLOWED });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'download-insecure-scheme');
  });

  it('許可外ホストは拒否する', () => {
    const otherHost = parseUpdateManifest(
      validJson({ download: { url: 'https://evil.example.com/vk-orchestrator.zip', sha256: SHA } })
    ).manifest;
    const result = resolveDownloadTarget(otherHost, { allowedHosts: ALLOWED });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'download-host-not-allowed');
  });

  it('サブドメインを騙る名前も部分一致では通さない', () => {
    const lookalike = parseUpdateManifest(
      validJson({ download: { url: 'https://license.vektor-inc.co.jp.evil.example/x.zip', sha256: SHA } })
    ).manifest;
    assert.equal(resolveDownloadTarget(lookalike, { allowedHosts: ALLOWED }).code, 'download-host-not-allowed');
  });

  it('許可ホストが未設定なら取得しない', () => {
    assert.equal(resolveDownloadTarget(manifest, { allowedHosts: [] }).code, 'download-host-not-allowed');
    assert.equal(resolveDownloadTarget(manifest).code, 'download-host-not-allowed');
  });

  it('URL として解釈できなければ拒否する', () => {
    const broken = { download: { url: 'not a url', sha256: SHA } };
    assert.equal(resolveDownloadTarget(broken, { allowedHosts: ALLOWED }).code, 'download-invalid');
  });
});

describe('evaluateUpgradePath', () => {
  const manifest = parseUpdateManifest(validJson()).manifest;

  it('新しい版があれば update', () => {
    assert.deepEqual(
      evaluateUpgradePath({ manifest, current: '1.4.2', nodeVersion: '22.1.0' }),
      { action: 'update', reason: 'newer-release' }
    );
  });

  it('同じ版・ローカルが先行なら up-to-date', () => {
    assert.equal(evaluateUpgradePath({ manifest, current: '1.5.0' }).reason, 'up-to-date');
    assert.equal(evaluateUpgradePath({ manifest, current: '1.6.0' }).reason, 'up-to-date');
  });

  it('minUpgradableFrom 未満なら manual-required（自動更新せず手動再インストールへ案内）', () => {
    assert.deepEqual(
      evaluateUpgradePath({ manifest, current: '0.19.9' }),
      { action: 'skip', reason: 'manual-required' }
    );
  });

  it('minNode 未満の Node で動いていれば node-too-old', () => {
    assert.deepEqual(
      evaluateUpgradePath({ manifest, current: '1.4.2', nodeVersion: '18.20.0' }),
      { action: 'skip', reason: 'node-too-old' }
    );
  });

  it('現在の版が読めなければ invalid-version', () => {
    assert.equal(evaluateUpgradePath({ manifest, current: null }).reason, 'invalid-version');
  });
});
