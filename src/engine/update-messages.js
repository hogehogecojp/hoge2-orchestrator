/**
 * アップデートに関する文言のカタログ（唯一の正）。
 *
 * 同じ状況を伝える文が「起動時のログ」と「設定画面のお知らせ」で違っていると、
 * サポート時に別の問題として扱われてしまう。そこで文言はここだけに置き、
 * 両方へ同じ文字列を流す。環境（git clone / 配布 zip）による出し分けもここで行う。
 *
 * ここは副作用を持たない純粋関数だけで構成する（fs もネットワークも触らない）。
 *
 * お知らせの色分け（tone）の使い分け:
 *   - warning … 人が何かしないと直らない
 *   - info    … 知っておけばよい・放っておけば直る
 *
 * この基準に照らすと、同じ「アップデートを見送った」でも tone は非対称になる。未コミット変更は
 * 利用者がコミットするか退避しないと次の起動でも見送られ続けるので warning、main 以外のブランチは
 * 作業を終えて main に戻れば自然に解消するので info。見た目の揃いより「人の手が必要か」を優先する。
 *
 * ここに文言を足すときは、その状態が実際に起こりうるか（到達可能か）を必ず確認すること。
 * 選択は上から順の早期 return なので、先に出る条件が常に真だと後ろの文言は永久に表示されない。
 */

/** お知らせを表示しない状態（最新で問題なし）を表す。 */
export const NO_UPDATE_NOTICE = null;

/** 「長く確認できていない」と扱う日数。これを超えると warning のお知らせを出す。 */
export const STALE_CHECK_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 日時を「2026年7月30日 9:12」の形式にする。
 * 端末のログと設定画面で同じ表記にするため、書式もここに 1 つだけ持つ。
 * @param {Date|string|number|null} value
 * @returns {string|null}
 */
