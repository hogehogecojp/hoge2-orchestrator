// tmux バックエンド。port は無視する。
// 各タスクは split-window でセッションの主 window に並べ、tiled レイアウトで
// 「複数ペインを並べて表示」する（VK Terminals の並列表示に相当）。orchestrator の
// ペインと同じ画面に分割表示されるので、attach した瞬間に分割が見える。termId は pane_id。
// VK Terminals の getStates 形（{terminals:{id:{termId,waiting,lastOutputTime,lastLines}}}）に合わせる。
//
// idle 判定について:
//   tmux の #{window_activity} は window 単位でしか持てず、同じ window に並ぶ全ペイン
//   （orchestrator ＋ 各タスク）で共有されるため、常時ログを吐く orchestrator により
//   全ペインが「活動中」扱いになり、止まったタスクを idle 判定できない。そこで window
//   活動時刻には頼らず、ペインごとに capture-pane の内容変化を自前で追い、内容が変わった
//   ときだけ lastOutputTime を更新する（内容が止まればそのペインだけ idle に落ちる）。
import { spawnSync } from 'node:child_process';

import { stripControlChars } from '../engine/build-command.js';

const CAPTURE_LINES = 40; // capture-pane で取る末尾行数（lastLines のエコー確認に十分な長さ）
// これ未満の残予算では fork/exec 直後の打ち切りが確実なため、無駄なプロセス生成を避ける。
const MIN_CAPTURE_TIMEOUT_MS = 100;
const DEFAULT_TIMEOUT_MS = 3_000;
const WARN_INTERVAL_MS = 60_000;

const TIMEOUTS = Object.freeze({
  // has-session は生存確認だけの軽い処理なので、HTTP 版の health と同じ 3 秒で打ち切る。
  health: 3_000,
  // list-panes は約 2 秒間隔のポーリングで使うが、高負荷時の遅延を誤検知しないよう
  // HTTP 版の states と同じくポーリング間隔より長い 5 秒を取る。
  listPanes: 5_000,
  // submitToClaude の confirmTimeoutMs 既定 8 秒窓を超えないよう、tmux に渡す timeout
  // 引数の合計を 7.5 秒に制限する（fork/exec の実測オーバーヘッドは別途 O(N × 数ms)）。
  // 0.5 秒は呼び出し側の処理余裕だが、将来 8 秒未満の confirmTimeoutMs を渡す場合は要再検討。
  // また、病的に遅い環境で 7.5 秒が常態化すると waitForClaudeReady の 300ms ポーリングが
  // 45 秒で約 6 回となり、quietMs=1000 の静止判定が成立せず readiness ゲートを諦める。
  statesBudget: 7_500,
  // capture-pane は状態取得の残予算内、かつ各 3 秒以内で打ち切る。
  capturePane: 3_000,
  // split-window は実際の端末と Claude の起動を伴うため、HTTP 版の new-pane と同じ 10 秒を取る。
  // tmux には kill-pane があるが、失敗時に事前一覧との差分で自動回収すると、手動分割や
  // 並行ディスパッチのペインを誤って消すレースがあるため、孤児の可能性を warn するに留める。
  createPane: 10_000,
  // send-keys は入力を書き込むだけの軽い処理なので、HTTP 版の send と同じ 3 秒で打ち切る。
  sendKeys: 3_000,
  // レイアウト・window 設定・タイトル更新は表示だけの軽い処理なので 3 秒で打ち切る。
  display: 3_000,
});

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * spawnSync を使う tmux ランナーを作る。
 *
 * @param {object} [options]
 * @param {typeof spawnSync} [options.spawn] テスト用の spawnSync 差し替え
 */
