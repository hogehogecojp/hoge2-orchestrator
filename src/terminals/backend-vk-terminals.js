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

/**
 * 全ターミナルの状態を取得する。
 *
 * timeoutMs の既定を 5000ms にしている理由:
 *   この関数は約 2 秒間隔のポーリング tick の中核で、ハングすると全タスクの状態監視・
 *   入力待ち検知・自動マージ判定が止まる（影響最大）。一方でここでの目的は
 *   レイテンシ SLA ではなく「無限ハングの回避」なので、短く締めすぎると高負荷時の
 *   遅延応答を打ち切って states 取得失敗が増え、かえって tick が空回りする。
 *   ポーリング間隔（約 2 秒）より長い 5 秒を取り、遅延応答は待ち切る側に倒す。
 *
 * @param {number} port VK Terminals API ポート
 * @param {object} [options]
 * @param {number} [options.timeoutMs=5000] fetch の打ち切り時間
 * @returns {Promise<object>} `{ terminals: {...} }` 形の states
 */
export async function getStates(port, { timeoutMs = 5_000 } = {}) {
  const res = await fetch(`${BASE_URL(port)}/api/states`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

/**
 * VK Terminals に新規ペインを作成して termId を返す。
 *
 *   cwd を指定するとそのディレクトリで開く（未指定なら VK Terminals 側で HOME にフォールバック）。
 *
 * timeoutMs の既定を 10000ms にしている理由:
 *   ペイン生成は VK Terminals 側で実際の端末（pty）生成を伴い、他の API より重い。
 *   短く締めると「VK Terminals 側では生成に成功したがこちらは abort した」状態になり、
 *   誰も掴んでいない孤児ペインが残る（こちらから閉じる API も無い）。他より長めの
 *   10 秒を取り、abort は本当にハングしているときだけに寄せる。
 *
 * @param {number} port VK Terminals API ポート
 * @param {string|null} [cwd] ペインを開くディレクトリ
 * @param {object} [options]
 * @param {boolean} [options.noClaude] true なら claude を自動起動せず素のシェルとしてペインを開く
 *   （orchestrator 自体をペインで動かす用途など）
 * @param {boolean} [options.stashed] true ならサイドバーに格納した状態でペインを開く
 *   （VK Terminals が未対応の版では未知フィールドとして無視される）
 * @param {number} [options.timeoutMs=10000] fetch の打ち切り時間
 * @returns {Promise<string>} 作成したペインの termId
 */
export async function createNewPane(port, cwd = null, { noClaude, stashed, timeoutMs = 10_000 } = {}) {
  const body = {};
  if (cwd) body.cwd = cwd;
  if (typeof noClaude === 'boolean') body.noClaude = noClaude;
  if (typeof stashed === 'boolean') body.stashed = stashed;
  const res = await fetch(`${BASE_URL(port)}/api/new-pane`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error ?? 'new-pane failed');
  return json.termId;
}

/**
 * 指定ターミナルにテキストを送信する。
 *
 * timeoutMs の既定を 3000ms にしている理由:
 *   `/api/send` は pty への書き込みだけで完了する軽い API なので、fetchHealth /
 *   postMenu と同じ 3 秒で揃える。ここはタスク投入経路（submitToClaude）なので
 *   ハングするとディスパッチが止まる。abort 後の再送は submitToClaude 側が
 *   入力欄クリア → 本文再送（追記ではなく置換）で行うため、打ち切りによる
 *   二重入力にはならない。
 *
 * @param {number} port VK Terminals API ポート
 * @param {string|number} termId 送信先のターミナル ID
 * @param {string} input 送信するテキスト
 * @param {object} [options]
 * @param {number} [options.timeoutMs=3000] fetch の打ち切り時間
 * @returns {Promise<object>} VK Terminals のレスポンス JSON
 */
export async function sendToTerminal(port, termId, input, { timeoutMs = 3_000 } = {}) {
  const res = await fetch(`${BASE_URL(port)}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termId, input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

/**
 * 指定ターミナルのタスクタイトル行に表示するテキストをセットする
 * （VK Terminals 側で空文字なら非表示扱い）。
 *
 * timeoutMs の既定を 3000ms にしている理由: 表示更新だけの軽い API なので
 * fetchHealth / postMenu と同じ 3 秒に揃える。
 *
 * @param {number} port VK Terminals API ポート
 * @param {string|number} termId 対象ターミナル ID
 * @param {string} title 表示するタイトル
 * @param {string|null} [url] タスクに紐づくリンク先 URL。文字列なら body に含めて送信し、
 *   null/undefined なら body に含めない（VK Terminals 旧バージョンとの後方互換のため）。
 * @param {object} [options]
 * @param {number} [options.timeoutMs=3000] fetch の打ち切り時間
 * @returns {Promise<object>} VK Terminals のレスポンス JSON
 */
export async function setTerminalTitle(port, termId, title, url = null, { timeoutMs = 3_000 } = {}) {
  const payload = { termId, title };
  if (typeof url === 'string') payload.url = url;
  const res = await fetch(`${BASE_URL(port)}/api/set-title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
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
 * @param {number} [options.timeoutMs=3000] HTTP リクエスト 1 本あたりの打ち切り時間。
 *   表示更新だけの軽い API なので fetchHealth / postMenu と同じ 3 秒に揃える。
 *   この関数は states 取得 → set-title の 2 本を直列に投げるため、**同じ timeoutMs を
 *   内部の getStates にも伝播させる**（getStates 自身の既定 5000ms は使わない）。
 *   こうすることで最悪の待ち時間が「2 × timeoutMs」で読み切れる形に固定され、
 *   打ち切り時間が意図せず積み上がらない。
 */
export async function setTerminalPrUrl(port, termId, prUrl, { prMerged = false, timeoutMs = 3_000 } = {}) {
  const { terminals } = await getStates(port, { timeoutMs });
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
    signal: AbortSignal.timeout(timeoutMs),
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
 * @param {object} [options]
 * @param {number} [options.timeoutMs=3000] fetch の打ち切り時間。マーカーのフラグ更新だけの
 *   軽い API なので fetchHealth / postMenu と同じ 3 秒に揃える。
 * @returns {Promise<object>} VK Terminals のレスポンス JSON
 */
export async function setExternalWaiting(port, termId, waiting, { timeoutMs = 3_000 } = {}) {
  const res = await fetch(`${BASE_URL(port)}/api/set-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termId, waiting: !!waiting }),
    signal: AbortSignal.timeout(timeoutMs),
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
 * @param {object} [options]
 * @param {number} [options.timeoutMs=3000] fetch の打ち切り時間。ロックのフラグ更新だけの
 *   軽い API なので fetchHealth / postMenu と同じ 3 秒に揃える。打ち切りが無いと
 *   「未応答」は例外にならないため `up` 側の try/catch による graceful degradation が
 *   機能せず、起動そのものが完了しなくなる（issue #218）。
 * @returns {Promise<object>} VK Terminals のレスポンス JSON
 */
export async function setPaneLock(port, termId, lock, { timeoutMs = 3_000 } = {}) {
  const res = await fetch(`${BASE_URL(port)}/api/set-lock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termId, lock }),
    signal: AbortSignal.timeout(timeoutMs),
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
