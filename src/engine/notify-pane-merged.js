// -------------------------------------------------------
// PR マージ済みの作業ペイン通知
//
// 2 段構えで通知する:
//   1) VK Terminals の PR ボタンを「マージ済み」表示に切り替える（バッジ通知）
//   2) 作業ペインの会話へ「マージされた」旨のメッセージを 1 通投稿する（テキスト投稿）
//
// バッジだけだと「気づいたらマージされていた」状態になり、どういう経緯でマージされたのかが
// ペインの履歴に残らない（#241）。テキストを 1 通残すことで経緯を追えるようにする。
//
// テキスト投稿はペインで動いている Claude へ「プロンプト」として届く＝実行される入力なので、
// バッジ書き換えより慎重に扱う。具体的には次を満たしてから投稿する:
//   - PR URL を正規化し、URL に見せかけた指示文（プロンプト注入）を落とす
//   - 送信先ペインが本当にその PR の担当かを、バッジ通知より前に確認する
//   - 入力待ち（承認ダイアログ等）で止まっているペインへは投稿しない
//   - 同じ PR について二重投稿しない（送信中を含む）
//
// 本流の close / done / cleanup を止めるほど重要ではないため、通知失敗は warn で握る。
// 依存関数は呼び出し側から注入し、ユニットテストで実 state / 実 VK Terminals API を
// 叩かずに分岐を検証できるようにしている。
// -------------------------------------------------------

// 送信済みマークのプロセス内フォールバック上限。state からマークを引けない経路
// （removeTask 後・state レコードが無い issue）でも同一プロセス中の二重投稿を防ぐが、
// 常駐プロセスで無制限に溜めないよう挿入順に古いものから捨てる。
const NOTICE_MEMO_LIMIT = 500;

/**
 * @param {object} deps
 * @param {(issueNumber:number|string)=>Promise<object|null>} deps.getTask
 * @param {(port:number, termId:string|number, prUrl:string, options?:object)=>Promise<object>} deps.setTerminalPrUrl
 * @param {(port:number)=>Promise<object>} [deps.getStates]
 *   ペイン一覧の取得。prUrl からの termId 逆引きと、投稿先ペインの確認
 *   （担当 PR が一致するか・入力待ちで止まっていないか）に使う。
 * @param {(port:number, termId:string|number, prompt:string, delayMs?:number, options?:object)=>Promise<object>} [deps.submitToClaude]
 *   ペインへテキストを投稿する関数。未注入ならバッジ通知だけ行う（テキスト投稿はスキップ）。
 *   入力欄の残留文字クリアと再送を持つ submitToClaude を渡すこと（sendToTerminal 直叩きは
 *   残留文字と本文が連結する既知の不具合経路）。
 * @param {(issueNumber:number|string, patch:object)=>Promise<any>} [deps.updateTask]
 *   送信済みマークの永続化に使う。未注入の場合や state レコードが既に消えている issue では
 *   マークが残らないため、二重投稿の抑止は「同一プロセス内のメモのみ」に縮退する
 *   （updateTask はレコードの無い issue には何も書かないため。プロセスを跨ぐ再投稿は防げない）。
 * @param {number} deps.port
 * @param {number} [deps.submitDelayMs] submitToClaude の delayMs
 * @param {object} [deps.submitOptions] submitToClaude のオプション
 * @param {object} [deps.logger=console]
 * @returns {(issueNumber:number|string, prUrl:string, logTag:string, options?:{mergedByOrchestrator?:boolean})=>Promise<void>}
 */
