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

const CAPTURE_LINES = 40; // capture-pane で取る末尾行数（lastLines のエコー確認に十分な長さ）

function defaultRun(args) {
  const r = spawnSync('tmux', args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * @param {object} opts
 * @param {string} opts.session       対象 tmux セッション名
 * @param {string} opts.claudeCommand 新規ペインで起動する Claude コマンド
 * @param {(args:string[])=>{status:number,stdout:string,stderr:string}} [opts.run] tmux ランナー（テスト差し替え用）
 * @param {()=>number} [opts.now] 現在時刻(ms)を返す関数（テストで時間を制御するため差し替え可能）
 */
export function createTmuxBackend({ session, claudeCommand, run = defaultRun, now = () => Date.now() }) {
  // 生成したペインのみ追跡する（orchestrator ペインやユーザーが開いたものは対象外）。
  // paneId -> { waiting, lastLines, lastChangeMs } を保持し、内容変化で lastChangeMs を更新する。
  const panes = new Map();

  async function fetchHealth() {
    // tmux には instanceId の概念が無いので ok のみ返す。
    return { ok: run(['has-session', '-t', session]).status === 0 };
  }

  async function checkHealth() {
    return (await fetchHealth()).ok === true;
  }

  async function createNewPane(_port, cwd = null, options = {}) {
    const launch = [];
    if (cwd) launch.push('-c', cwd);
    if (!options.noClaude) launch.push('--', 'sh', '-c', claudeCommand);

    // セッションの主 window を分割して新しいペインを作り、タイル配置に整える。
    const r = run(['split-window', '-t', session, '-P', '-F', '#{pane_id}', ...launch]);
    const paneId = r.stdout.trim();
    if (r.status !== 0 || !paneId) throw new Error(`tmux split-window failed: ${r.stderr || 'no pane id'}`);
    run(['select-layout', '-t', session, 'tiled']);
    // 各ペインの上部にタイトル（タスク名）を出せるようにする（冪等）。
    run(['set-window-option', '-t', session, 'pane-border-status', 'top']);

    panes.set(paneId, { waiting: false, lastLines: '', lastChangeMs: now() });
    return paneId;
  }

  async function sendToTerminal(_port, termId, input) {
    const args = (input === '\r' || input === '\n')
      ? ['send-keys', '-t', termId, 'Enter']
      : ['send-keys', '-t', termId, '-l', '--', input];
    const r = run(args);
    // 失敗を握りつぶすと本文が届かないまま進んでしまうため、status を見て例外化し、
    // 呼び出し側（submitToClaude の再送やポーリング）に再試行させる。
    if (r.status !== 0) throw new Error(`tmux send-keys failed (status ${r.status}): ${r.stderr || ''}`);
    return { ok: true };
  }

  async function getStates() {
    // セッション内の現存ペイン一覧を取る。取得失敗（tmux 一時エラー等）は throw して
    // 呼び出し側のポーリングで再試行させる。ここで空扱いにすると追跡中ペインを
    // 全部「消えた」と誤検知してしまうため、prune は list-panes 成功時のみ行う。
    const list = run(['list-panes', '-s', '-t', session, '-F', '#{pane_id}']);
    if (list.status !== 0) {
      throw new Error(`tmux list-panes failed (status ${list.status}): ${list.stderr || ''}`);
    }
    const present = new Set(
      list.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)
    );

    const terminals = {};
    const t = now();
    for (const [paneId, state] of panes) {
      if (!present.has(paneId)) {
        // ペインが消えた → 報告しない（pane-missing 検知に乗る）＋ 内部 Map からも除去
        //（tmux の pane id は再利用されないため安全）。
        panes.delete(paneId);
        continue;
      }
      const cap = run(['capture-pane', '-p', '-t', paneId, '-S', `-${CAPTURE_LINES}`]);
      if (cap.status === 0) {
        // 内容が前回から変化したときだけ活動時刻を更新する（ペイン単位の idle 判定）。
        if (cap.stdout !== state.lastLines) {
          state.lastLines = cap.stdout;
          state.lastChangeMs = t;
        }
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
    if (title) run(['select-pane', '-t', termId, '-T', String(title)]);
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