export function createDefaultRun({ spawn = spawnSync } = {}) {
  return function defaultRun(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const safeTimeoutMs = toPositiveInt(timeoutMs, DEFAULT_TIMEOUT_MS);
    // tmux クライアントは状態を持たずサーバーは別プロセスなので、SIGTERM を無視されて
    // spawnSync が戻らない事態を避けるため、打ち切りは確実な SIGKILL を使う。
    const r = spawn('tmux', args, {
      encoding: 'utf8',
      timeout: safeTimeoutMs,
      killSignal: 'SIGKILL',
    });
    let status = r.status ?? 1;
    let stderr = r.stderr ?? '';
    if (r.error || r.signal) {
      // tmux はタイムアウトで打ち切られても status 0 を返すことがある。
      // error/signal があれば status の値にかかわらず必ず失敗へ倒す。
      status = status === 0 ? 1 : status;
      const subcommand = args[0] ?? '';
      let detail;
      if (r.error?.code === 'ETIMEDOUT') {
        detail = `tmux ${subcommand} timed out after ${safeTimeoutMs}ms`;
      } else if (r.error) {
        detail = `tmux ${subcommand} failed to start: ${r.error.message}`;
      } else {
        detail = `tmux ${subcommand} terminated by signal ${r.signal}`;
      }
      stderr = [stderr.trim(), detail].filter(Boolean).join('\n');
    }
    return { status, stdout: r.stdout ?? '', stderr };
  };
}

const defaultRun = createDefaultRun();

/**
 * @param {object} opts
 * @param {string} opts.session       対象 tmux セッション名
 * @param {string} opts.claudeCommand 新規ペインで起動する Claude コマンド
 * @param {(args:string[], options:{timeoutMs:number})=>{status:number,stdout:string,stderr:string}} [opts.run] tmux ランナー（テスト差し替え用）
 * @param {()=>number} [opts.now] 現在時刻(ms)を返す関数（テストで時間を制御するため差し替え可能）
 * @param {(...args:any[])=>void} [opts.warn] 警告ロガー（テスト差し替え用）
 */
