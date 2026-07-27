import { redactSecrets } from './redact-secrets.js';

// -------------------------------------------------------
// エラー要約整形（純粋関数・issue #130 対策）
//
// GitHub API / Octokit 由来の Error は request / response に巨大な HTML 本文や
// Authorization ヘッダを抱えるため、console.error に raw オブジェクトを渡さず
// 1 行の安全な要約に落とす。通常の TypeError 等はデバッグ性を優先して stack を残す。
// -------------------------------------------------------

const HTML_RESPONSE_SUMMARY = 'HTML response body omitted';

function isObjectLike(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function isApiLikeError(err) {
  return isObjectLike(err) && (
    Object.prototype.hasOwnProperty.call(err, 'status') ||
    Object.prototype.hasOwnProperty.call(err, 'request') ||
    Object.prototype.hasOwnProperty.call(err, 'response')
  );
}

function isHtmlLike(value) {
  if (typeof value !== 'string') return false;
  return /<(?:!doctype\s+html|html|head|body|style|script|img)\b/i.test(value);
}

function toOneLine(value) {
  return String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function formatRequestTarget(request) {
  if (!isObjectLike(request)) return '';

  const method = typeof request.method === 'string' ? request.method.toUpperCase() : '';
  const path = formatUrlPath(request.url);
  if (!method && !path) return '';
  return [method, path].filter(Boolean).join(' ');
}

function formatUrlPath(url) {
  if (typeof url !== 'string' || url.length === 0) return '';

  try {
    return new URL(url).pathname || '/';
  } catch {
    const withoutHash = url.split('#', 1)[0];
    const withoutQuery = withoutHash.split('?', 1)[0];
    return withoutQuery || '/';
  }
}

function formatApiErrorSummary(err) {
  const status = err.status ?? err.response?.status ?? err.response?.statusCode ?? '';
  let message = err.message;

  if (isHtmlLike(err.message) || isHtmlLike(err.response?.data)) {
    message = HTML_RESPONSE_SUMMARY;
  } else if (!message && typeof err.response?.statusText === 'string') {
    message = err.response.statusText;
  }

  const head = [status, message ? toOneLine(message) : 'GitHub API error'].filter(Boolean).join(' ');
  const target = formatRequestTarget(err.request);
  const summary = target ? `${head} (${target})` : head;

  return toOneLine(redactSecrets(summary));
}

/**
 * Error を console 出力向けの文字列へ整形する。
 *
 * @param {unknown} err 整形対象のエラー値
 * @returns {string}   API エラーは安全な 1 行要約、それ以外は stack / 文字列
 */
export function formatErrorSummary(err) {
  if (isApiLikeError(err)) {
    return formatApiErrorSummary(err);
  }

  const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return redactSecrets(text);
}

export { HTML_RESPONSE_SUMMARY };
