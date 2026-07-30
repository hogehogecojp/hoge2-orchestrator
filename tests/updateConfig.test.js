/**
 * update セクションの設定解決のユニットテスト。
 *
 * 更新情報ファイルの URL は「設定 1 つでどこへ問い合わせるかが変わる」入口なので、
 * 配布 zip と同じ受理条件（https のみ・許可ホストと完全一致）を通していることを固定する。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_UPDATE, getUpdateConfig } from '../src/config.js';

const ENV_KEYS = [
  'VK_ORCHESTRATOR_AUTO_UPDATE',
  'VK_ORCHESTRATOR_NO_AUTO_UPDATE',
  'VK_ORCHESTRATOR_UPDATE_MANIFEST_URL',
  'VK_ORCHESTRATOR_UPDATE_ALLOWED_HOSTS',
  'VK_ORCHESTRATOR_UPDATE_CHECK_INTERVAL_HOURS',
];

let savedEnv;
let savedWarn;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  savedWarn = console.warn;
  console.warn = () => {};
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  console.warn = savedWarn;
});

describe('getUpdateConfig の既定値', () => {
  it('自動アップデートは既定 ON', () => {
    assert.equal(getUpdateConfig({}).autoUpdate, true);
    assert.equal(DEFAULT_UPDATE.autoUpdate, true);
  });

  it('config で OFF にできる', () => {
    assert.equal(getUpdateConfig({ update: { autoUpdate: false } }).autoUpdate, false);
  });

  it('GUI 保存由来の文字列 "false" も OFF として受け取る', () => {
    assert.equal(getUpdateConfig({ update: { autoUpdate: 'false' } }).autoUpdate, false);
  });

  it('従来の環境変数は設定より強く OFF にする（サポート時の脱出ハッチ）', () => {
    process.env.VK_ORCHESTRATOR_NO_AUTO_UPDATE = '1';
    assert.equal(getUpdateConfig({ update: { autoUpdate: true } }).autoUpdate, false);
  });

  it('確認間隔は 0 以下・数値でない値を既定へ戻す（配布元へ叩き続けない）', () => {
    assert.equal(getUpdateConfig({ update: { checkIntervalHours: 0 } }).checkIntervalHours, 6);
    assert.equal(getUpdateConfig({ update: { checkIntervalHours: -1 } }).checkIntervalHours, 6);
    assert.equal(getUpdateConfig({ update: { checkIntervalHours: 'abc' } }).checkIntervalHours, 6);
    assert.equal(getUpdateConfig({ update: { checkIntervalHours: 12 } }).checkIntervalHours, 12);
  });
});

describe('更新情報ファイルの URL の受理条件', () => {
  it('許可ホストの https なら受理する', () => {
    const cfg = {
      update: {
        manifestUrl: 'https://license.vektor-inc.co.jp/check/packages/other.json',
        allowedHosts: ['license.vektor-inc.co.jp'],
      },
    };
    assert.equal(
      getUpdateConfig(cfg).manifestUrl,
      'https://license.vektor-inc.co.jp/check/packages/other.json'
    );
  });

  it('許可ホストに追加すれば別ホストも指定できる', () => {
    const cfg = {
      update: {
        manifestUrl: 'https://updates.example.com/latest.json',
        allowedHosts: ['updates.example.com'],
      },
    };
    assert.equal(getUpdateConfig(cfg).manifestUrl, 'https://updates.example.com/latest.json');
  });

  // ここが回帰テスト。配布 zip の URL には受理条件を掛けていたのに、
  // 更新情報ファイル自体の URL は trim だけで素通しだった。
  it('許可ホストに無いホストは既定値へ戻す', () => {
    const cfg = {
      update: {
        manifestUrl: 'https://evil.example.com/latest.json',
        allowedHosts: ['license.vektor-inc.co.jp'],
      },
    };
    assert.equal(getUpdateConfig(cfg).manifestUrl, DEFAULT_UPDATE.manifestUrl);
  });

  it('http は既定値へ戻す', () => {
    const cfg = {
      update: {
        manifestUrl: 'http://license.vektor-inc.co.jp/latest.json',
        allowedHosts: ['license.vektor-inc.co.jp'],
      },
    };
    assert.equal(getUpdateConfig(cfg).manifestUrl, DEFAULT_UPDATE.manifestUrl);
  });

  it('URL として解釈できない値は既定値へ戻す', () => {
    assert.equal(
      getUpdateConfig({ update: { manifestUrl: 'not a url' } }).manifestUrl,
      DEFAULT_UPDATE.manifestUrl
    );
  });

  it('環境変数で指定した URL にも同じ条件を掛ける', () => {
    process.env.VK_ORCHESTRATOR_UPDATE_MANIFEST_URL = 'https://evil.example.com/latest.json';
    assert.equal(getUpdateConfig({}).manifestUrl, DEFAULT_UPDATE.manifestUrl);

    process.env.VK_ORCHESTRATOR_UPDATE_MANIFEST_URL = 'https://license.vektor-inc.co.jp/x.json';
    assert.equal(getUpdateConfig({}).manifestUrl, 'https://license.vektor-inc.co.jp/x.json');
  });

  it('既定の URL は既定の許可ホストと整合している', () => {
    const resolved = getUpdateConfig({});
    const host = new URL(resolved.manifestUrl).hostname;
    assert.ok(resolved.allowedHosts.includes(host), '既定値どうしが食い違っていない');
  });
});
