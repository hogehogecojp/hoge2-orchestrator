import { createServer } from 'net';

import { stripControlChars } from '../engine/build-command.js';
import * as vkBackend from './backend-vk-terminals.js';
import { createTmuxBackend } from './backend-tmux.js';
import { resolveTerminalsMode, resolveTmuxSession, resolveTmuxClaudeCommand } from '../config.js';

// terminals.mode に応じて実行面バックエンドを選択する。実行中に mode は変わらない前提のため、
// 初回解決時に一度だけ生成してモジュールスコープでメモ化する（getStates のポーリングループが
// 約 2 秒おきに呼ぶため、毎回 config を読み直さないようにする）。
let _backend = null;
function backend() {
  if (_backend) return _backend;
  if (resolveTerminalsMode() === 'tmux') {
    _backend = createTmuxBackend({
      session: resolveTmuxSession(),
      claudeCommand: resolveTmuxClaudeCommand(),
    });
  } else {
    _backend = vkBackend;
  }
  return _backend;
}

export const checkHealth        = (...a) => backend().checkHealth(...a);
export const fetchHealth        = (...a) => backend().fetchHealth(...a);
export const getStates          = (...a) => backend().getStates(...a);
export const createNewPane      = (...a) => backend().createNewPane(...a);
export const sendToTerminal     = (...a) => backend().sendToTerminal(...a);
export const setTerminalTitle   = (...a) => backend().setTerminalTitle(...a);
export const setTerminalPrUrl   = (...a) => backend().setTerminalPrUrl(...a);
export const setExternalWaiting = (...a) => backend().setExternalWaiting(...a);
export const setPaneLock        = (...a) => backend().setPaneLock(...a);
export const postMenu           = (...a) => backend().postMenu(...a);

/**
 * OS に空きポートを割り当てさせ、その番号を返す。
 *
 * 戻り値のポートは close 後に再利用されるため、呼び出し元は速やかに対象プロセスへ渡す。
 * timeoutMs は listen/close のコールバックが返らない異常時に Promise が永久 pending となり
 * `up` 全体がハングするのを防ぐ打ち切り時間（fetchHealth 等の timeoutMs と同方針）。
 * バックエンドに依存しない純ヘルパのためここに置く（VK Terminals(GUI) の起動フローで使用）。
 * @param {string} [host='127.0.0.1'] listen するホスト
 * @param {object} [options]
 * @param {number} [options.timeoutMs=3000] ポート確保の打ち切り時間
 * @returns {Promise<number>} 使用可能な TCP ポート番号
 */
