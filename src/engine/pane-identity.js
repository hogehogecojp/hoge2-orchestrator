// -------------------------------------------------------
// 「その termId のペインは本当にこのタスクのものか」の照合（共有ヘルパー）
//
// state.json の termId は、ペインが閉じられても消えない経路がある。pane-resume.js の
// 自動再開は termId を null に戻すが、PR が既にあるタスクは `{ action: 'has-pr' }` で
// 早期 return するためリセットまで到達しない（#263）。この状態で VK Terminals / tmux が
// 同じ termId を別タスクの新しいペインへ再採番すると、state の termId が無関係なペインを
// 指したまま次の 3 経路で使われる:
//
//   1. マージ通知メッセージの投稿先（notify-pane-merged.js）
//   2. コンフリクト差し戻しプロンプトの送信先（index.js ensureConflictHandbackPane）
//   3. PR ボタン（バッジ）の書き込み先（index.js recordPRAcrossSurfaces / notifyPaneMerged）
//
// いずれも「ペインが存在するか」しか見ていなかったため、掴み違えたペインへそのまま作用して
// いた。そこで **ペインが自己申告する識別情報**（担当 PR・ヘッダーリンク）と、**こちらが
// 起動時に設定した値**（PR URL・state の paneTitleUrl）を突き合わせて判定する。
//
// 判定の方針（重要）:
//   - 「明確な不一致」が 1 つでもあれば別タスク（other-task）。掴み違いが確定しているため、
//     テキスト投稿・ペイン再利用・バッジ書き込みのいずれも行わない。
//   - 識別情報を一切持たないペイン（tmux 等）や、照合材料をこちらが持たない場合
//     （この変更より前に起動した既存タスクには paneTitleUrl が無い）は **照合不能**とし、
//     state を信頼する。ここを不一致扱いにすると、その実行面・その既存タスクでは通知が
//     一切出なくなる（#258 で解消した回帰そのもの）。
//
// 残存リスク（意図的に塞いでいない）:
//   ユーザーが VK Terminals 上で自分で開いたペイン（apiUrl・apiPrUrl とも空）へ termId が
//   再採番された場合は、照合材料がゼロなので検知できず state を信頼して送ってしまう。
//   「期待側が非 null なのにペイン側が空なら別タスク」と倒せば塞げるが、VK Terminals の
//   再起動で保持値が失われる実績があり、その場合に全タスクの通知が止まるため採らない。
//   照合を入れた＝すべての掴み違いが塞がった、ではない点に注意すること。
//
// 前提（壊すと照合が無言で効かなくなる）:
//   ヘッダー URL による判定は「その URL がタスクごとに一意」であることに依存する。
//   元 issue の URL は複数タスクで重複しうるため、buildPaneTitle() がメタ issue 番号の
//   フラグメント（#vk-task-<番号>）を足して一意性を作っている。あちらを「不要な文字列」として
//   消すと、同じ元 issue を指す 2 タスクのペインが同値になり、掴み違いを一致と誤答する。
//
// 副作用を持たない純粋関数だけを置き、実行面の取得（getStates）とログ出力は呼び出し側に残す。
// 経路ごとに「取得失敗時に見送るか続行するか」の方針が異なる（差し戻しは重複ペインを作らない
// ため見送り、通知・バッジは state を信頼して続行）ため、そこを共通化すると片方が壊れる。
// -------------------------------------------------------

/**
 * 照合結果。呼び出し側がログ文言を経路ごとに書き分けられるよう、真偽値ではなく 3 値で返す。
 *
 * - OWNER        : 識別情報が一致した（このタスクのペインだと確認できた）
 * - OTHER_TASK   : 明確な不一致がある（別タスクのペインを掴んでいる）
 * - UNVERIFIABLE : 照合材料が無く判定できない（state を信頼する）
 */
export const PANE_OWNERSHIP = {
  OWNER: 'owner',
  OTHER_TASK: 'other-task',
  UNVERIFIABLE: 'unverifiable',
};

/**
 * VK Terminals / tmux の states から termId 一致のペインを引く。
 *
 * termId は実行面によって数値・文字列が混在するため String 化して比較する。
 * terminals の形が想定外（欠落・非オブジェクト）でも例外にせず null を返し、
 * 呼び出し側が「照合不能」として扱えるようにする。
 *
 * @param {object|undefined|null} terminals states.terminals
 * @param {string|number|null} termId
 * @returns {object|null} 一致したペイン（無ければ null）
 */