export function createTmuxBackend({
  session,
  claudeCommand,
  run = defaultRun,
  now = () => Date.now(),
  warn = (...args) => console.warn(...args),
}) {
  // 生成したペインのみ追跡する（orchestrator ペインやユーザーが開いたものは対象外）。
  // paneId -> { waiting, lastLines, lastChangeMs, lastCaptureMs } を保持する。
  // 内容変化で lastChangeMs を更新し、capture の試行ごとに lastCaptureMs を更新する。
  const panes = new Map();
  const lastWarnMsByCommand = new Map();

  function warnCommandFailure(command, result, suffix = '') {
    const timestamp = now();
    const lastWarnMs = lastWarnMsByCommand.get(command);
    if (lastWarnMs !== undefined && timestamp - lastWarnMs < WARN_INTERVAL_MS) return;
    lastWarnMsByCommand.set(command, timestamp);
    const reason = result?.stderr || `status ${result?.status ?? 'unknown'}`;
    warn(`[tmux] ${command} failed: ${reason}${suffix}`);
  }

  async function fetchHealth() {
    // tmux には instanceId の概念が無いので ok のみ返す。
    return { ok: run(['has-session', '-t', session], { timeoutMs: TIMEOUTS.health }).status === 0 };
  }

  async function checkHealth() {
    return (await fetchHealth()).ok === true;
  }

  async function createNewPane(_port, cwd = null, options = {}) {
    const launch = [];
    if (cwd) launch.push('-c', cwd);
    if (!options.noClaude) launch.push('--', 'sh', '-c', claudeCommand);

    // セッションの主 window を分割して新しいペインを作り、タイル配置に整える。
    const r = run(
      ['split-window', '-t', session, '-P', '-F', '#{pane_id}', ...launch],
      { timeoutMs: TIMEOUTS.createPane }
    );
    const paneId = r.stdout.trim();
    if (r.status !== 0 || !paneId) {
      warnCommandFailure(
        'split-window',
        r,
        '（pane id を取得できず、起動済みの孤児ペインが残った可能性があります）'
      );
      throw new Error(`tmux split-window failed: ${r.stderr || 'no pane id'}`);
    }
    const layout = run(['select-layout', '-t', session, 'tiled'], { timeoutMs: TIMEOUTS.display });
    if (layout.status !== 0) warnCommandFailure('select-layout', layout);
    // 各ペインの上部にタイトル（タスク名）を出せるようにする（冪等）。
    const border = run(
      ['set-window-option', '-t', session, 'pane-border-status', 'top'],
      { timeoutMs: TIMEOUTS.display }
    );
    if (border.status !== 0) warnCommandFailure('set-window-option', border);

    panes.set(paneId, {
      waiting: false,
      lastLines: '',
      lastChangeMs: now(),
      lastCaptureMs: 0,
    });
    return paneId;
  }

  async function sendToTerminal(_port, termId, input) {
    const args = (input === '\r' || input === '\n')
      ? ['send-keys', '-t', termId, 'Enter']
      : ['send-keys', '-t', termId, '-l', '--', input];
    const r = run(args, { timeoutMs: TIMEOUTS.sendKeys });
    // 失敗を握りつぶすと本文が届かないまま進んでしまうため、status を見て例外化し、
    // 呼び出し側（submitToClaude の再送やポーリング）に再試行させる。
    if (r.status !== 0) throw new Error(`tmux send-keys failed (status ${r.status}): ${r.stderr || ''}`);
    return { ok: true };
  }

  async function getStates() {
    const deadline = now() + TIMEOUTS.statesBudget;
    // セッション内の現存ペイン一覧を取る。取得失敗（tmux 一時エラー等）は throw して
    // 呼び出し側のポーリングで再試行させる。ここで空扱いにすると追跡中ペインを
    // 全部「消えた」と誤検知してしまうため、prune は list-panes 成功時のみ行う。
    const list = run(
      ['list-panes', '-s', '-t', session, '-F', '#{pane_id}'],
      { timeoutMs: Math.min(TIMEOUTS.listPanes, Math.max(1, deadline - now())) }
    );
    if (list.status !== 0) {
      throw new Error(`tmux list-panes failed (status ${list.status}): ${list.stderr || ''}`);
    }
    const present = new Set(
      list.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)
    );

    const terminals = {};
    // 一度も capture できていないペインを含め、最終試行が古い順に回して予算切れによる
    // 挿入順末尾の恒常的な飢餓を防ぐ。失敗時も試行時刻を更新し、失敗ペインの居座りを防ぐ。
    const ordered = [...panes.entries()]
      .sort((a, b) => (a[1].lastCaptureMs ?? 0) - (b[1].lastCaptureMs ?? 0));
    for (const [paneId, state] of ordered) {
      if (!present.has(paneId)) {
        // ペインが消えた → 報告しない（pane-missing 検知に乗る）＋ 内部 Map からも除去
        //（tmux の pane id は再利用されないため安全）。
        panes.delete(paneId);
        continue;
      }
      const remaining = deadline - now();
      if (remaining < MIN_CAPTURE_TIMEOUT_MS) {
        warnCommandFailure(
          'capture-pane:budget',
          { status: 1, stderr: `getStates budget exhausted after ${TIMEOUTS.statesBudget}ms` }
        );
        terminals[paneId] = {
          termId: paneId,
          waiting: state.waiting,
          lastOutputTime: state.lastChangeMs,
          lastLines: state.lastLines,
        };
        continue;
      }
      const cap = run(
        ['capture-pane', '-p', '-t', paneId, '-S', `-${CAPTURE_LINES}`],
        { timeoutMs: Math.min(TIMEOUTS.capturePane, remaining) }
      );
      state.lastCaptureMs = now();
      if (cap.status === 0) {
        // 内容が前回から変化したときだけ活動時刻を更新する（ペイン単位の idle 判定）。
        if (cap.stdout !== state.lastLines) {
          state.lastLines = cap.stdout;
          state.lastChangeMs = now();
        }
      } else {
        warnCommandFailure('capture-pane', cap);
      }
      // capture 失敗時は前回値を維持する（空にすると「画面がクリアされた」と誤認するため）。
      terminals[paneId] = {
        termId: paneId,
        waiting: state.waiting,
        lastOutputTime: state.lastChangeMs,
        lastLines: state.lastLines,
      };
    }
    return { terminals };
  }

  async function setExternalWaiting(_port, termId, waiting) {
    const p = panes.get(String(termId));
    if (p) p.waiting = !!waiting;
    return { ok: true };
  }

  async function setTerminalTitle(_port, termId, title) {
    if (title) {
      const result = run(
        ['select-pane', '-t', termId, '-T', stripControlChars(title)],
        { timeoutMs: TIMEOUTS.display }
      );
      if (result.status !== 0) warnCommandFailure('select-pane', result);
    }
    return { ok: true };
  }

  // 飾り系。tmux では表示対象・保護対象が無いので no-op。
  async function setTerminalPrUrl() { return { ok: true }; }
  async function setPaneLock() { return { ok: true }; }
  async function postMenu() { return { ok: true }; }

  return {
    checkHealth, fetchHealth, getStates, createNewPane, sendToTerminal,
    setTerminalTitle, setTerminalPrUrl, setExternalWaiting, setPaneLock, postMenu,
  };
}