export function formatCheckedAt(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${date.getHours()}:${minutes}`;
}

/**
 * 版と確認時刻を 1 行に集約した文を返す。
 *
 * 設定画面では平常時の高さを最小に保ちたい（お知らせは最上部に出るため、既存の設定項目を
 * 押し下げる）。そのため最新のときは「見出し＋この 1 行」の 2 行で終わらせる。
 *
 * 形は 3 通りある。「断言する／版を落とす」の二者択一にすると、確認から長く経っている
 * ときに置き場所が無くなるため、真ん中の形（版は伝えるが最新かどうかは言わない）を持つ。
 *
 *   1. 確認できた … 「最新です」または「新しい版 X があります」と言い切る
 *   2. 確認から長く経っている（staleCheck）… 版と確認時刻だけを伝え、「最新です」は言わない。
 *      検証できない断言だけを落とし、いちばん有用な事実（版）は残す
 *   3. 一度も／今回まったく確認できなかった（checkFailed）… 版の比較そのものが無い
 *
 * @param {object} input
 * @param {string|null} input.current 使っている版
 * @param {string|null} input.latest 最新版（分からなければ null）
 * @param {boolean} input.updateAvailable 新しい版があるか
 * @param {Date|string|null} [input.lastCheckedAt] 最後に確認できた時刻
 * @param {boolean} [input.checkFailed] 今回の確認に失敗したか
 * @param {boolean} [input.staleCheck] 最後に確認できてから長く経っているか
 * @returns {string}
 */
export function formatVersionLine({
  current = null,
  latest = null,
  updateAvailable = false,
  lastCheckedAt = null,
  checkFailed = false,
  staleCheck = false,
} = {}) {
  const checkedAt = formatCheckedAt(lastCheckedAt);
  const currentLabel = current ?? '不明';

  if (checkFailed) {
    return checkedAt
      ? `最後に確認できたのは ${checkedAt} です。それ以降、新しい版があるかを確認できていません。`
      : '新しい版があるかを、まだ一度も確認できていません。';
  }

  const suffix = checkedAt ? `${checkedAt} に確認しました。` : '';
  if (updateAvailable && latest) {
    // 「新しい版がある」は確認できた事実の記録なので、時間が経っていてもそのまま伝える
    // （古いかもしれないのは「それが最新かどうか」だけ）。
    return `新しい版 ${latest} があります（お使いの版は ${currentLabel}）。${suffix}`;
  }
  if (staleCheck) {
    // 「最新です」は今この瞬間についての主張で、長く確認できていない状態では裏付けが無い。
    // 断言だけを落として、版と確認時刻は残す。
    return `お使いの版は ${currentLabel} です。${suffix}`;
  }
  return `お使いの版は ${currentLabel} で、最新です。${suffix}`;
}

/**
 * 手でアップデートするときのコマンドを返す。
 *
 * 配布 zip の環境には git の話を出さない（手順は「終了して、もう一度起動」で完結するため、
 * コマンド行そのものを出さない）。git 環境にだけ、新しい版があるときに 1 行だけ出す。
 *
 * @param {object} input
 * @param {'git'|'zip'|'off'|'unknown'} input.channel
 * @param {boolean} input.updateAvailable
 * @param {string} [input.noticeCode] 表示中のお知らせ（お知らせ側が固有のコマンドを持つ場合はそれを優先）
 * @returns {string|null}
 */
export function resolveManualCommand({ channel, updateAvailable = false, noticeCode = '' } = {}) {
  if (channel !== 'git') return null;
  if (noticeCode === 'dirty') return 'git status';
  if (!updateAvailable) return null;
  return 'git pull --ff-only && npm install';
}

/**
 * 状況からお知らせを 1 つだけ選ぶ。
 *
 * 複数当てはまる状況（自動更新 OFF かつ未コミット変更あり、など）でも必ず 1 つに絞る。
 * 優先順位は「利用者が次に何をすればよいかを決める情報」から順に置く:
 *   自動更新 OFF > 未コミット変更 > main 以外 > 通信できない > 長く確認できていない > 新しい版あり（zip）
 *
 * @param {object} input
 * @param {'git'|'zip'|'off'|'unknown'} input.channel 入手経路
 * @param {boolean} [input.autoUpdate] 起動時の自動アップデートが ON か
 * @param {string|null} [input.latest] 最新版
 * @param {boolean} [input.updateAvailable] 新しい版があるか
 * @param {string|null} [input.decisionReason] orchestratorUpdateDecision の reason
 * @param {string|null} [input.branch] 現在のブランチ名（git のみ）
 * @param {boolean} [input.offline] ネットワークに出られなかったか
 * @param {boolean} [input.distUnreachable] 配布元に接続できなかったか
 * @param {Date|string|null} [input.lastCheckedAt] 最後に確認できた時刻
 * @param {Date} [input.now] 現在時刻（テスト用）
 * @returns {{ code:string, tone:'info'|'warning', lines:string[] }|null}
 */
export function selectUpdateNotice({
  channel = 'unknown',
  autoUpdate = true,
  latest = null,
  updateAvailable = false,
  decisionReason = null,
  branch = null,
  offline = false,
  distUnreachable = false,
  lastCheckedAt = null,
  now = new Date(),
} = {}) {
  const autoUpdateOff = !autoUpdate || channel === 'off' || decisionReason === 'opt-out';

  // 1. 自動アップデートを OFF にしている（新しい版が出ても切り替わらない理由の説明）。
  //    このお知らせの役目は「新しい版が出ているのに切り替わらない理由」を伝えることなので、
  //    新しい版が無いときは出さない（同じ説明が設定項目の説明文にもあり、常時 3 行居座らせない）。
  if (autoUpdateOff && updateAvailable) {
    return {
      code: 'auto-update-off',
      tone: 'info',
      lines: [
        '自動でのアップデートを OFF にしています。',
        '新しい版が出てもこの画面にお知らせを表示するだけで、切り替えは行いません。',
        '下の「起動時に自動でアップデートする」を ON にすると、次の起動時から自動で切り替わります。',
      ],
    };
  }

  // 2. 未コミット変更あり（git のみ。人が退避しないと直らないので warning）
  if (channel === 'git' && decisionReason === 'dirty') {
    return {
      code: 'dirty',
      tone: 'warning',
      lines: [
        '保存していない変更があるため、アップデートを見送りました。',
        '変更が消えないように、このアプリは今の版のまま動いています。',
        '下のコマンドで変更の一覧を確認し、コミットするか退避してから、もう一度起動してください。',
      ],
    };
  }

  // 3. main 以外のブランチで作業中（git のみ。作業内容を上書きしないための見送り）
  if (channel === 'git' && decisionReason === 'non-main-branch') {
    const branchLabel = branch && branch.trim() !== '' ? branch.trim() : '(detached)';
    return {
      code: 'non-main-branch',
      tone: 'info',
      lines: [
        `main 以外のブランチ（${branchLabel}）で作業中のため、アップデートを見送りました。`,
        '作業中の内容を上書きしないためです。',
        'main に切り替えて起動すると、自動で最新の版に切り替わります。',
      ],
    };
  }

  // 4. 確認できなかった（通信できない／配布元に繋がらない）。
  //
  //    ここで「短期の失敗」と「長く続いている失敗」を 1 つの分岐の中で切り替えるのが要点。
  //    確認に失敗したときは必ず offline / distUnreachable のどちらかが立つため、これを
  //    別の分岐として後ろに置くと「7 日以上確認できていない」は永久に表示されない
  //    （＝8 日通信できていない利用者も穏やかな info を見続けることになる）。
  //    放っておけば直る短期の失敗は info、人がネットワークを直す必要がある長期の失敗は warning。
  if (offline || distUnreachable) {
    if (isStaleCheck({ lastCheckedAt, now })) return staleCheckNotice();
    if (offline) {
      return {
        code: 'offline',
        tone: 'info',
        lines: [
          '新しい版があるかを確認できませんでした。ネットワークにつながっていない可能性があります。',
          '今の版のまま問題なく使えます。次にこのアプリを起動したときに、もう一度確認します。',
        ],
      };
    }
    return {
      code: 'dist-unreachable',
      tone: 'info',
      lines: [
        'アップデートの配布元に接続できませんでした。',
        '今の版のまま問題なく使えます。時間をおいて、もう一度アプリを起動してください。',
      ],
    };
  }

  // 5. 配布 zip の環境で新しい版がある（git の話は出さず、終了→起動で完結すると伝える）
  if (channel === 'zip' && updateAvailable && latest) {
    return {
      code: 'zip-update-available',
      tone: 'info',
      lines: [
        `アプリを終了して、もう一度起動すると、新しい版 ${latest} に切り替わります。`,
        '実行中のタスクがあるときは、終わってから終了してください。',
      ],
    };
  }

  // 6. git 環境で新しい版がある（自動更新 ON・main・変更なし）。
  //    「放っておけば次の起動で自動的に切り替わる」という既定 ON の利点を画面から伝える。
  //    これが無いと、git 環境では新しい版があっても何も出ず、下に置くコマンドだけが浮いてしまう。
  if (channel === 'git' && updateAvailable && latest) {
    return {
      code: 'git-update-available',
      tone: 'info',
      lines: [
        `次にアプリを起動したときに、自動で新しい版 ${latest} に切り替わります。`,
        '今すぐ切り替えたい場合は、実行中のタスクが終わってからアプリを終了して、もう一度起動してください。',
      ],
    };
  }

  // 7. 入手経路が分からない（自動では切り替えられないので、入れ直しを案内する）。
  //    ここに落ちる典型は「配布 zip の目印が失われた」「zip を別のリポジトリ配下へ展開した」で、
  //    相手は zip の利用者。git の用語は出さない。表示は文字がそのまま出る（記号で装飾されない）ため、
  //    バッククォートのような印も書かない。
  if (channel === 'unknown' && updateAvailable && latest) {
    return {
      code: 'channel-unresolved',
      tone: 'warning',
      lines: [
        `新しい版 ${latest} がありますが、このアプリをどうやって入れたのかが分からないため、自動では切り替えません。`,
        '配布された zip をあらためてダウンロードし、新しい場所へ展開し直してください。',
      ],
    };
  }

  return NO_UPDATE_NOTICE;
}

/**
 * 「長く確認できていない」お知らせを組み立てる。
 * 確認できなかった状況の中でも、表示時点での経過時間でも使う（同じ文言を 1 つだけ持つ）。
 * @returns {{ code:'stale-check', tone:'warning', lines:string[] }}
 */
function staleCheckNotice() {
  return {
    code: 'stale-check',
    tone: 'warning',
    lines: [
      `${STALE_CHECK_DAYS} 日以上、新しい版があるかを確認できていません。`,
      'ネットワークの接続をご確認ください。',
    ],
  };
}

/**
 * 表示する直前に、記録しておいたお知らせを見直す。
 *
 * 経過時間は「見た瞬間」の性質なので、確認した瞬間の判定を記録に焼いたままでは足りない。
 * 確認が走らない構成（オーケストレーターを起動しない GUI セッション、確認間隔を長くした場合、
 * スリープ中など）では記録が更新されないため、1 か月前の確認結果を今の状況として出し続けてしまう。
 * そこで設定画面とサイドバーの入口でこの関数を通し、表示時点で評価し直す。
 *
 * お知らせは常に 1 つなので、次の順で選ぶ。
 *
 *   1. 記録された warning（`dirty` / `channel-unresolved`）… 具体的で緊急度が高いので勝たせる
 *   2. 長く確認できていない … 記録された info より強い
 *   3. 記録された info（`offline` / `zip-update-available` / `auto-update-off` など）
 *
 * 2 を「記録にお知らせが無いとき」に限ると穴が残る。確認が失敗すると `offline`（info）が
 * 記録され、そのとき確認時刻は更新されない。その状態で確認が走らないまま日が過ぎると、
 * 記録の info が居座って経過時間の評価に入れなくなる（「3 日前に確認成功 → 起動時の確認が
 * 失敗 → GUI を開いたまま 30 日」で実際に起きる）。
 *
 * info が負けても情報は失われない。新しい版の有無はバージョン行に残り、自動更新 OFF の
 * 説明は設定項目の説明文にある。33 日前の「新しい版があります」を今の情報のように
 * 見せないほうが正直、という判断でこの順にしている。
 *
 * @param {object} input
 * @param {{code:string, tone:string, lines:string[]}|null} input.notice 記録しておいたお知らせ
 * @param {Date|string|null} input.lastCheckedAt 最後に確認できた時刻
 * @param {Date} [input.now] 現在時刻（テスト用）
 * @returns {{code:string, tone:string, lines:string[]}|null}
 */
export function resolveDisplayNotice(input = {}) {
  return resolveDisplayState(input).notice;
}

/**
 * 表示時点の状態を 1 回の呼び出しで返す。
 *
 * 出すお知らせと「確認から長く経っているか」を一緒に返すのが要点。後者はお知らせの勝敗とは
 * 別の事実で、記録された warning が勝った場合にも成り立つ。呼び出し側が
 * `notice.code === 'stale-check'` だけを見ると、warning が勝ったときに
 * バージョン行が裏付けの無い「最新です」を出したままになる。
 *
 * 時刻に依存する判定をここ 1 か所に閉じるため、両方をここで決めて返す
 * （呼び出し側で isStaleCheck を呼び直すと、判定が 2 か所に散る）。
 *
 * @param {object} input resolveDisplayNotice と同じ
 * @returns {{ notice: {code:string, tone:string, lines:string[]}|null, staleCheck: boolean }}
 */
export function resolveDisplayState({ notice = null, lastCheckedAt = null, now = new Date() } = {}) {
  const staleCheck = isStaleCheck({ lastCheckedAt, now });
  if (notice?.tone === 'warning') return { notice, staleCheck };
  if (staleCheck) return { notice: staleCheckNotice(), staleCheck };
  return { notice: notice ?? NO_UPDATE_NOTICE, staleCheck };
}

/**
 * 「最後に確認できてから長く経っている」かを判定する。
 * @param {{ lastCheckedAt?: Date|string|null, now?: Date, days?: number }} input
 * @returns {boolean}
 */
export function isStaleCheck({ lastCheckedAt = null, now = new Date(), days = STALE_CHECK_DAYS } = {}) {
  if (!lastCheckedAt) return false;
  const checked = lastCheckedAt instanceof Date ? lastCheckedAt : new Date(lastCheckedAt);
  if (Number.isNaN(checked.getTime())) return false;
  return now.getTime() - checked.getTime() > days * DAY_MS;
}

/**
 * 設定項目「起動時に自動でアップデートする」の説明文。
 * 設定画面と README で同じ説明になるよう、ここに 1 つだけ持つ。
 */
export const AUTO_UPDATE_FIELD_HELP = [
  'ON のとき、アプリを起動したときに新しい版があれば自動で切り替えます（既定: ON）。',
  '切り替えたあとは自動で起動し直すため、そのときだけ起動に少し時間がかかります。',
  'OFF にすると、新しい版が出てもこの画面にお知らせを表示するだけで、切り替えは行いません。',
].join('\n');

/** 問い合わせ用に版をまとめてコピーできるブロックの説明文（説明文を先、内容を後ろに置く）。 */
export const DIAGNOSTICS_HELP_TEXT = 'お問い合わせのときは、下の内容をコピーして添えてください。';

/** 設定パネルで手動アップデートのコマンドを出すときの前置き。 */
export const MANUAL_COMMAND_PREFACE = '手でアップデートする場合は、アプリを終了してから次のコマンドを実行してください。';

/**
 * 同梱エージェント定義の展開について、起動時に伝える 1 行を返す。
 *
 * 展開を見送ったときも黙って済ませない。とくに「同梱のほうが古い」ケースは、利用者が
 * 自分で vk-agents を新しくしている通常の状態であり、黙っていると
 * 「なぜ展開されないのか」が分からない。どちらが新しいかが分かる文言にする。
 *
 * 伝える必要がない状態（版が同じ・まだ展開していない）は null を返す。
 *
 * @param {{ code:string, vendor:string|null, recorded:string|null }} state
 *   evaluateAgentsVersionState の戻り値
 * @returns {{ level:'log'|'warn', text:string }|null}
 */
export function formatAgentsVersionNotice({ code, vendor = null, recorded = null } = {}) {
  const vendorLabel = vendor ? `v${vendor}` : '版不明';
  const recordedLabel = recorded ? `v${recorded}` : '版不明';

  switch (code) {
    case 'vendor-newer':
      return {
        level: 'log',
        text: `同梱のエージェント定義が新しくなっているため、~/.claude へ展開し直します（${recordedLabel} → ${vendorLabel}）...`,
      };
    case 'vendor-older':
      return {
        level: 'log',
        text:
          `同梱のエージェント定義（${vendorLabel}）は、展開済みの版（${recordedLabel}）より古いため展開しません。` +
          '展開済みのものをそのまま使います。',
      };
    case 'recorded-unknown':
      return {
        level: 'log',
        text:
          '展開済みのエージェント定義の版が分からないため、自動では展開しません。' +
          '同梱のものへそろえる場合は `npm run setup:agents` を実行してください（~/.claude を上書きします）。',
      };
    case 'invalid-version':
      return {
        level: 'warn',
        text:
          `エージェント定義の版を比較できないため展開しません（同梱: ${vendorLabel} / 展開済み: ${recordedLabel}）。`,
      };
    case 'vendor-unknown':
      return {
        level: 'warn',
        text: '同梱のエージェント定義の版が読めないため展開しません。',
      };
    default:
      // up-to-date / not-deployed は伝えることが無い
      // （前者は正常、後者は初回セットアップの案内が別に出る）。
      return null;
  }
}

/**
 * doctor の「展開済みエージェント定義の版」項目に出す状況と次にやることを返す。
 *
 * 判定の結論（evaluateAgentsVersionState）を doctor と起動時ログで共有し、
 * 「ログの文と診断の文が違う」状態を作らないためにここへ置く。
 *
 * ok は「展開済みが同梱より古くないか」で決める。同梱が古い（利用者のほうが新しい）状態は
 * 通常の定常状態なので、警告にはしない。
 *
 * @param {{ code:string, vendor:string|null, recorded:string|null }} state
 * @returns {{ ok:boolean, current:string, hint:string }}
 */
export function formatAgentsVersionRequirement({ code, vendor = null, recorded = null } = {}) {
  const vendorLabel = vendor ? `v${vendor}` : '不明';
  const recordedLabel = recorded ? `v${recorded}` : '不明';
  const both = `同梱: ${vendorLabel} / 展開済み: ${recordedLabel}`;
  const setupHint = '`npm run setup:agents` で同梱のものを展開できます（~/.claude を上書きします）。';

  switch (code) {
    case 'up-to-date':
      return { ok: true, current: `${recordedLabel}（同梱と同じ）`, hint: setupHint };
    case 'vendor-older':
      return {
        ok: true,
        current: `${recordedLabel}（同梱の ${vendorLabel} より新しい）`,
        hint: '展開済みのほうが新しいため、そのまま使えます。同梱のものへ戻す必要はありません。',
      };
    case 'vendor-newer':
      return {
        ok: false,
        current: both,
        hint: '同梱のエージェント定義のほうが新しいため、次回の `up` 起動時に自動で展開し直します。',
      };
    case 'recorded-unknown':
      return {
        ok: false,
        current: both,
        hint: `展開済みの版が分からないため確認できません。必要なら ${setupHint}`,
      };
    case 'not-deployed':
      return {
        ok: false,
        current: '未展開',
        hint: setupHint,
      };
    default:
      // vendor-unknown / invalid-version
      return {
        ok: false,
        current: both,
        hint: `版を比較できないため確認できません。必要なら ${setupHint}`,
      };
  }
}

/**
 * 問い合わせ用の版一覧（コピーしやすい 1 ブロック）を組み立てる。
 * @param {object} input
 * @param {string|null} input.current
 * @param {string|null} [input.latest]
 * @param {'git'|'zip'|'off'|'unknown'} input.channel
 * @param {string|null} [input.vkTerminals]
 * @param {string|null} [input.vkAgents]
 * @param {string|null} [input.node]
 * @param {string|null} [input.platform]
 * @returns {string}
 */
export function formatDiagnostics({
  current = null,
  latest = null,
  channel = 'unknown',
  vkTerminals = null,
  vkAgents = null,
  node = null,
  platform = null,
} = {}) {
  const channelLabel = {
    git: 'git（clone した作業ツリー）',
    zip: 'zip（配布パッケージ）',
    off: 'off（自動更新なし）',
    unknown: '不明',
  }[channel] ?? '不明';
  return [
    `VK Orchestrator: ${current ?? '不明'}`,
    `最新版: ${latest ?? '未確認'}`,
    `入手経路: ${channelLabel}`,
    `VK Terminals: ${vkTerminals ?? '未導入'}`,
    `vk-agents（同梱）: ${vkAgents ?? '不明'}`,
    `Node.js: ${node ?? '不明'}`,
    `プラットフォーム: ${platform ?? '不明'}`,
  ].join('\n');
}

/**
 * サイドバーへ 1 項目だけ出すときの内容（アイコンとラベル）を返す。
 *
 * 平常時（最新・お知らせなし）は null を返し、サイドバーには何も出さない。
 * 押しても何も無い項目が残ると通知全体が信用されなくなるため、
 * 「新しい版がある」「アップデートが止まっている」「新しい版を確認できていない」に限る。
 *
 * アイコンはラベルへ埋め込まず別に返す。VK Terminals は項目ごとにアイコン用の枠を必ず描くため、
 * ラベルに絵文字を入れると組み込みの項目とテキストの左端が揃わない。
 *
 * 設定画面と同じく、表示する直前に「長く確認できていない」かを評価し直す
 * （resolveDisplayNotice を通す）。記録に焼いた判定だけを見ていると、確認が走らない構成では
 * 何日経ってもサイドバーに何も出ない。
 *
 * @param {object} input
 * @param {boolean} input.updateAvailable
 * @param {string|null} [input.latest]
 * @param {{code:string, tone:string}|null} [input.notice]
 * @param {Date|string|null} [input.lastCheckedAt] 最後に確認できた時刻
 * @param {Date} [input.now] 現在時刻（テスト用）
 * @returns {{ icon: string, label: string }|null}
 */
export function formatMenuEntry({
  updateAvailable = false,
  latest = null,
  notice = null,
  lastCheckedAt = null,
  now = new Date(),
} = {}) {
  const displayNotice = resolveDisplayNotice({ notice, lastCheckedAt, now });

  // 確認そのものができていない状態は「アップデートが止まっている」とは別の事実なので分ける
  // （止まっているのは確認で、アップデートの適用は止まっていない）。
  if (displayNotice?.code === 'stale-check') {
    return { icon: '⚠️', label: '新しい版を確認できていません' };
  }
  // 人が何かしないと直らない状態（warning）は「止まっています」として知らせる。
  if (displayNotice && displayNotice.tone === 'warning') {
    return { icon: '⚠️', label: 'アップデートが止まっています' };
  }
  if (updateAvailable && latest) {
    return { icon: '⬆️', label: `新しい版 ${latest} があります` };
  }
  return null;
}

/**
 * `vk-orchestrator update` / `update --check` の人が読む出力を組み立てる。
 * doctor と同じ様式（✅ / ❌ と「次にやること」）に寄せる。
 *
 * @param {object} report runUpdateCheck が返すレポート
 * @returns {string}
 */
export function formatUpdateReport(report = {}) {
  const {
    channel = 'unknown',
    current = null,
    latest = null,
    updateAvailable = false,
    decision = null,
    blockers = [],
    manifest = null,
    lastCheckedAt = null,
    checkFailed = false,
  } = report;

  const lines = ['VK Orchestrator アップデート', ''];
  lines.push(
    `  ${updateAvailable ? '⬆️' : '✅'} ${formatVersionLine({ current, latest, updateAvailable, lastCheckedAt, checkFailed })}`
  );

  const channelLabel = {
    git: 'git（clone した作業ツリー）',
    zip: 'zip（配布パッケージ）',
    off: 'off（自動更新なし）',
    unknown: '不明',
  }[channel] ?? '不明';
  lines.push(`  ・入手経路: ${channelLabel}`);
  if (manifest?.releasedAt) {
    const releasedAt = formatCheckedAt(manifest.releasedAt);
    if (releasedAt) lines.push(`  ・公開日時: ${releasedAt}`);
  }

  const notice = report.notice ?? null;
  if (notice) {
    lines.push('');
    lines.push(`  ${notice.tone === 'warning' ? '⚠️' : 'ℹ️'} ${notice.lines[0]}`);
    for (const line of notice.lines.slice(1)) lines.push(`     ${line}`);
  }

  if (blockers.length) {
    lines.push('');
    lines.push('  ❌ 今はアップデートを実行できません:');
    for (const b of blockers) {
      lines.push(`     - ${b.message}`);
      if (b.hint) lines.push(`       → ${b.hint}`);
    }
  }

  const command = resolveManualCommand({
    channel,
    updateAvailable,
    noticeCode: notice?.code ?? '',
  });
  if (command) {
    lines.push('');
    lines.push('  手でアップデートする場合:');
    lines.push(`     ${command}`);
  }

  if (decision?.action === 'update' && blockers.length === 0) {
    lines.push('');
    lines.push('  `vk-orchestrator update` で今すぐ切り替えられます（アプリを終了してから実行してください）。');
  }

  if (manifest?.changelogUrl) {
    lines.push('');
    lines.push(`  変更履歴: ${manifest.changelogUrl}`);
  }

  return lines.join('\n');
}

/**
 * 起動時ログ 1 行分に整える。設定画面のお知らせと同じ文字列を使う。
 * @param {{code:string, tone:string, lines:string[]}|null} notice
 * @returns {string|null}
 */
export function formatNoticeForLog(notice) {
  if (!notice) return null;
  return notice.lines.join(' ');
}
