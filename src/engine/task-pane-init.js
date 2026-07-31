// -------------------------------------------------------
// 作業ペインの初期化（通常起動 / コンフリクト差し戻し 共通）
//
// 作業ペインは「ヘッダーのタイトル（元 issue）」と「PR ボタン（PR URL）」が揃って
// 初めて通常起動のペインと同じ状態になる。ところが従来はこの初期化が
//
//   - 通常起動 startTask         … 元 issue を解決して resolvedTarget を渡す
//   - 差し戻し ensureConflictHandbackPane … 何も渡さない
//
// と呼び出し側ごとにバラバラで、差し戻しペインだけタイトルがメタ issue になり、
// PR URL も登録されないままだった（#258）。PR URL の登録は PR 検知時の
// recordPRAcrossSurfaces() が 1 回だけ行う設計で、差し戻しは PR 検知よりずっと後に
// 起きるためこの経路は二度と通らない。
//
// 再発防止として「元 issue の解決 → ペイン作成 → PR URL 登録」を本モジュールに一本化し、
// 呼び出し側は openInitializedTaskPane() だけを使う。副作用（GitHub API / VK Terminals API）は
// すべて依存注入で受け取り、ユニットテストから分岐を検証できるようにしている。
//
// 失敗の扱い（重要）:
//   - ペイン作成の失敗   … throw して呼び出し元に伝える（ペインが無ければ何も始まらない）
//   - 元 issue の取得失敗 … warn で握る（タイトルは cosmetic。メタ issue 表示へフォールバック）
//   - PR URL の送信失敗   … warn で握る（PR ボタンは cosmetic。差し戻し本体を止めない）
// -------------------------------------------------------

/**
 * ペインヘッダーに出す「元の作業対象 issue」を解決する。
 *
 * task-queue のメタ issue 本文に元 issue の URL が含まれていれば、その元 issue の
 * タイトル・リンクをヘッダーに出す（issue #23）。解決できない汎用タスク（isSelf）や
 * 取得失敗時は null を返し、buildPaneTitle() のメタ issue フォールバックに委ねる。
 *
 * ペインタイトルは付随処理（cosmetic）なので、リトライ（最大13秒）でタスク起動や
 * コンフリクト差し戻しをブロックしないよう retryDelays: [] の単発試行にする。
 *
 * @param {{owner:string, repo:string, number:number, isSelf:boolean}|null} resolved
 *   resolveTarget(issue) の結果
 * @param {object} deps
 * @param {(owner:string, repo:string, number:number, options?:object)=>Promise<{title:string, htmlUrl:string}>} deps.getIssueState
 * @param {string} [deps.logTag='[set-title]'] ログプレフィクス
 * @param {object} [deps.logger=console]
 * @returns {Promise<{number:number, title:string, url:string}|null>} buildPaneTitle へ渡す resolvedTarget
 */
export async function resolveTargetIssueForTitle(resolved, { getIssueState, logTag = '[set-title]', logger = console } = {}) {
  if (!resolved || resolved.isSelf) return null;
  try {
    const original = await getIssueState(
      resolved.owner,
      resolved.repo,
      resolved.number,
      { retryDelays: [] }
    );
    return { number: resolved.number, title: original.title, url: original.htmlUrl };
  } catch (err) {
    logger.warn?.(`  ${logTag} 元 issue 情報の取得失敗（メタ issue 表示にフォールバック）: ${err.message}`);
    return null;
  }
}

