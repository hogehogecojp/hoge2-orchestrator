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

import { PANE_OWNERSHIP, findPaneByTermId, resolvePaneOwnership } from './pane-identity.js';
// ペイン由来の値をログへ出す前の正規化（既存の共通実装を再利用する。#253）。
import { stripAnsiAndControlChars } from './build-command.js';

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

      // ペインの素性は「バッジ通知より前」に 1 回だけ確かめる。
      // setTerminalPrUrl(prMerged) は対象ペインへ prUrl を書き込むため、バッジ通知の後に
      // 「ペインの担当 PR が一致するか」を確かめると自分で書いた値と照合することになり、
      // 別タスクのペインを掴んでいても必ず一致してしまう（検証にならない）。
      //
      // テキスト投稿の要否（重複抑止）に関わらず毎回照合するのは、バッジ通知が抑止の対象外で
      // 毎回走るため。ここを投稿判定の中に閉じ込めると、2 回目以降のマージ検知では未照合のまま
      // 別タスクのペインへバッジを書いてしまう。
      const paneCheck = await inspectTargetPane({
        getStates,
        port,
        termId,
        matchedPane,
        expectedPrUrl: prUrl,
        // paneTitleUrl はペイン起動時に setTerminalTitle で設定した URL。この変更より前に
        // 起動したタスクのレコードには存在しないため、その場合は照合材料なしとして扱う。
        expectedTitleUrl: task?.paneTitleUrl ?? null,
        issueNumber,
        logTag,
        logger,
      });

      const message = reservedNotice
        ? planMergedMessage({
          submitToClaude,
          postedNotices,
          noticeKey,
          task,
          paneCheck,
          termId,
          issueNumber,
          prUrl,
          safePrUrl,
          logTag,
          mergedByOrchestrator,
          logger,
        })
        : null;

      // 別タスクのペインだと確定した場合はバッジも書かない。無関係なペインの PR ボタンが
      // 「マージ済み」に化けると、そのペインの担当者が自分の PR がマージされたと誤読する。
      if (paneCheck.ownership === PANE_OWNERSHIP.OTHER_TASK) {
        logger.warn?.(`  ${logTag} issue #${issueNumber}: ${describeOtherTaskPane(paneCheck)}ため VK Terminals への prMerged 通知を見送ります (termId=${termId}, prUrl=${prUrl})`);
        return;
      }

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
function planMergedMessage({
  submitToClaude,
  postedNotices,
  noticeKey,
  task,
  paneCheck,
  termId,
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

  if (!canPostToPane({ paneCheck, termId, prUrl, issueNumber, logTag, logger })) {
    return null;
  }

  return buildMergedMessage(safePrUrl, mergedByOrchestrator);
}

/**
 * 通知先ペインを特定し、そのペインが本当にこのタスクのものかを照合する。
 *
 * state 由来の termId は古くなりうる。ペインを閉じても termId が state に残る経路があり
 * （#263）、実行面が同じ id を別タスクのペインへ再採番すると無関係なペインを指す。
 * 照合の判断基準は pane-identity.js に集約し、ここでは「取得できたか」だけを扱う。
 *
 * 「照合できなかった」は 2 種類あり、**扱いを分ける**（unverifiableReason）:
 *
 *   - 'states-unavailable' … 一時的に材料が取れなかった（取得失敗・形式不正）。次ループでは
 *     取れる見込みがあるので、テキスト投稿は見送って持ち越す。ここを state 信頼に倒すと、
 *     VK Terminals API が落ちている間だけ修正前の挙動（誤爆しうる状態）に戻ってしまう。
 *   - 'no-identity' … そもそも材料が無い（tmux 等の実行面・getStates 未注入の構成・
 *     paneTitleUrl の無い既存タスク）。待っても解決しないので state を信頼する。ここを
 *     見送りに倒すと、その実行面・その既存タスクでは通知が永久に出なくなる。
 *
 * 対象 termId のペインが一覧に無い場合は found:false。テキスト投稿はしない（ペインが消えて
 * いる、または別 id へ採番し直されたときにどのペインへ届くか確証が無い）。
 *
 * @param {object|null} [params.matchedPane] prUrl 逆引きで既に特定済みのペイン。逆引きした
 *   時点で担当 PR の一致は確認済みなので、所有者として扱う（states の再取得もしない）。
 * @returns {Promise<{pane:object|null, found:boolean|null, ownership:string, unverifiableReason:string|null, mismatch:string|null, paneValue:string|null, expectedValue:string|null}>}
 *   found は true / false / null（一覧を取得できず在否そのものが不明）。
 */
async function inspectTargetPane({
  getStates, port, termId, matchedPane, expectedPrUrl, expectedTitleUrl, issueNumber, logTag, logger,
}) {
  const unverifiable = (pane, found, unverifiableReason) => ({
    pane, found, ownership: PANE_OWNERSHIP.UNVERIFIABLE, unverifiableReason,
    mismatch: null, paneValue: null, expectedValue: null,
  });

  if (matchedPane != null) {
    return {
      pane: matchedPane,
      found: true,
      ownership: PANE_OWNERSHIP.OWNER,
      unverifiableReason: null,
      mismatch: null,
      paneValue: null,
      expectedValue: null,
    };
  }

  // getStates 未注入は照合の仕組みそのものが配線されていない状態。index.js では必ず注入して
  // いるので現状は到達しないが、将来配線が外れたときに「最も作用の強いテキスト投稿だけが
  // 黙って照合なしに戻る」のは避けたいので、fail-close 側（見送り）に分類する。
  // 見送りを黙って続けると「通知が来ないのにログに何も無い」状態になるため、必ず痕跡を残す。
  // この経路だけは次ループでも直らない（配線の問題）ので、そう分かる文言にする。
  if (typeof getStates !== 'function') {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: ペイン一覧の取得手段（getStates）が配線されていないためペインを照合できず、マージ通知メッセージの投稿を見送ります（この状態は再試行では解消しません。配線を確認してください）。prUrl=${expectedPrUrl}`);
    return unverifiable(null, null, 'states-unavailable');
  }

  let states;
  try {
    states = await getStates(port);
  } catch (err) {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: VK Terminals states 取得失敗。termId のペインを照合できないためマージ通知メッセージの投稿を見送ります（次ループで再試行）。prUrl=${expectedPrUrl} (${err.message})`);
    return unverifiable(null, null, 'states-unavailable');
  }

  // terminals の欠落・非オブジェクトは VK Terminals 側のバージョン差・仕様変更で現実に起きうる。
  // 黙って見送ると「通知が来ないのにログに何も無い」状態が続くため、ここでも痕跡を残す。
  const terminals = states?.terminals;
  if (!terminals || typeof terminals !== 'object') {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: VK Terminals states の形式が不正（terminals が取れません）でペインを照合できないため、マージ通知メッセージの投稿を見送ります（次ループで再試行）。prUrl=${expectedPrUrl}`);
    return unverifiable(null, null, 'states-unavailable');
  }

  // 在否そのものが分かっているので照合不能の理由は 'pane-missing'（呼び出し側は found で弾く）。
  const pane = findPaneByTermId(terminals, termId);
  if (!pane) return unverifiable(null, false, 'pane-missing');

  const ownership = resolvePaneOwnership({ pane, expectedPrUrl, expectedTitleUrl });
  // spread はこの関数が付ける情報より先に置く。後に置くと、resolvePaneOwnership が将来
  // pane / found / unverifiableReason と同名のキーを返したとき、黙って上書きされてしまう。
  return {
    ...ownership,
    pane,
    found: true,
    // ペインは見えているのに判定できない＝材料そのものが無い。待っても解決しない側。
    unverifiableReason: ownership.ownership === PANE_OWNERSHIP.UNVERIFIABLE ? 'no-identity' : null,
  };
}

/**
 * 送信先ペインがマージ通知の投稿先としてふさわしいかを確認する。
 *
 * 見ているのは 4 点。
 *
 * (1) そのペインが一覧に在るか（inspectTargetPane の found）。
 *
 * (2) そのペインが本当にこのタスクの担当か（inspectTargetPane の ownership）。
 *     バッジ書き換えだけなら軽微だったが、テキスト投稿は無関係なペインへの割り込み指示に
 *     なるため、投稿前に照合する。
 *
 * (3) 照合そのものができなかった場合、それが一時的か恒久的か（unverifiableReason）。
 *     一時的（states 取得失敗・形式不正）なら見送って次ループへ持ち越す。テキスト投稿は
 *     ペインで実行されるプロンプトであり、この照合が守りたい当のものなので、材料が取れない
 *     間まで state 信頼で送ってしまうと守りが穴になる。恒久的（tmux 等・既存タスク）なら
 *     待っても解決しないので state を信頼する。
 *     見送っても送信済みマークは書かないため取りこぼしにはならない（次ループで再試行）。
 *
 * (4) そのペインが入力待ちで止まっていないか（pane.waiting）。
 *     waiting は「y/n 確認・権限承認などでユーザーの入力を待っている」状態。submitToClaude は
 *     最後に必ず Enter を撃つため（clearBeforeSend:false でも Enter は止まらない）、この状態へ
 *     投稿すると承認ダイアログの既定選択を機械が黙って確定させ、ユーザーが承認していない
 *     ツール実行を通してしまう。マージ検知は waiting-input の issue にも到達する主要経路なので
 *     コーナーケースではない。新規ディスパッチ先を選ぶ findIdleTerminal も同じ理由で
 *     waiting のペインを除外している（src/terminals/index.js）。
 *     ここでスキップしても送信済みマークは書かないため、承認が済んでペインが動き出した後の
 *     ループで改めて届く。
 */
function canPostToPane({ paneCheck, termId, prUrl, issueNumber, logTag, logger }) {
  if (paneCheck.found === false) {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: termId のペインが見つからないためマージ通知メッセージの投稿を見送ります (termId=${termId}, prUrl=${prUrl})`);
    return false;
  }

  if (paneCheck.ownership === PANE_OWNERSHIP.OTHER_TASK) {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: ${describeOtherTaskPane(paneCheck)}ためマージ通知メッセージの投稿を見送ります (termId=${termId}, prUrl=${prUrl})`);
    return false;
  }

  // 照合材料が取れなかった場合は見送る。この分類に落ちる 3 経路（getStates 未注入・取得失敗・
  // 形式不正）は **すべて inspectTargetPane 側の return 地点で warn 済み** なので、ここでは
  // 重ねない。見送りの痕跡が残らないと「通知が来ないのにログに何も無い」状態になるため、
  // 経路を足すときは必ずその return 地点にも warn を置くこと。
  if (paneCheck.unverifiableReason === 'states-unavailable') return false;

  if (paneCheck.pane?.waiting === true) {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: ペインが入力待ち（承認ダイアログ等）のためマージ通知メッセージの投稿を見送ります（次ループで再試行）(termId=${termId}, prUrl=${prUrl})`);
    return false;
  }

  return true;
}