export function findPaneByTermId(terminals, termId) {
  if (termId == null) return null;
  if (!terminals || typeof terminals !== 'object') return null;
  return Object.values(terminals).find(
    (pane) => pane && typeof pane === 'object' && String(pane.termId) === String(termId)
  ) ?? null;
}

/**
 * ペインが本当にこのタスクのものかを判定する。
 *
 * 判定材料は 2 つで、どちらも「両側に値があるのに食い違っている」ときだけ不一致とする。
 *
 *   1. ヘッダー  : pane.apiUrl と、起動時に setTerminalTitle で設定した URL（state.paneTitleUrl）
 *   2. 担当 PR   : pane.apiPrUrl ?? pane.prUrl と、期待する PR URL
 *
 * **ヘッダーを優先し、そこで判断できたら PR は見ない。** ヘッダー URL は起動時に一度設定して
 * 以後変化しない identity だが、apiPrUrl は「こちらが書いたときだけ更新される可変値」で、
 * 同じタスクの PR が張り替わる（PR#1 を閉じて PR#2 を作る）と陳腐化する。両者を対等に扱って
 * 「どちらか一方でも不一致なら別タスク」にすると、陳腐化した apiPrUrl だけを根拠に正しい
 * ペインが別タスクへ倒れ、そのタスクは通知・バッジを恒久的に失い、差し戻しでは生きている
 * 作業ペインを捨てて新規ペインを作ってしまう（重複ペイン＋文脈喪失）。
 *
 * PR を見るのは「ヘッダーで判断できないとき」だけ（tmux 等の実行面、この変更より前に
 * 起動した paneTitleUrl の無い既存タスク）。
 *
 * @param {object} params
 * @param {object|null} params.pane 対象ペイン（findPaneByTermId の結果）
 * @param {string|null} [params.expectedPrUrl] このタスクが担当する PR の HTML URL。
 *   **これから書き込む値を渡してはいけない**（未設定か別値しか返らず、所有権の肯定材料に
 *   ならないうえ、上記の陳腐化と同じ理由で誤って別タスクへ倒れる）
 * @param {string|null} [params.expectedTitleUrl] 起動時にペインへ設定したヘッダーリンク URL
 * @returns {{ownership:string, mismatch:('pr-url'|'title-url'|null), paneValue:string|null, expectedValue:string|null}}
 */
export function resolvePaneOwnership({ pane, expectedPrUrl = null, expectedTitleUrl = null }) {
  const unverifiable = { ownership: PANE_OWNERSHIP.UNVERIFIABLE, mismatch: null, paneValue: null, expectedValue: null };
  if (!pane || typeof pane !== 'object') return unverifiable;

  // 材料は「ヘッダー → 担当 PR」の順に見る。先に判断できたものでそのまま確定させる
  // （後段の材料でひっくり返さない）。
  const checks = [
    { mismatch: 'title-url', paneValue: readPaneUrl(pane, ['apiUrl']),            expectedValue: readUrl(expectedTitleUrl) },
    { mismatch: 'pr-url',    paneValue: readPaneUrl(pane, ['apiPrUrl', 'prUrl']), expectedValue: readUrl(expectedPrUrl) },
  ];

  for (const check of checks) {
    // 片方でも欠けていれば、その材料では何も言えない（「未設定 ≠ 別タスク」）。次の材料へ。
    if (check.paneValue == null || check.expectedValue == null) continue;
    return check.paneValue === check.expectedValue
      ? { ownership: PANE_OWNERSHIP.OWNER, mismatch: null, paneValue: null, expectedValue: null }
      : { ownership: PANE_OWNERSHIP.OTHER_TASK, ...check };
  }

  return unverifiable;
}

/**
 * ペインが保持している URL を取り出す。保持していなければ null。
 *
 * VK Terminals 側の「未設定」の表現は **空文字**（setTerminalPrUrl 自身が `prUrl ?? ''` を
 * 書き込む: src/terminals/backend-vk-terminals.js）。`??` は null / undefined でしか右へ
 * 倒れないため、空文字を素通しすると「別の値を持っている」と誤判定する（#258）。
 * 空文字・空白のみ・非文字列は未設定として扱い、次のフィールドへフォールバックする。
 */
function readPaneUrl(pane, keys) {
  for (const key of keys) {
    const value = readUrl(pane[key]);
    if (value != null) return value;
  }
  return null;
}

/** 文字列として意味のある URL だけを trim して返す（それ以外は未設定＝null）。 */
function readUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