export function createNotifyPaneMerged({
  getTask,
  setTerminalPrUrl,
  getStates = null,
  submitToClaude = null,
  updateTask = null,
  port,
  submitDelayMs = undefined,
  submitOptions = {},
  logger = console,
}) {
  const postedNotices = new Set();
  // 処理中（判定〜投稿）の通知キー。loop() は setInterval で再入ガードが無く、submitToClaude は
  // 本文再送とエコー確認で数十秒かかりうるため、ポーリング間隔をまたいで同じ通知が重なりうる。
  // postedNotices は送信「成功後」にしか積まないので、走行中の重複はこちらで弾く。
  const inFlightNotices = new Set();

  return async function notifyPaneMerged(issueNumber, prUrl, logTag, options = {}) {
    // 既定は「外部マージ（検知）」。オーケストレーター自身がマージした経路だけ true を渡す。
    const { mergedByOrchestrator = false } = options ?? {};

    // prUrl は GitHub API 由来ではなくメタ issue 本文から抽出した文字列で、本文は編集できる。
    // 本文はペインの Claude へプロンプトとして届くため、URL に見せかけた指示文が混じっていたら
    // 投稿自体を見送る（お知らせなので、危ういまま送るより送らない方が安全側）。
    // 重複判定のキー・送信済みマークも正規化後の URL で揃える（本文に載る値と一致させる）。
    const safePrUrl = normalizePrUrl(prUrl);
    if (safePrUrl == null && typeof submitToClaude === 'function') {
      logger.warn?.(`  ${logTag} issue #${issueNumber}: PR URL の形式が不正なためマージ通知メッセージの投稿を見送ります。prUrl=${prUrl}`);
    }

    // テキスト投稿の権利は、最初の await を挟む前に「同期で」予約する。判定（state 読み・
    // ペイン確認）にも await が入るため、投稿直前に予約したのでは重なった 2 回が両方とも
    // 判定を通り抜けてしまう。予約できなかった呼び出しはバッジ通知だけ行う。
    const noticeKey = safePrUrl == null ? null : `${issueNumber} ${safePrUrl}`;
    const reservedNotice = noticeKey != null && !inFlightNotices.has(noticeKey);
    if (reservedNotice) inFlightNotices.add(noticeKey);

    try {
      let task = null;
      try {
        task = await getTask(issueNumber);
      } catch (err) {
        logger.warn?.(`  ${logTag} issue #${issueNumber}: state から termId を取得できませんでした。prUrl=${prUrl} (${err.message})`);
      }
      let termId = task?.termId ?? null;
      // prUrl 逆引きで引いたペインは、引いた時点で担当 PR の一致を確認済み。
      // waiting の確認には使うので、ペインそのものを持ち回る。
      let matchedPane = null;
      if (termId == null) {
        logger.warn?.(`  ${logTag} issue #${issueNumber}: state に termId が無いため、prUrl から VK Terminals ペインを逆引きします。prUrl=${prUrl}`);
        matchedPane = await findPaneByPrUrl({ getStates, port, prUrl, issueNumber, logTag, logger });
        if (matchedPane == null) return;
        termId = matchedPane.termId;
      }

      // テキスト投稿の可否は「バッジ通知より前」に判定する。
      // setTerminalPrUrl(prMerged) は対象ペインへ prUrl を書き込むため、バッジ通知の後に
      // 「ペインの担当 PR が一致するか」を確かめると自分で書いた値と照合することになり、
      // 別タスクのペインを掴んでいても必ず一致してしまう（検証にならない）。
      const message = reservedNotice
        ? await planMergedMessage({
          submitToClaude,
          postedNotices,
          noticeKey,
          task,
          getStates,
          port,
          termId,
          matchedPane,
          issueNumber,
          prUrl,
          safePrUrl,
          logTag,
          mergedByOrchestrator,
          logger,
        })
        : null;

      try {
        await setTerminalPrUrl(port, termId, prUrl, { prMerged: true });
        (logger.info ?? logger.log)?.(`  ${logTag} issue #${issueNumber}: VK Terminals へ prMerged を通知しました (termId=${termId}, prUrl=${prUrl})`);
      } catch (err) {
        logger.warn?.(`  ${logTag} issue #${issueNumber}: VK Terminals への prMerged 通知失敗（処理は継続）: ${err.message} (termId=${termId}, prUrl=${prUrl})`);
      }

      if (message == null) return;

      await postMergedMessage({
        submitToClaude,
        updateTask,
        postedNotices,
        noticeKey,
        message,
        port,
        termId,
        issueNumber,
        prUrl: safePrUrl,
        logTag,
        submitDelayMs,
        submitOptions,
        logger,
      });
    } finally {
      if (reservedNotice) inFlightNotices.delete(noticeKey);
    }
  };
}

