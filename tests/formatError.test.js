/**
 * formatErrorSummary のユニットテスト（issue #130 / GitHub API エラーの raw dump 防止）。
 *
 * GitHub API 由来の巨大な Error オブジェクトを端末へ丸ごと出さず、秘密情報や HTML 本文を
 * 落とした 1 行要約へ整形する純粋関数の検証。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatErrorSummary } from '../src/engine/format-error.js';

describe('formatErrorSummary', () => {
  it('octokit 風エラーを HTML body・headers・query なしの 1 行要約にする', () => {
    const err = new Error('<!DOCTYPE html>\n<html><head><style>body{color:red}</style></head><body>fatal page</body></html>');
    err.status = 502;
    err.request = {
      method: 'GET',
      url: 'https://api.github.com/repos/vektor-inc/vk-orchestrator/issues?access_token=ghp_abcdefghijklmnopqrstuvwxyz123456&per_page=100',
      headers: {
        authorization: 'token ghp_abcdefghijklmnopqrstuvwxyz123456',
      },
    };
    err.response = {
      data: '<html><body><img src="data:image/png;base64,SECRET_IMAGE_BODY"></body></html>',
      headers: {
        authorization: 'token ghp_response_secret_abcdefghijklmnopqrstuvwxyz123456',
        'x-github-request-id': 'request-id',
      },
    };

    const out = formatErrorSummary(err);

    assert.equal(out.split(/\r?\n/).length, 1);
    assert.match(out, /502/);
    assert.match(out, /HTML response body omitted/);
    assert.match(out, /GET \/repos\/vektor-inc\/vk-orchestrator\/issues/);
    assert.doesNotMatch(out, /authorization/i);
    assert.doesNotMatch(out, /ghp_abcdefghijklmnopqrstuvwxyz123456/);
    assert.doesNotMatch(out, /SECRET_IMAGE_BODY/);
    assert.doesNotMatch(out, /access_token/);
    assert.doesNotMatch(out, /per_page/);
    assert.doesNotMatch(out, /\?/);
    assert.doesNotMatch(out, /<html/i);
  });

  it('octokit 風エラーの通常 message は status・method・URL パスと一緒に残す', () => {
    const err = new Error('Validation Failed');
    err.status = 422;
    err.request = {
      method: 'PATCH',
      url: '/repos/owner/repo/issues/130?token=secret',
    };

    const out = formatErrorSummary(err);

    assert.equal(out, '422 Validation Failed (PATCH /repos/owner/repo/issues/130)');
  });

  it('一般的な Error は stack を維持する', () => {
    const err = new TypeError('broken code path');
    err.stack = 'TypeError: broken code path\n    at test.js:1:1';

    assert.equal(formatErrorSummary(err), err.stack);
  });

  it('Error 以外の値でも落ちない', () => {
    assert.equal(formatErrorSummary('plain failure'), 'plain failure');
    assert.equal(formatErrorSummary(undefined), 'undefined');
  });
});