export function findFreePort(host = '127.0.0.1', { timeoutMs = 3_000 } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      server.close(() => {});
      finish(reject, new Error(`findFreePort timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    server.once('error', (err) => finish(reject, err));
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((err) => {
        if (err) {
          finish(reject, err);
          return;
        }
        if (typeof port === 'number') {
          finish(resolve, port);
          return;
        }
        finish(reject, new Error('failed to allocate a free port'));
      });
    });
  });
}

/**
 * VK Terminals health の instanceId が今回起動した GUI のものか判定する。
 *
 * 旧 vk-terminals は instanceId を返さないため、その場合は後方互換として通す。
 * 既知の残存リスク: プリフライト検知〜起動後ポーリングの間に instanceId 非対応の
 * 旧版が同ポートを掴んだ場合、legacy 判定で素通りし誤接続し得る（狭い TOCTOU 窓）。
 * ロールアウトで vk-terminals が id 対応版に揃えば解消する想定。
 * @param {{ ok: boolean, instanceId?: string } | null} health /api/health の結果
 * @param {string} expectedInstanceId 今回起動した GUI に渡した instance id
 * @returns {{ ok: true, mode: 'matched'|'legacy', instanceId?: string } | { ok: false, reason: 'unhealthy'|'instance-mismatch', instanceId?: string }}
 */
export function evaluateHealthInstance(health, expectedInstanceId) {
  if (health?.ok !== true) {
    return { ok: false, reason: 'unhealthy' };
  }
  if (!health.instanceId) {
    return { ok: true, mode: 'legacy' };
  }
  if (health.instanceId !== expectedInstanceId) {
    return { ok: false, reason: 'instance-mismatch', instanceId: health.instanceId };
  }
  return { ok: true, mode: 'matched', instanceId: health.instanceId };
}

const CLEAR_INPUT_SEQUENCE = '\x01\x0b';

// 数値オプションを有限な非負整数（0 以上）に正規化する（NaN/Infinity/負数は fallback）。
// 待機時間や再送回数など「0 が有効値」のオプション向け。
const toNonNegativeInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

// 数値オプションを有限な正の整数（1 以上）に正規化する（0/負数/NaN/Infinity は fallback）。
// タイムアウトなど「0 だと機能が沈黙のうちに無効化される」オプション向け。
const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * 自分自身が動作している VK Terminals ペインのタイトルを設定するための
 * OSC 0 エスケープシーケンス文字列を組み立てる。
 *
 * orchestrator（npm start）は自分自身の termId を知らないため、ワーカーペイン用の
 * `/api/set-title`（apiTitle）は使えない。代わりに stdout へ OSC 0/2 を書き込むと
 * VK Terminals(xterm.js) の `onTitleChange` が拾って taskTitle としてペイン上部に
 * 表示する（renderer 側 `getDisplayTitle` は apiTitle || taskTitle。orchestrator の
 * ペインには apiTitle を立てる主体がいないため taskTitle がそのまま表示される）。
 *
 * BEL(\x07) を終端に使う。タイトルに制御文字（特に BEL/ESC）が混じるとシーケンスが
 * 途中で壊れるため、表示不能な制御文字を除去してから埋め込む。除去対象は C0(\x00-\x1f)、
 * DEL(\x7f)、および C1(\x80-\x9f)。8bit C1 を OSC/ST として解釈する端末への多層防御として
 * C1 まで含めて落とす（現状タイトルは静的リテラルだが、将来動的入力を渡しても安全にする）。
 *
 * @param {string} title ペインに表示したいタイトル文字列
 * @returns {string} OSC 0 エスケープシーケンス
 */
export function buildPaneTitleSequence(title) {
  // 制御文字の除去は build-command.js の stripControlChars に集約している（DRY）。
  const safe = stripControlChars(title);
  return `\x1b]0;${safe}\x07`;
}

/**
 * 自分自身のペインタイトルを設定する。
 *
 * stdout が TTY でない（ログファイルへのリダイレクト・パイプ等）場合は、生の
 * エスケープシーケンスで出力を汚さないよう何もしない。
 *
 * @param {string} title 表示したいタイトル
 * @param {NodeJS.WriteStream} [stream=process.stdout] 書き込み先（テスト用に差し替え可能）
 * @returns {boolean} シーケンスを書き込んだら true、TTY でなくスキップしたら false
 */
export function setOwnPaneTitle(title, stream = process.stdout) {
  if (!stream || !stream.isTTY) return false;
  stream.write(buildPaneTitleSequence(title));
  return true;
}

/**
 * VK Terminals の HTTP API が healthy になるまでポーリングで待つ。
 *
 * `up` が GUI(Electron)を起動した直後は API サーバーがまだ listen していないため、
 * orchestrator を起動する前にここで疎通を待つ（待たずに起動しても loop() は健全性
 * ゲートで捌くが、初回 dispatch が POLL_INTERVAL 分遅れるのを避けるため）。
 *
 * @param {number} port VK Terminals API ポート
 * @param {object} [options]
 * @param {number}   [options.timeoutMs=60000]  全体タイムアウト
 * @param {number}   [options.intervalMs=1000]  ポーリング間隔
 * @param {(port:number)=>Promise<boolean>} [options.check=checkHealth] 疎通判定（テスト用に差し替え可能）
 * @param {(ms:number)=>Promise<void>} [options.sleep] 待機関数（テスト用に差し替え可能）
 * @returns {Promise<boolean>} healthy を確認できたら true、タイムアウトなら false
 */
export async function waitForHealth(port, options = {}) {
  const {
    timeoutMs  = 60_000,
    intervalMs = 1_000,
    check      = checkHealth,
    sleep      = (ms) => new Promise(r => setTimeout(r, ms)),
  } = options;

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check(port)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

// 空き（待機中でなく、最近タスクを受け取っていない）ターミナルIDを返す
export async function findIdleTerminal(port, busyTermIds = new Set()) {
  const { terminals } = await getStates(port);
  for (const [, term] of Object.entries(terminals)) {
    if (busyTermIds.has(term.termId)) continue;
    if (term.waiting) continue;
    return term.termId;
  }
  return null;
}

/**
 * 指定 termId の現在の lastOutputTime / lastLines を baseline として取得する。
 * 取得失敗時は null を返し、呼び出し側でフォールスルーさせる。
 *
 * @param {number} port    VK Terminals API ポート
 * @param {string} termId  対象ターミナルID
 * @returns {Promise<{lastOutputTime:number,lastLines:string}|null>}
 */
async function getTerminalBaseline(port, termId) {
  try {
    const { terminals } = await getStates(port);
    const term = Object.values(terminals).find(t => t.termId === termId);
    if (!term) return null;
    return {
      lastOutputTime: term.lastOutputTime ?? 0,
      lastLines:      term.lastLines ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * 送信後に baseline から出力が進んだかをポーリングで確認する。
 * timeoutMs 以内に lastOutputTime と lastLines の両方が変化すれば true を返す。
 * baseline が null（取得失敗）の場合はチェックを諦めて true を返す（誤検知防止）。
 *
 * 判定を AND にしている理由:
 *   カーソル blink などで lastOutputTime だけ進み、lastLines は変わらないケースが
 *   ある。OR 判定だとそのケースを「進んだ」と誤判定してしまうため、両方の変化を
 *   要求する AND 判定にしている。
 *
 * @param {number} port
 * @param {string} termId
 * @param {{lastOutputTime:number,lastLines:string}|null} baseline
 * @param {number} timeoutMs
 * @param {number} pollIntervalMs
 * @returns {Promise<boolean>}
 */
async function confirmOutputProgressed(port, termId, baseline, timeoutMs, pollIntervalMs) {
  if (!baseline) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    try {
      const { terminals } = await getStates(port);
      const term = Object.values(terminals).find(t => t.termId === termId);
      if (!term) {
        // ターミナルが消えた場合は呼び出し側 (waitForTerminalEvent) で検知させる
        return true;
      }
      const progressed =
        (term.lastOutputTime ?? 0) > baseline.lastOutputTime &&
        (term.lastLines ?? '')      !== baseline.lastLines;
      if (progressed) return true;
    } catch {
      // API 一時エラーはスキップしてポーリング継続
    }
  }
  return false;
}

/**
 * Claude Code の起動完了（入力受付可能）を待つ readiness ゲート。
 *
 * createNewPane 直後のペインは Claude Code の TUI が初期描画中で、入力欄（プロンプト）が
 * 現れる前に本文を送ると取りこぼし・誤入力が起こりうる（task-queue#127 の残存リスク）。
 * 特定の TUI 文字列（プロンプト記号やバージョン表記など）に依存すると Claude Code の表示
 * 変更で壊れるため、ここでは「出力が一度現れてから quietMs 以上静止したら初期描画が完了し
 * 入力待ちに入った」とみなすバージョン非依存の判定を採る。
 *
 * readyTimeoutMs を超えても静止を確認できない場合は、ブロックし続けず false を返す
 * （呼び出し側はそのまま送信を試みる＝従来挙動へフォールバックする。ファイル全体の
 * graceful degradation 方針に合わせ、ここではプロセスを落とさない）。
 *
 * @param {number} port    VK Terminals API ポート
 * @param {string} termId  対象ターミナルID
 * @param {object} [options]
 * @param {number} [options.readyTimeoutMs=45000] 静止待ちの全体タイムアウト。
 *   コールドスタートや高負荷時は起動バナーの描画（churn）が長引くため、旧既定の
 *   15 秒では静止を確認できず false に倒れて描画中の窓へ送信してしまう（task-queue#172）。
 *   churn を跨げるよう 45 秒へ広げてある（quietMs/pollIntervalMs は据え置き）。
 * @param {number} [options.quietMs=1000]         入力待ちとみなす無変化の継続時間
 * @param {number} [options.pollIntervalMs=300]   ポーリング間隔
 * @returns {Promise<boolean>} 出力出現後の静止を確認できたら true、タイムアウトなら false
 */
export async function waitForClaudeReady(port, termId, options = {}) {
  const {
    readyTimeoutMs = 45_000,
    quietMs        = 1_000,
    pollIntervalMs = 300,
  } = options;

  // readyTimeoutMs は分割代入デフォルト（=45000）が効くのは undefined のときだけで、
  // env 由来の不正値（"abc"→NaN や負数）はそのまま素通りする。NaN のまま
  // `Date.now() + readyTimeoutMs` にすると deadline が NaN となり while が即 false で
  // readiness ゲートが沈黙のうちに無効化される（負数・0 でも即 false）。正の整数へ
  // 健全化し、不正値は既定 45000 に倒す（fail-safe）。
  const safeReadyTimeoutMs = toPositiveInt(readyTimeoutMs, 45_000);

  // 連続して termId が states に現れなかった回数。起動直後はペイン作成直後で states に
  // まだ反映されていないこと（=消失ではない）があるため、即 false にせず数回猶予する。
  const maxConsecutiveMisses = 5;

  const deadline = Date.now() + safeReadyTimeoutMs;
  let prevSnapshot      = null;     // 直近ポーリング時の {lastOutputTime, lastLines}
  let lastChangeTime    = Date.now(); // 最後に出力が変化した時刻
  let sawOutput         = false;    // 出力が一度でも現れたか
  let consecutiveMisses = 0;        // termId が連続で見つからなかった回数

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollIntervalMs));

    let term;
    try {
      const { terminals } = await getStates(port);
      term = Object.values(terminals).find(t => t.termId === termId);
    } catch {
      // API 一時エラーはスキップしてポーリング継続
      continue;
    }
    // termId が見つからない場合、「ペイン作成直後でまだ states に出ていない」のか
    // 「ペインが消えた」のかを 1 回では区別できない。連続で規定回数見つからなければ
    // 消失とみなして false を返し（送信側の判断に委ねる）、それ未満は猶予して継続する。
    // コールドスタート（本ゲートが守りたいケース）で states 反映が遅れても誤って
    // readiness なし送信に倒れないようにするため。
    if (!term) {
      if (++consecutiveMisses >= maxConsecutiveMisses) return false;
      continue;
    }
    consecutiveMisses = 0;

    const snapshot = {
      lastOutputTime: term.lastOutputTime ?? 0,
      lastLines:      term.lastLines ?? '',
    };
    if (snapshot.lastLines.trim() !== '') sawOutput = true;

    // 前回ポーリングから出力が変化したか（静止検知が目的なので、時刻 or 内容の
    // どちらかが変われば「未静止」とみなす OR 判定。前進検知が目的の
    // confirmOutputProgressed が AND を使うのとは目的が逆である点に注意）。
    const changed =
      prevSnapshot === null ||
      snapshot.lastOutputTime !== prevSnapshot.lastOutputTime ||
      snapshot.lastLines      !== prevSnapshot.lastLines;
    if (changed) {
      lastChangeTime = Date.now();
      prevSnapshot   = snapshot;
    }

    // 出力が現れた後 quietMs 以上静止 → 初期描画完了・入力待ちとみなす
    if (sawOutput && Date.now() - lastChangeTime >= quietMs) {
      return true;
    }
  }
  return false;
}

/**
 * 送信した本文の中から、画面エコー確認に使う「特徴的なトークン」を抽出する。
 *
 * コールドスタート時は起動バナーが本文を飲み込み、Enter だけが消費されて
 * 本文が入力欄に一切入らないことがある（task-queue のバグ再現ケース）。この
 * 取りこぼしを検知するため、Claude Code 側の UI 文字列（バージョンで変わりうる
 * バナーやプロンプト記号）ではなく「自分が送った本文そのもの」の一部が
 * `lastLines` に現れたかどうかで判定する（バージョン非依存）。
 *
 * 空白区切りのトークンのうち、末尾側から見て 4 文字以上のものを拾う。
 * 短い助詞・記号だけのトークンは端末出力（バナーやプロンプト記号など）に偶然
 * 一致しやすく、confirmBodyEchoed が誤って「エコーされた」と判定する原因になる
 * ため照合対象にしない。4 文字以上のトークンが 1 つも無い場合は null を返し、
 * エコー確認自体をスキップさせる（confirmBodyEchoed がフォールスルーで true を
 * 返す＝「判定不能なら誤検知でブロックしない」既存方針に合わせる）。実運用の
 * `/vk-kore <url> wp-env-port=NNNN` 等では十分長いトークンが必ず含まれるため
 * 実害は限定的。
 *
 * @param {string} body 送信した本文（改行除去済み）
 * @returns {string|null} 照合に使うトークン。本文が空、または 4 文字以上の
 *   トークンが無い場合は null（エコー確認自体をスキップする）
 */
function pickEchoFragment(body) {
  const trimmed = String(body).trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].length >= 4) return tokens[i];
  }
  return null;
}

// 画面テキストから落とす制御シーケンス。CSI（ESC [ …）・OSC（ESC ] … BEL/ST）に加え、
// 単独の制御文字も除去する。前置文字列の汚染判定で、目に見えない制御文字を「余計な文字」と
// 誤認しないため（誤認すると健全なタスクを再送・再ディスパッチさせる偽陽性になる）。
//
// OSC 分岐は終端子（BEL / ESC \）だけでなく **行末（$）でも閉じられる**ようにしている。
// lastLines は行幅で切り詰められた画面ダンプなので、OSC が終端子ごと切られてペイロード
// （`0;タイトル…`）だけが可視テキストとして残ることがあるため。この場合は行末までを
// まとめて捨てる＝その行での汚染判定を諦める（fail-open）ことになるが、判定不能を
// 汚染と誤認するよりは安全側。`m` フラグを付けて `$` を「行末」に固定しているので、
// 行単位に適用しても複数行文字列にまとめて適用しても同じ意味になる（現在の呼び出しは
// 行単位。将来まとめて適用されても静かに壊れないようにするためのハードニング）。
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gm;

// Claude Code の入力欄で、本文の直前に現れても「汚染ではない」文字（＝残留文字との境界）。
// 空白（NBSP を含む。JS の \s は   も含む）・プロンプト記号・枠線
// （Box Drawing / Block Elements）など。ここを広く取るほど fail-open（＝汚染とみなさない）側に
// 倒れる。狭くすると未知の UI 装飾を汚染と誤検知して無駄な再送・再ディスパッチを招く。
const RESIDUE_BOUNDARY_CLASS = '\\s　>|｜❯›»▶⏵*·•─-▟';

// 本文の直前に「隙間なく」貼り付いている文字列（＝残留文字）を切り出す正規表現。
// 入力欄への残留は必ず本文と地続きに連結される（`ゴミ/vk-kore …`）ため、境界文字を 1 つでも
// 挟んでいれば残留ではないと判断できる。これにより、実データで観測される
// 「ステータス行と入力プロンプトが 1 行に潰れ、途中で切れた ANSI の残骸（`3;153;153m❯ `）が
// 前に付く」ケースを汚染と誤検知しない（`❯` と空白が境界になる）。
const GLUED_RESIDUE_RE = new RegExp(`[^${RESIDUE_BOUNDARY_CLASS}]*$`);

// 「行頭にあるときだけ意味を持つ」プレフィックス。Claude Code のスラッシュコマンド(`/`)、
// bash モード(`!`)、メモリ追記(`#`)がこれにあたる。1 文字でも前に文字が残ると別物として
// 解釈されるため、この種の本文に限って前置連結を汚染として扱う。
// 逆に通常の散文（返信転送など）は前置文字が付いても意味が壊れにくく、そこまで検知対象を
// 広げると偽陽性（＝無駄な再送・再ディスパッチ）のほうが実害になるため対象外にしている。
const POSITION_SENSITIVE_PREFIXES = ['/', '!', '#'];

/**
 * 汚染判定の起点にする「本文の先頭トークン」を取り出す。
 *
 * 行頭からのズレを見たいので、pickEchoFragment（末尾側トークン）ではなく先頭トークンを使う。
 * 末尾トークンを起点にすると、その手前にある本文自身が「余計な文字」に見えてしまう。
 * 4 文字未満のトークンは端末出力に偶然一致しやすいので判定に使わない（null＝判定不能）。
 *
 * @param {string} body 送信した本文（改行除去済み）
 * @returns {string|null} 先頭トークン。4 文字未満・空なら null
 */
function pickLineAnchor(body) {
  const head = String(body).trim().split(/\s+/)[0] ?? '';
  return head.length >= 4 ? head : null;
}

/**
 * 画面テキストの中に「本文の前に残留文字が連結された行」しか無いかを判定する（issue #189）。
 *
 * ペイン入力欄に残留文字があると、送信本文がその後ろに連結されて
 * `<残留文字>/vk-kore …` という行が確定され、先頭の `/` が行頭からずれてスラッシュ
 * コマンドとして発火しない。断片一致（includes）だけの判定ではこの連結行も
 * 「エコーされた」と見えてしまうため、本文の先頭トークンが現れている行を特定し、
 * その **直前に隙間なく貼り付いた文字**（＝残留文字）が無いかまで見る。
 *
 * **判定不能・判定対象外なら false（＝汚染なし扱い）に倒す fail-open** である点が重要:
 *   - 本文が行頭依存のプレフィックス（POSITION_SENSITIVE_PREFIXES）で始まらない
 *   - 先頭トークンが 4 文字未満（anchor なし）
 *   - 先頭トークンを含む行が 1 つも無い（折り返しでトークンが分断された等）
 *   - 先頭トークンの直前が境界文字（空白・プロンプト記号・枠線）だった
 * 折り返し・ANSI 混入・未知の UI 装飾は日常的に起こるので、ここを fail-closed に
 * すると健全なタスクまでロールバック（`bodyConfirmed===false` 経路の再ディスパッチ）
 * されて実害が大きい。「確実に汚染と言えるときだけ true」を守ること。
 *
 * また、先頭トークンを含む行が複数あるとき、**1 本でも綺麗な行があれば汚染なし**と
 * みなす（過去ログに本文が別文脈で出ているケースを汚染と誤認しないため）。
 *
 * @param {string} lastLines 画面テキスト（複数行）
 * @param {string} body      送信した本文（改行除去済み）
 * @returns {boolean} 汚染を確実に検出できたときだけ true
 */
function detectPrefixContamination(lastLines, body) {
  const trimmedBody = String(body).trim();
  if (!POSITION_SENSITIVE_PREFIXES.includes(trimmedBody[0])) return false; // 対象外 → 汚染なし扱い

  const anchor = pickLineAnchor(trimmedBody);
  if (!anchor) return false;                       // 判定不能 → 汚染なし扱い

  let dirtyFound = false;
  for (const rawLine of String(lastLines).split(/\r?\n/)) {
    const line = rawLine.replace(ANSI_SEQUENCE_RE, '');
    const idx  = line.indexOf(anchor);
    if (idx < 0) continue;
    // 先頭トークンに隙間なく貼り付いている文字列があれば、それが残留文字。
    const residue = line.slice(0, idx).match(GLUED_RESIDUE_RE)?.[0] ?? '';
    if (residue === '') return false;              // 綺麗な行が 1 本でもあれば汚染なし
    dirtyFound = true;
  }
  return dirtyFound;                               // 該当行ゼロ（判定不能）も false
}

/**
 * baseline（本文送信後に取得した lastLines）の中に本文のエコーが確認できるかを判定する。
 *
 * echoFragment が null（本文が空）、または baseline が null（API 一時エラーで取得失敗）の
 * 場合は判定不能として「確認できた」扱いにフォールスルーする（誤検知でブロックし続けない
 * ため。confirmOutputProgressed の baseline=null 時の扱いと同じ方針）。
 *
 * 断片一致に加えて、残留文字の前置連結（issue #189）も見る。連結を**確実に**検出できた
 * ときだけ false を返し、呼び出し側のクリア＋再送ループを発火させる。検出できない・
 * 判定できないケースは従来どおりの断片一致にフォールバックする（fail-open）。
 *
 * @param {{lastLines:string}|null} baseline
 * @param {string|null} echoFragment
 * @param {string} [body=''] 送信した本文（前置連結の判定に使う。省略時は従来判定のみ）
 * @returns {boolean}
 */
function confirmBodyEchoed(baseline, echoFragment, body = '') {
  if (!echoFragment) return true;
  if (!baseline) return true;
  if (!baseline.lastLines.includes(echoFragment)) return false;
  // 断片は出ているが、行頭に残留文字が連結されているなら未確認扱いにして再送させる。
  return !detectPrefixContamination(baseline.lastLines, body);
}

/**
 * 今この瞬間の states を取り直して、本文のエコーが画面に確認できるかを再判定する。
 *
 * submitToClaude が `bodyConfirmed:false` を返しても、エコー確認は偽陽性があり得る
 * （送信〜baseline 取得のタイミング次第でエコーを取りこぼす）。呼び出し側が
 * ロールバック（再ディスパッチ）を発動する直前に、もう一度だけエコーを確認して
 * 偽陽性で無駄な再ディスパッチをしないためのガード。
 *
 * ここは submitToClaude 内の confirmBodyEchoed とは baseline=null（states 取得失敗）
 * の扱いが逆で、意図的に fail-closed にしている:
 *   - echoFragment が null（本文が空 / 4 文字以上のトークンが無い＝そもそも照合対象が
 *     無い）: 判定不能。無駄な再ディスパッチを避けるため従来どおり「確認できた」扱い(true)。
 *   - baseline が null（states 一時取得失敗）: この関数へ来る時点で submitToClaude は
 *     全リトライを尽くしてエコー未確認（echoFragment 非 null かつ baseline 取得済みで
 *     不一致）と判定済みで、本文は未達の公算が高い。最後の 1 回の states ブリップで
 *     「届いた扱い(true)」に倒すと、真に未達のタスクが速い再ディスパッチではなく
 *     idle watchdog（既定 3 時間）まで放置される fail-open の抜けになる。再ディスパッチは
 *     resumeMax で有界なので false（＝再ディスパッチへ進む）に倒すのが #172 の主旨に合う。
 *   - それ以外: 実際にエコーを積極的に確認できたときだけ true。
 *
 * @param {number} port    VK Terminals API ポート
 * @param {string} termId  対象ターミナルID
 * @param {string} prompt  送信した本文（末尾の \r/\n は剥がして照合する）
 * @returns {Promise<boolean>} エコーを確認できた or 照合対象が無い＝true / baseline 取得失敗＝false
 */
export async function reconfirmBodyEcho(port, termId, prompt) {
  const body = String(prompt).replace(/[\r\n]+$/, '');
  const echoFragment = pickEchoFragment(body);
  if (!echoFragment) return true;                 // 照合対象が無い → スキップ（true）
  const baseline = await getTerminalBaseline(port, termId);
  if (!baseline) return false;                    // states 取得失敗 → fail-closed（再ディスパッチへ）
  if (!baseline.lastLines.includes(echoFragment)) return false;
  // 断片は出ていても行頭に残留文字が連結されていれば、スラッシュコマンドとしては
  // 発火しない＝実質未達なので false（再ディスパッチへ）。汚染を確実に検出できた
  // ときだけ倒れる fail-open な判定なので、baseline=null の fail-closed 契約とは独立。
  return !detectPrefixContamination(baseline.lastLines, body);
}

/**
 * Claude Code のプロンプト UI に本文を流し込んで Enter で確定させる。
 *
 * /api/send で `本文 + '\r'` を 1 リクエストで送ると、Claude Code 側が `\r` を
 * 入力欄の改行として吸収し Enter 確定にならない（入力待ちのまま止まる）。
 * 本文と Enter を別リクエストに分け、間に短い待機を入れることで確実に確定させる。
 *
 * ■ 投入前の入力欄クリア
 * 既定では、初回の本文送信の前に CLEAR_INPUT_SEQUENCE（Ctrl-A → Ctrl-K）を撃つ。ペインの
 * 入力欄に残留文字（ユーザーの打ちかけ等）があると本文がその後ろへ連結され、`/vk-kore …` の
 * 先頭 `/` が行頭からずれてスラッシュコマンドとして発火しなくなるため（issue #189）。
 * 空欄では no-op なので既定で前置きしてよいが、生きたダイアログが対象の呼び出しは
 * `clearBeforeSend:false` で外せる（下記「既知の限界（2）」）。
 *
 * 既知の限界（1）: Ctrl-A → Ctrl-K が消せるのは **カーソルのある 1 行だけ** である。
 * ユーザーが Shift+Enter で複数行の下書きを残していた場合、クリアされるのは最終行のみで、
 * 本文は残った行の「次の行」に入る。この形は detectPrefixContamination（行単位で本文の
 * 直前だけを見る判定）でも「綺麗な行」に見えるため素通りし、#189 と同じ症状（本文が
 * 単独行から始まらずスラッシュコマンドが発火しない）が残る。複数行残留への対処は
 * 今回のスコープ外（発生頻度が低く、Esc や複数回クリア等の追加操作は生きた入力への
 * 副作用が読めないため）。
 *
 * 既知の限界（2）: 生きたダイアログ（y/n 確認・権限承認など）が出ているペインへ
 * 制御文字を撃つと何が起きるかは Claude Code 側の実装次第で、こちらからは検証できない。
 * そのようなペインが対象になる呼び出し（返信転送）は `clearBeforeSend:false` を渡して
 * **初回**クリアを撃たないこと。ただし外せるのは初回分だけで、エコー未確認で本文再送に
 * 入れば再送ループのクリアは撃たれる（例: 返信本文が `/` `!` `#` で始まると
 * detectPrefixContamination が発火し得る）。これは #189 以前からある挙動で、再送を
 * 追記でなく置換にするために外せない。
 *
 * ■ 本文エコー確認・再送（主軸）
 * コールドスタート時、起動バナーが描画中に本文を送ると本文が入力欄に届かず
 * 飲み込まれることがある。その状態で Enter を送るとバナー→プロンプトの
 * 再描画が起き、出力自体は「進んだ」ように見えてしまうため、Enter の
 * 確定確認（下記）だけでは本文欠落を検知できない（task-queue の再現バグ）。
 * これを防ぐため、本文送信後の `lastLines` に本文の一部（pickEchoFragment）が
 * 実際にエコーされたかを確認し、確認できなければ Enter だけでなく本文ごと
 * 再送する。Claude Code 側の UI 文字列（バージョンで変わりうるバナー等）には
 * 依存せず、自分が送ったテキストと照合するためバージョン非依存である。
 *
 * ■ Enter 確定確認（補助）
 * 本文エコーを確認できた後も、Enter が一度では確定されず入力欄に張り付いた
 * ままになる稀なケースに備え、Enter 送信「直前」の lastOutputTime / lastLines
 * を baseline として記録し、Enter 送信後に出力が変化しなければ Enter を
 * 再送する（本文は再送しない）。
 *
 * いずれの再送ループも規定回数まで再試行し、最後まで確認できなければ警告ログを
 * 出して return する（呼び出し側の waitForTerminalEvent が別途タイムアウト等で
 * 検知するので、ここではプロセスを落とさない）。
 *
 * baseline を「本文送信前」ではなく「本文送信後・Enter 送信前」に取るのは、
 * Claude Code が本文を受け取った瞬間に入力欄を再描画するため、本文送信前を
 * baseline にすると「Enter が効いていなくても出力は進む」状態になり、Enter が
 * 確定されていなくても progressed=true と誤判定してしまうため。
 *
 * @param {number} port           VK Terminals API ポート
 * @param {string} termId         送信先のターミナルID
 * @param {string} prompt         確定したい本文（末尾の \r/\n は剥がす）
 * @param {number} [delayMs=1000]  送信後に再描画が落ち着くまでの基準待機時間。実際の待機は
 *                                 linear backoff（delayMs × 送信回数）で伸ばし、コールドスタートの
 *                                 起動バナー描画（数秒）を跨げるようにする（task-queue#172）。
 * @param {object} [options]                  再送制御
 * @param {boolean} [options.confirm=true]    本文エコー・出力変化を確認して再送するか
 * @param {boolean} [options.clearBeforeSend=true] 初回の本文送信前に入力欄をクリアするか。
 *                                                 既定 true（#189 の本命ガード）。生きた
 *                                                 ダイアログが出ているペインが対象の呼び出しだけ
 *                                                 false にする（上記「既知の限界（2）」）。
 *                                                 なお本文再送ループ内のクリアはこのオプションに
 *                                                 関係なく従来どおり撃つ（再送を追記でなく置換に
 *                                                 するために不可欠なため）。
 * @param {number}  [options.confirmTimeoutMs=8000]  Enter 確定確認 1 回あたりのタイムアウト
 * @param {number}  [options.pollIntervalMs=500]     確認ポーリング間隔
 * @param {number}  [options.maxRetries=3]           本文再送・Enter 再送それぞれの最大回数
 *                                                   （最初の送信と合わせて最大 maxRetries+1 回まで送信する。
 *                                                   デフォルトの 3 なら本文・Enter それぞれ計 4 回まで送る。
 *                                                   バナー churn を跨いでエコーを確認できるよう #172 で 2→3 に引き上げ）
 * @returns {Promise<object>} `/api/send`（Enter 送信）のレスポンスに `bodyConfirmed` を
 *   加えたオブジェクト（例: `{ ok: true, bodyConfirmed: true }`）。`bodyConfirmed` は
 *   本文が入力欄にエコーされたことを確認できたか:
 *     - `true`  … エコーを確認できた、またはエコー確認をスキップした
 *                 （本文が空 / 4 文字以上のトークンなし / baseline 取得が API エラー）。
 *                 「取りこぼしを検知しなかった」の意。
 *     - `false` … 本文再送を規定回数使い切ってもエコーを確認できなかった＝本文が
 *                 入力欄に届いていない可能性がある。呼び出し側で警告する材料にする。
 *     - `null`  … `confirm:false` のため確認自体を行っていない（true/false と区別する）。
 *   既存の呼び出し側は `result.ok` を見るだけなので、この追加フィールドは後方互換。
 */
export async function submitToClaude(port, termId, prompt, delayMs = 1_000, options = {}) {
  const {
    confirm          = true,
    confirmTimeoutMs = 8_000,
    pollIntervalMs   = 500,
    maxRetries       = 3,
    clearBeforeSend  = true,
  } = options;

  const safeConfirmTimeoutMs = toNonNegativeInt(confirmTimeoutMs, 8_000);
  const safePollIntervalMs   = Math.max(50, toNonNegativeInt(pollIntervalMs, 500));
  const safeMaxRetries       = toNonNegativeInt(maxRetries, 3);
  // delayMs でも算術（linear backoff の乗算）を行うため、他オプション同様に健全化する。
  const safeDelayMs          = toNonNegativeInt(delayMs, 1_000);

  // 本文フェーズの待機を linear backoff（safeDelayMs × 送信回数）で伸ばす。step は
  // 初回送信後の待機を 1 回目として数え、以降 2,3,... と増やす。バナー描画が数秒かかる
  // コールドスタートでも、再送のたびに待機が伸びて描画完了を跨げるようにするため（#172）。
  let bodyWaitStep = 0;
  const waitAfterBodySend = () => new Promise(r => setTimeout(r, safeDelayMs * (++bodyWaitStep)));

  const body = String(prompt).replace(/[\r\n]+$/, '');
  const echoFragment = pickEchoFragment(body);

  // 1) 入力欄をクリアしてから本文を送信し、再描画が落ち着くまで待機（linear backoff の 1 回目）
  //    投入の瞬間に入力欄へ残留文字（ユーザーの打ちかけ・直前の書き込み等）があると、
  //    本文がその後ろに連結されて `<残留文字>/vk-kore …` が確定され、先頭の `/` が
  //    行頭からずれてスラッシュコマンドとして発火しない（issue #189）。
  //    CLEAR_INPUT_SEQUENCE は空の入力欄では no-op なので既定で常時前置きするが、
  //    生きたダイアログへ制御文字を撃ちたくない呼び出しは clearBeforeSend:false で外せる。
  if (clearBeforeSend) {
    await sendToTerminal(port, termId, CLEAR_INPUT_SEQUENCE);
  }
  await sendToTerminal(port, termId, body);
  await waitAfterBodySend();

  if (!confirm) {
    // 従来通り、確認せず即 Enter して return（bodyConfirmed は「未確認」を表す null）
    const enterResult = await sendToTerminal(port, termId, '\r');
    return { ...enterResult, bodyConfirmed: null };
  }

  // 2) 本文が実際に入力欄へ入った（エコーされた）かを確認する。
  //    確認できるまで（規定回数を上限に）本文ごと再送する。
  //    最後に取得した baseline は、確認できてもできなくても、続く Enter 確定
  //    チェックの baseline としてそのまま流用する（Enter 送信「直前」の状態のため）。
  let baseline      = await getTerminalBaseline(port, termId);
  let bodyConfirmed = confirmBodyEchoed(baseline, echoFragment, body);

  for (let attempt = 0; !bodyConfirmed && attempt < safeMaxRetries; attempt++) {
    console.warn(
      `  [submitToClaude] 本文のエコーを確認できません。本文ごと再送します (termId=${termId}, attempt=${attempt + 1}/${safeMaxRetries})`
    );
    try {
      // Ctrl-A で行頭へ戻してから Ctrl-K で行末まで削除する。空欄では no-op で、追記型の入力欄でも再送を置換にできる。
      await sendToTerminal(port, termId, CLEAR_INPUT_SEQUENCE);
      await sendToTerminal(port, termId, body);
    } catch (err) {
      console.warn(`  [submitToClaude] 本文再送失敗（処理は継続）: ${err.message}`);
    }
    await waitAfterBodySend();
    baseline      = await getTerminalBaseline(port, termId);
    bodyConfirmed = confirmBodyEchoed(baseline, echoFragment, body);
  }

  if (!bodyConfirmed) {
    console.warn(
      `  [submitToClaude] 本文再送${safeMaxRetries}回後もエコーを確認できませんでした。Enter 送信を試みます (termId=${termId})`
    );
  }

  // 3) Enter を送信して確定
  const result = await sendToTerminal(port, termId, '\r');

  // 4) 出力変化を確認、変わらなければ Enter を再送（本文は再送しない）
  for (let attempt = 0; attempt <= safeMaxRetries; attempt++) {
    const progressed = await confirmOutputProgressed(
      port, termId, baseline, safeConfirmTimeoutMs, safePollIntervalMs
    );
    if (progressed) return { ...result, bodyConfirmed };

    if (attempt < safeMaxRetries) {
      console.warn(
        `  [submitToClaude] 出力変化なし、Enter を再送します (termId=${termId}, attempt=${attempt + 1}/${safeMaxRetries})`
      );
      try {
        await sendToTerminal(port, termId, '\r');
      } catch (err) {
        console.warn(`  [submitToClaude] Enter 再送失敗（処理は継続）: ${err.message}`);
      }
    }
  }

  console.warn(
    `  [submitToClaude] Enter 再送${safeMaxRetries}回後も出力変化を確認できませんでした (termId=${termId})`
  );
  return { ...result, bodyConfirmed };
}

/**
 * ターミナルの状態変化を監視し、以下のいずれかのイベントを返す:
 *
 * { type: 'waiting',       lastLines }  — term.waiting=true (y/n確認・権限承認など)
 * { type: 'extended-idle', lastLines }  — extendedIdleMs 以上の長時間停止
 *                                          (vk-kore が仕様提案後に止まるケースなど)
 * { type: 'idle',          lastLines }  — idleTimeoutMs のアイドル (通常完了)
 * { type: 'error',         reason    }  — ターミナルが消えた等
 *
 * @param {object} options
 * @param {number} options.idleTimeoutMs     通常完了とみなすアイドル時間 (ms)
 * @param {number} [options.extendedIdleMs]  指示待ちとみなす長時間アイドル (ms)。
 *                                           指定しない場合は検出しない。
 * @param {number} options.pollIntervalMs    ポーリング間隔 (ms)
 */
export async function waitForTerminalEvent(port, termId, options = {}) {
  const {
    idleTimeoutMs    = 10_000,
    extendedIdleMs   = null,
    pollIntervalMs   = 2_000,
  } = options;

  let lastOutputTime = Date.now();
  let lastLines      = '';
  let initialized    = false;

  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      let terminals;
      try {
        ({ terminals } = await getStates(port));
      } catch {
        // API一時エラーはスキップ
        return;
      }

      const term = Object.values(terminals).find(t => t.termId === termId);
      if (!term) {
        clearInterval(interval);
        resolve({ type: 'error', reason: 'terminal_not_found' });
        return;
      }

      // 初回: 現在の出力時刻を起点にする
      if (!initialized) {
        lastOutputTime = term.lastOutputTime ?? Date.now();
        lastLines      = term.lastLines ?? '';
        initialized    = true;
      }

      // 出力の更新を追跡
      if (term.lastOutputTime > lastOutputTime || term.lastLines !== lastLines) {
        lastOutputTime = term.lastOutputTime;
        lastLines      = term.lastLines;
      }

      // ① waiting フラグ検出（y/n確認・権限承認など）
      if (term.waiting) {
        clearInterval(interval);
        resolve({ type: 'waiting', lastLines: term.lastLines });
        return;
      }

      const idle = Date.now() - lastOutputTime;

      // ② 長時間アイドル（vk-kore が仕様確認待ちで止まるケース）
      if (extendedIdleMs !== null && idle >= extendedIdleMs) {
        clearInterval(interval);
        resolve({ type: 'extended-idle', lastLines: term.lastLines });
        return;
      }

      // ③ 通常アイドル（タスク完了）
      if (idle >= idleTimeoutMs) {
        clearInterval(interval);
        resolve({ type: 'idle', lastLines: term.lastLines });
        return;
      }
    }, pollIntervalMs);
  });
}
