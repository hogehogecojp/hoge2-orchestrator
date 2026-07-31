// ~/.task-queue/state.json で「現在実行中のタスク」を記録する。
// scanWaitingInputIssues が返信転送先の termId を引き当てるのに使い、
// scanWatchdog が pane 消失時に wp-env コンテナと worktree を掃除するのに使う。
import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

const STATE_DIR  = join(homedir(), '.task-queue');
const STATE_FILE = join(STATE_DIR, 'state.json');

async function readState() {
  try {
    const text = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : { issues: {} };
  } catch (err) {
    if (err.code === 'ENOENT') return { issues: {} };
    console.warn(`[state] state.json 読み込み失敗、空で初期化します: ${err.message}`);
    return { issues: {} };
  }
}

async function writeState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  // 一時ファイルに書いてから rename することで、書き込み途中のクラッシュで壊れないようにする
  const tmp = STATE_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, STATE_FILE);
}

// 並列タスクが同時に状態を書き換えるとレースで片方のエントリが失われるため、
// read-modify-write をシリアライズするための簡易ミューテックス（promise chain）。
let writeChain = Promise.resolve();

function updateState(mutator) {
  const next = writeChain.then(async () => {
    const state = await readState();
    await mutator(state);
    await writeState(state);
  });
  // チェーンを切らさないために失敗を握りつぶす（呼び出し側には next を返して伝播）
  writeChain = next.catch(() => {});
  return next;
}

// paneTitleUrl は「起動時にペインのヘッダーへ設定した URL」。termId だけでは
// 「その termId のペインが今もこのタスクのものか」を確かめられず、ペインが閉じられた後に
// 実行面が同じ termId を別タスクへ再採番すると、無関係なペインへ通知・差し戻しを
// 送ってしまう（#263）。ペイン側の申告（apiUrl）と突き合わせるための控えとして残す。
export function recordTaskStart({ issueNumber, termId, wpPort, repo, paneTitleUrl = null }) {
  return updateState(state => {
    const key = String(issueNumber);
    // pane 消失による自動再開の回数（resumeCount）は再ディスパッチをまたいで
    // 引き継ぐ（無限リトライ防止の上限判定に使うため、起動で 0 に戻してはいけない）。
    const prevResumeCount = state.issues[key]?.resumeCount;
    // コンフリクト差し戻しの通算試行回数も再ディスパッチでリセットすると上限判定を
    // すり抜けるため、resumeCount と同様にレコード置換をまたいで引き継ぐ。
    const prevConflictHandback = state.issues[key]?.conflictHandback;
    state.issues[key] = {
      termId,
      paneTitleUrl,               // ペイン照合用（#263）。URL 付きで設定できなければ null
      wpPort,
      repo,                       // "owner/repo" 形式（task-queue が把握できる範囲）
      startedAt: new Date().toISOString(),
      ...(prevResumeCount != null ? { resumeCount: prevResumeCount } : {}),
      ...(prevConflictHandback != null ? { conflictHandback: prevConflictHandback } : {}),
    };
  });
}

// レコードが無い issue にも最小レコードを作る（updateTask は既存レコードにしか書かないため、
// state を失ったタスクでも冪等な記録が必要な処理が no-op で沈黙するのを防ぐ）。
export function ensureTaskRecord(issueNumber, seed = {}) {
  return updateState(state => {
    const key = String(issueNumber);
    if (!state.issues[key]) {
      state.issues[key] = {
        termId: null,
        wpPort: null,
        repo: null,
        startedAt: new Date().toISOString(),
        ...seed,
      };
    }
  });
}

// 既存タスクのレコードに patch をマージする（read-modify-write をシリアライズ）。
// 例: 指示待ちで転送済みの返信コメント id をカーソルとして残し、毎ティックの
// スキャンで同じ返信を二重転送しないようにする（lastForwardedCommentId）。
// レコードが無い issue 番号には何もしない（撃ちっぱなし dispatch との競合を避ける）。
export function updateTask(issueNumber, patch) {
  return updateState(state => {
    const key = String(issueNumber);
    if (state.issues[key]) {
      state.issues[key] = { ...state.issues[key], ...patch };
    }
  });
}

export function removeTask(issueNumber) {
  return updateState(state => {
    if (state.issues[String(issueNumber)]) {
      delete state.issues[String(issueNumber)];
    }
  });
}

export async function getTask(issueNumber) {
  const state = await readState();
  return state.issues[String(issueNumber)] ?? null;
}

export async function getAllTasks() {
  const state = await readState();
  return state.issues;
}