/**
 * 別タスクのペインと判定した理由をログ用の 1 句にする。
 *
 * 「PR が違う」と「ヘッダーリンクが違う」では原因も対処も別（前者は termId の取り違え、
 * 後者は termId の再採番）なので、どちらで弾いたのかと実際の値を必ず残す。
 * 文末を「〜ている」で揃え、呼び出し側が「…ため〜を見送ります」と続けられるようにする。
 *
 * ペイン側の値だけ正規化するのは、これが VK Terminals から受け取った外部由来の値だから。
 * ログはコンソールに出るうえ issue へ貼られる運用があり、制御文字・ANSI が混じると表示が
 * 崩れる（#253 と同じ経路）。期待値の側は github.com 由来でスキーム検証済みのため触らない
 * （buildPaneTitle が URL を触らないのと同じ線引き）。
 */
function describeOtherTaskPane({ mismatch, paneValue, expectedValue }) {
  const safePaneValue = stripAnsiAndControlChars(paneValue);
  return mismatch === 'pr-url'
    ? `termId のペインが別の PR を担当している（pane=${safePaneValue}, 期待=${expectedValue}）`
    : `termId のペインが別タスクへ再利用されている（ペインのヘッダー=${safePaneValue}, 起動時に設定=${expectedValue}）`;
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