/**
 * ペインへ PR URL を送り、上部の PR ボタンから PR ページへ飛べるようにする。
 *
 * PR URL が無い（未検知）場合は何もしない。空文字を送ると VK Terminals 側では
 * 「PR 未設定」＝ボタン非表示になるため、既に出ているボタンを消さないよう明示的に弾く。
 *
 * 送るのは **trim 後の値**。判定（空かどうか）と送信で基準がずれると、前後に空白の付いた
 * 値がそのまま保存され、trim して比較する notify-pane-merged.js の readPanePrUrl() と
 * 表現が食い違う（現在の抽出経路では空白は付かないが、基準は揃えておく）。
 *
 * 送信失敗は warn で握る。PR ボタンは付随表示であり、これを理由に呼び出し元の
 * タスク起動・コンフリクト差し戻しを止めるべきではない（recordPRAcrossSurfaces と同方針）。
 *
 * @param {object} params
 * @param {(port:number, termId:string|number, prUrl:string)=>Promise<object>} params.setTerminalPrUrl
 * @param {number} params.port
 * @param {string|number|null} params.termId
 * @param {string|null} params.prUrl
 * @param {string} [params.logTag='[set-pr-url]']
 * @param {object} [params.logger=console]
 * @returns {Promise<boolean>} 送信できたら true（未送信・失敗は false）
 */
export async function attachPrUrlToPane({ setTerminalPrUrl, port, termId, prUrl, logTag = '[set-pr-url]', logger = console }) {
  if (termId == null) return false;
  if (typeof prUrl !== 'string') return false;
  const url = prUrl.trim();
  if (url === '') return false;

  try {
    await setTerminalPrUrl(port, termId, url);
    return true;
  } catch (err) {
    logger.warn?.(`  ${logTag} PR URL 送信失敗（処理は継続）: ${err.message} (termId=${termId}, prUrl=${url})`);
    return false;
  }
}

/**
 * 作業ペインを作成し、通常起動と同じ状態（タイトル・元 issue・PR URL）まで初期化する。
 *
 * createInitializedTaskPane の唯一の呼び出し口。ここを通すことで、通常起動と差し戻しで
 * 初期化内容がずれる #258 のような不整合が構造的に起きないようにしている。
 *
 * @param {object} params
 * @param {object} params.issue            task-queue 側のメタ issue（{ number, title, html_url }）
 * @param {object|null} params.resolved    resolveTarget(issue) の結果
 * @param {string} params.cwd              ペインの作業ディレクトリ
 * @param {string|null} [params.prUrl=null] 担当 PR の HTML URL（未検知なら null）
 * @param {(args:{issue:object, cwd:string, resolvedTarget:object|null, createdLogTag:string, titleLogTag:string, readyLogTag:string})=>Promise<string|number>} params.createInitializedTaskPane
 * @param {function} params.getIssueState  resolveTargetIssueForTitle 参照
 * @param {function} params.setTerminalPrUrl attachPrUrlToPane 参照
 * @param {number} params.port             VK Terminals API ポート
 * @param {string} [params.createdLogTag]  ペイン作成ログのプレフィクス
 * @param {string} [params.titleLogTag]    タイトル・元 issue 解決のログプレフィクス
 * @param {string} [params.readyLogTag]    Claude 起動待ちのログプレフィクス
 * @param {string} [params.prUrlLogTag]    PR URL 登録のログプレフィクス。タイトル系と分けるのは、
 *   PR URL の送信失敗が `[set-title]` の接頭辞で出るとログから原因を辿れなくなるため
 * @param {object} [params.logger=console]
 * @returns {Promise<string|number>} 作成したペインの termId
 * @throws ペイン作成に失敗した場合（呼び出し元で握る）
 */
export async function openInitializedTaskPane({
  issue,
  resolved,
  cwd,
  prUrl = null,
  createInitializedTaskPane,
  getIssueState,
  setTerminalPrUrl,
  port,
  createdLogTag = '→ 新規ペイン作成',
  titleLogTag = '[set-title]',
  readyLogTag = '[ready]',
  prUrlLogTag = '[set-pr-url]',
  logger = console,
}) {
  const resolvedTarget = await resolveTargetIssueForTitle(resolved, {
    getIssueState,
    logTag: titleLogTag,
    logger,
  });

  const termId = await createInitializedTaskPane({
    issue,
    cwd,
    resolvedTarget,
    createdLogTag,
    titleLogTag,
    readyLogTag,
  });

  // PR URL の送信は termId が決まってからしかできないため、必ずペイン作成の後に行う。
  await attachPrUrlToPane({
    setTerminalPrUrl,
    port,
    termId,
    prUrl,
    logTag: prUrlLogTag,
    logger,
  });

  return termId;
}