/**
 * テキスト投稿の要否・可否を判定し、投稿する本文を返す（投稿しないなら null）。
 *
 * マージ検知は merge-watch / scan-in-progress / reconcile-orphaned から冪等に何度も走るため、
 * 同じ PR について 2 回以上投稿しないよう「state の送信済みマーク（mergedNoticeSentPrUrl）」
 * 「プロセス内メモ」「処理中キー（呼び出し側で予約済み）」の三段で抑止する。
 */
async function planMergedMessage({
  submitToClaude,
  postedNotices,
  noticeKey,
  task,
  getStates,
  port,
  termId,
  matchedPane,
  issueNumber,
  prUrl,
  safePrUrl,
  logTag,
  mergedByOrchestrator,
  logger,
}) {
  if (typeof submitToClaude !== 'function') return null;
  if (postedNotices.has(noticeKey) || task?.mergedNoticeSentPrUrl === safePrUrl) {
    return null;
  }

  if (!(await canPostToPane({
    getStates, port, termId, prUrl, matchedPane, issueNumber, logTag, logger,
  }))) {
    return null;
  }

  return buildMergedMessage(safePrUrl, mergedByOrchestrator);
}

/**
 * 送信先ペインがマージ通知の投稿先としてふさわしいかを確認する。
 *
 * 見ているのは 2 点。
 *
 * (1) そのペインが本当にこの PR の担当か。
 *     state 由来の termId は古くなりうる（tmux の pane_id は再採番されるため、別タスクの
 *     ペインを指すことがある）。バッジ書き換えだけなら軽微だったが、テキスト投稿は無関係な
 *     ペインへの割り込み指示になるため、投稿前に照合する。
 *
 *     実行面ごとの扱い（判断の方針）:
 *       - ペイン一覧を取得できない（getStates 未注入・取得失敗・形式不正）→ state を信頼して
 *         投稿する。照合できないことを理由に一律スキップすると、実行面の一時不調でお知らせが
 *         出なくなるため。
 *       - 対象 termId のペインが一覧に無い → 投稿しない。ペインが消えている（または別 id へ
 *         採番し直された）ときにどのペインへ届くか確証が無い。
 *       - ペインは在るが担当 PR を保持していない（tmux など apiPrUrl/prUrl を持たない実行面）
 *         → state を信頼して投稿する。ここを不一致扱いにすると、その実行面ではテキスト通知が
 *         一切出なくなるため。tmux のペイン一覧は orchestrator 自身が作ったペインに限られる。
 *       - ペインが別の PR を担当している → 投稿しない（掴み違いが確定しているため）。
 *
 * (2) そのペインが入力待ちで止まっていないか（pane.waiting）。
 *     waiting は「y/n 確認・権限承認などでユーザーの入力を待っている」状態。submitToClaude は
 *     最後に必ず Enter を撃つため（clearBeforeSend:false でも Enter は止まらない）、この状態へ
 *     投稿すると承認ダイアログの既定選択を機械が黙って確定させ、ユーザーが承認していない
 *     ツール実行を通してしまう。マージ検知は waiting-input の issue にも到達する主要経路なので
 *     コーナーケースではない。新規ディスパッチ先を選ぶ findIdleTerminal も同じ理由で
 *     waiting のペインを除外している（src/terminals/index.js）。
 *     ここでスキップしても送信済みマークは書かないため、承認が済んでペインが動き出した後の
 *     ループで改めて届く。
 *
 * @param {object|null} [params.matchedPane] prUrl 逆引きで既に特定済みのペイン。渡された場合は
 *   担当 PR の照合は済んでいるものとして扱い、waiting だけを見る（states の再取得もしない）。
 */
