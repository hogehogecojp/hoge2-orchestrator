// VK Terminals(HTTP API) バックエンド。実行面として Electron/GUI の VK Terminals を
// 127.0.0.1:13847 の HTTP API 経由で駆動する。ここにある 8 プリミティブは
// src/terminals/index.js から移設したもので、挙動は不変。
//
// VK Terminals API の接続先ホスト。既定は localhost。
// VK Terminals が Tailscale IP 等の特定インターフェースだけにバインドしている場合は
// .env の VK_TERMINALS_HOST で接続先を上書きできる。
// 注意: dotenv の config() は index.js の ES import より後に走るため、ここで
// モジュール読み込み時に process.env を固定すると .env の値が間に合わない。
// 必ず「呼び出し時」に読むこと（関数化している理由）。
const apiHost = () => process.env.VK_TERMINALS_HOST ?? '127.0.0.1';
const BASE_URL = (port) => `http://${apiHost()}:${port}`;

// VK Terminals が起動しているか確認
// timeoutMs: 応答しないホスト（Tailscale IP 未接続など）で fetch が無限にハングして
// 呼び出し側（waitForHealth のポーリング等）が固まるのを防ぐための打ち切り時間。
export async function fetchHealth(port, { timeoutMs = 3_000 } = {}) {
  try {
    const res = await fetch(`${BASE_URL(port)}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json();
    if (!json || typeof json !== 'object') return null;
    const health = { ok: json.ok === true };
    if (typeof json.instanceId === 'string' && json.instanceId !== '') {
      health.instanceId = json.instanceId;
    }
    return health;
  } catch {
    return null;
  }
}

// VK Terminals が起動しているか確認
// 既存呼び出しとの互換性のため boolean 契約を維持する。
export async function checkHealth(port, { timeoutMs = 3_000 } = {}) {
  const health = await fetchHealth(port, { timeoutMs });
  return health?.ok === true;
}

// 全ターミナルの状態を取得
export async function getStates(port) {
  const res = await fetch(`${BASE_URL(port)}/api/states`);
  return res.json();
}

// VK Terminals に新規ペインを作成して termId を返す
//   cwd を指定するとそのディレクトリで開く（未指定なら VK Terminals 側で HOME にフォールバック）。
//   options.noClaude=true を渡すと claude を自動起動せず素のシェルとしてペインを開く
//   （orchestrator 自体をペインで動かす用途など）。
//   options.stashed=true を渡すとサイドバーに格納した状態でペインを開く
//   （VK Terminals が未対応の版では未知フィールドとして無視される）。
export async function createNewPane(port, cwd = null, options = {}) {
  const body = {};
  if (cwd) body.cwd = cwd;
  if (typeof options.noClaude === 'boolean') body.noClaude = options.noClaude;
  if (typeof options.stashed === 'boolean') body.stashed = options.stashed;
  const res = await fetch(`${BASE_URL(port)}/api/new-pane`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error ?? 'new-pane failed');
  return json.termId;
}

// 指定ターミナルにテキストを送信
export async function sendToTerminal(port, termId, input) {
  const res = await fetch(`${BASE_URL(port)}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termId, input }),
  });
  return res.json();
}

// 指定ターミナルのタスクタイトル行に表示するテキストをセット
// （VK Terminals 側で空文字なら非表示扱い）
/**
 * @param {string|null} [url] タスクに紐づくリンク先 URL。文字列なら body に含めて送信し、
 *   null/undefined なら body に含めない（VK Terminals 旧バージョンとの後方互換のため）。
 */