async function canPostToPane({ getStates, port, termId, prUrl, matchedPane, issueNumber, logTag, logger }) {
  let pane = matchedPane ?? null;

  if (pane == null) {
    if (typeof getStates !== 'function') return true;

    let states;
    try {
      states = await getStates(port);
    } catch (err) {
      logger.warn?.(`  ${logTag} issue #${issueNumber}: VK Terminals states 取得失敗。termId の担当 PR を確認できないため state の termId を使います。prUrl=${prUrl} (${err.message})`);
      return true;
    }

    const terminals = states?.terminals;
    if (!terminals || typeof terminals !== 'object') return true;

    pane = Object.values(terminals).find(
      (p) => p && typeof p === 'object' && String(p.termId) === String(termId)
    );
    if (!pane) {
      logger.warn?.(`  ${logTag} issue #${issueNumber}: termId のペインが見つからないためマージ通知メッセージの投稿を見送ります (termId=${termId}, prUrl=${prUrl})`);
      return false;
    }

    const panePrUrl = pane.apiPrUrl ?? pane.prUrl ?? null;
    if (panePrUrl != null && panePrUrl !== prUrl) {
      logger.warn?.(`  ${logTag} issue #${issueNumber}: termId のペインが別の PR を担当しているためマージ通知メッセージの投稿を見送ります (termId=${termId}, pane=${panePrUrl}, prUrl=${prUrl})`);
      return false;
    }
  }

  if (pane.waiting === true) {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: ペインが入力待ち（承認ダイアログ等）のためマージ通知メッセージの投稿を見送ります（次ループで再試行）(termId=${termId}, prUrl=${prUrl})`);
    return false;
  }

  return true;
}

/**
 * ペインへマージ済みメッセージを 1 通投稿する。
 *
 * 送信済みマークは送信成功後にだけ記録し、送信前に落ちた場合は次ループで再試行できるようにする
 * （走行中の重複は呼び出し側が予約する処理中キーで弾いている）。
 *
 * 失敗・例外はすべて warn で握る。ここで throw すると呼び出し元の close / done / cleanup を
 * 止めてしまうため。submitToClaude が bodyConfirmed:false を返した場合も、タスク投入時の
 * ような status:ready 戻しのロールバックは行わない（お知らせの取りこぼしより、ロールバックの
 * 副作用や再送による二重投稿の方が害が大きいため）。
 */
async function postMergedMessage({
  submitToClaude,
  updateTask,
  postedNotices,
  noticeKey,
  message,
  port,
  termId,
  issueNumber,
  prUrl,
  logTag,
  submitDelayMs,
  submitOptions,
  logger,
}) {
  let result;
  try {
    result = await submitToClaude(port, termId, message, submitDelayMs, submitOptions);
  } catch (err) {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: マージ通知メッセージの投稿失敗（処理は継続）: ${err.message} (termId=${termId}, prUrl=${prUrl})`);
    return;
  }

  rememberNotice(postedNotices, noticeKey);
  try {
    await updateTask?.(issueNumber, { mergedNoticeSentPrUrl: prUrl });
  } catch (err) {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: マージ通知の送信済みマーク記録失敗（処理は継続）: ${err.message} (prUrl=${prUrl})`);
  }

  if (result?.bodyConfirmed === false) {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: マージ通知メッセージが入力欄に届いていない可能性があります（再送はしません）(termId=${termId}, prUrl=${prUrl})`);
    return;
  }
  (logger.info ?? logger.log)?.(`  ${logTag} issue #${issueNumber}: 作業ペインへマージ通知メッセージを投稿しました (termId=${termId}, prUrl=${prUrl})`);
}