export async function setTerminalTitle(port, termId, title, url = null) {
  const payload = { termId, title };
  if (typeof url === 'string') payload.url = url;
  const res = await fetch(`${BASE_URL(port)}/api/set-title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok || !json.ok) {
    throw new Error(json?.error ?? `set-title failed: HTTP ${res.status}`);
  }
  return json;
}

/**
 * 指定ターミナルに PR URL をセットする。
 *
 * VK Terminals issue #44 で導入された PR ボタン表示用のフィールド `apiPrUrl` に流し込む。
 * タスク登録リポジトリ側（orchestrator）は PR を検知した時点でこの関数を呼び、ペイン上部の
 * タスクタイトル行から PR ページへ直接ジャンプできるようにする。
 *
 * 実装メモ:
 *   VK Terminals 側は `/api/set-title` の `prUrl` / `prMerged` フィールドで受け取る仕様で、
 *   `title` / `url` / `prUrl` / `prMerged` をペアで置換するセマンティクスを持つ。
 *   そのため prUrl だけ単独更新するには、先に getStates で現在の apiTitle / apiUrl を
 *   取得してから一緒に送り直す必要がある。
 *   prMerged を省略すると VK Terminals 側で false 扱いになり、マージ済み表示は解除される。
 *
 *   呼び出し側 (recordPRAcrossSurfaces) は失敗を warn で握りつぶす運用なので、
 *   状態取得などの途中失敗は throw して上に伝える。
 *
 * @param {number} port           VK Terminals API ポート
 * @param {string|number} termId  対象ターミナル ID
 * @param {string|null} prUrl     PR の HTML URL（クリアしたい場合は空文字）
 * @param {object} [options]
 * @param {boolean} [options.prMerged=false] PR ボタンをマージ済み表示（紫）へ切り替えるフラグ。
 *   既定 false。省略時は VK Terminals 側でも false 扱いになる。
 */
export async function setTerminalPrUrl(port, termId, prUrl, { prMerged = false } = {}) {
  const { terminals } = await getStates(port);
  // /api/states のレスポンス形が想定外（terminals 欠落・非オブジェクト）だと
  // Object.values(undefined) で TypeError になり原因が追いづらいため、
  // 明示的に検証して原因が分かるエラーメッセージを返す。
  if (!terminals || typeof terminals !== 'object') {
    throw new Error(`invalid states response from VK Terminals (port=${port}): terminals missing`);
  }
  const term = Object.values(terminals).find(t => String(t.termId) === String(termId));
  if (!term) {
    throw new Error(`terminal ${termId} not found`);
  }
  const payload = {
    termId,
    title:    term.apiTitle ?? '',
    url:      term.apiUrl   ?? '',
    prUrl:    prUrl ?? '',
    prMerged: prMerged === true,
  };
  const res = await fetch(`${BASE_URL(port)}/api/set-title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error ?? `set-title (prUrl) failed: HTTP ${res.status}`);
  }
  return json;
}

/**
 * 指定ターミナルの入力待ちマーカー状態を VK Terminals へセットする。
 *
 * externalWaiting は `/api/set-status` だけが更新する。`/api/set-title` は title/url/prUrl の
 * 置換用で waiting を反映しないため、状態引き継ぎのための getStates は不要。
 * VK Terminals 側は waiting を厳密な boolean として検証するため、送信前に `!!` で正規化する。
 *
 * @param {number} port              VK Terminals API ポート
 * @param {string|number} termId     対象ターミナル ID
 * @param {*} waiting                入力待ちマーカーを点灯するなら truthy、消灯するなら falsy
 * @returns {Promise<object>} VK Terminals のレスポンス JSON
 */
export async function setExternalWaiting(port, termId, waiting) {
  const res = await fetch(`${BASE_URL(port)}/api/set-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termId, waiting: !!waiting }),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error ?? `set-status failed: HTTP ${res.status}`);
  }
  return json;
}

/**
 * 指定ペインの閉じる保護（close ロック）を設定する。
 *
 * `lock: { close: false }` で閉じる操作を保護し、`lock: null` で解除する。
 * `/api/set-lock` は VK Terminals 1.21.0 で導入されたため、未対応の旧版では
 * 404 等で throw する。ロックが必須でない呼び出し側は失敗を握りつぶし、
 * graceful degradation で継続する想定。
 *
 * @param {number} port          VK Terminals API ポート
 * @param {string|number} termId 対象ターミナル ID
 * @param {object|null} lock     設定するロック。例: `{ close: false }` または `null`
 * @returns {Promise<object>} VK Terminals のレスポンス JSON
 */
export async function setPaneLock(port, termId, lock) {
  const res = await fetch(`${BASE_URL(port)}/api/set-lock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termId, lock }),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error ?? `set-lock failed: HTTP ${res.status}`);
  }
  return json;
}

/**
 * VK Terminals のサイドバーメニューへセクションを投稿する。
 *
 * POST /api/menu は source 単位で丸ごと置換する冪等 API のため、起動時・接続確立時・
 * ポーリングごとに何度呼んでも安全。timeoutMs は未応答ホスト（Tailscale IP 未接続等）で
 * fetch が無限にハングするのを防ぐ打ち切り時間（checkHealth と同じ理由）。
 *
 * @param {number} port VK Terminals API ポート
 * @param {object} section 投稿するメニューセクション payload
 * @param {object} [options]
 * @param {number} [options.timeoutMs=3000] fetch の打ち切り時間
 * @returns {Promise<object>} VK Terminals のレスポンス JSON
 */
export async function postMenu(port, section, { timeoutMs = 3_000 } = {}) {
  const res = await fetch(`${BASE_URL(port)}/api/menu`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(section),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error ?? `menu post failed: HTTP ${res.status}`);
  }
  return json;
}