/**
 * PR URL から owner / repo / number だけを取り出して組み直す。
 *
 * メタ issue 本文の抽出正規表現は「空白以外」を広く拾うため、日本語のように空白を含まない
 * 指示文を URL の途中へ紛れ込ませられる。ここで組み直すことで、本文に載るのは
 * `https://github.com/<owner>/<repo>/pull/<番号>` だけになる。
 *
 * @returns {string|null} 正規化した URL。取り出せなければ null。
 */
function normalizePrUrl(prUrl) {
  const m = String(prUrl ?? '').match(
    /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/
  );
  return m ? `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` : null;
}

/**
 * マージ通知の本文を組み立てる。
 *
 * - 「誰がマージしたのか」を冒頭 2 文で言い切る。ペインを流れる 1 行として頭から読まれるため、
 *   結論が後ろに来ると自動マージと外部マージを取り違える。
 * - ペインの Claude へプロンプトとして届くので、「追加の作業・返信は不要」に加えて
 *   「新しい作業を始めないでください」という独立した命令文を必ず添える。
 * - PR URL は文末に置く。文中に置くと直後の記号までターミナルの URL 検出に巻き込まれうる。
 * - 短いお知らせなので 1 行に収める（改行しても届くが、複数行にする必要が無い）。
 * - 2 文面が違うのは「誰がマージしたか」を述べる冒頭 2 文と、それに続く 3 文目の頭
 *   （このタスクは完了のため / 完了として扱うため）まで。その後ろは共通。
 *
 * 「automerge 設定」ではなく「automerge ラベル」と書くのは、自動マージの判定が実際に
 * メタ issue の automerge ラベルだから。「設定」と書くと読み手が設定ファイルを探しに行き、
 * 「なぜ勝手にマージされたのか」の答えに辿り着けない。
 *
 * 外部マージ側で「検知しました」と断定しないのは意図的。automerge 直後の投稿に失敗して
 * merge-watch が拾い直す経路では、実際にはオーケストレーターがマージしていても既定文面になる。
 */
function buildMergedMessage(prUrl, mergedByOrchestrator) {
  const head = mergedByOrchestrator
    ? 'オーケストレーターがマージしました。automerge ラベルによる自動マージです。このタスクは完了のため、'
    : 'この PR がマージされました。オーケストレーター以外がマージした可能性があります。このタスクは完了として扱うため、';
  return `${head}追加の作業・返信は不要です。このメッセージを起点に新しい作業を始めないでください。対象 PR: ${prUrl}`;
}

function rememberNotice(postedNotices, noticeKey) {
  postedNotices.add(noticeKey);
  while (postedNotices.size > NOTICE_MEMO_LIMIT) {
    const oldest = postedNotices.values().next().value;
    postedNotices.delete(oldest);
  }
}

/**
 * prUrl を担当している VK Terminals ペインを逆引きする。
 * termId だけでなくペインごと返すのは、呼び出し側が waiting の確認にも使うため。
 */
async function findPaneByPrUrl({ getStates, port, prUrl, issueNumber, logTag, logger }) {
  if (typeof getStates !== 'function') {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: getStates が無いため prUrl 逆引きをスキップします。prUrl=${prUrl}`);
    return null;
  }

  let states;
  try {
    states = await getStates(port);
  } catch (err) {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: VK Terminals states 取得失敗。prUrl 逆引きをスキップします。prUrl=${prUrl} (${err.message})`);
    return null;
  }

  const terminals = states?.terminals;
  if (!terminals || typeof terminals !== 'object') {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: VK Terminals states の形式が不正なため prUrl 逆引きできません。prUrl=${prUrl}`);
    return null;
  }

  const term = Object.values(terminals).find((pane) => {
    if (!pane || typeof pane !== 'object') return false;
    return pane.apiPrUrl === prUrl || pane.prUrl === prUrl;
  });
  if (!term?.termId) {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: prUrl に一致する VK Terminals ペインが見つかりません。prUrl=${prUrl}`);
    return null;
  }

  return term;
}
