/**
 * 「タスクに紐づく作業ペインが、いま現に動いているか」を判定する純粋関数（issue #272）。
 *
 * ## 何のためにあるか
 *
 * タスクカードに「入力待ち」バッジが出ているのに、実際には人間の入力を待っておらず、
 * 作業ペインではチームが作業を続けている、という状態が起きていた
 * （実データ: vektor-inc/bill-vektor#326。テスト担当が e2e の FAIL 報告を
 * `Status: waiting-input` で投稿 → 司が `Status: no-action` を 3 件投稿して修正対応を継続 →
 * 実装担当の修正・再テストと作業は動き続けたのに、カードは「入力待ち」のまま張り付いた）。
 *
 * 原因は「未応答の確認が残っているか」を判定する `hasPendingWaitingInput()`
 * （decision-record.js）が `Status: no-action` では pending を解除しないこと。ただしこれは
 * **意図的な安全側の設計**（本物の質問が、無関係な進捗報告の割り込みで消えないようにするため）
 * なので、判定内容そのものは変更しない。
 *
 * 代わりに **判定結果をラベルへ反映するタイミングだけを遅らせる**。
 * 「確認が未応答か」の意味は一切変えず、作業ペインが現に動いているあいだは
 * `status:waiting-input` へ倒すのを保留する。
 *
 * ## この設計の肝（欠落ではなく遅延）
 *
 * **ペインが静止したら、従来どおり `waiting-input` に倒す。**
 * つまり本物の質問が消えることはなく、**ペインが静止するまで表示が遅れるだけ**になる。
 * ここを「pending 自体を解除する」方向に作り変えると、本物の質問が永久に表示されなくなる
 * （＝遅延ではなく欠落になる）ので、その形に変えてはいけない。
 *
 * 逆に言うと、**この修正の安全性は「保留が終わる条件が必ず来ること」だけに依存している**。
 * 「1 巡で終わる」と決まっているわけではないので、保留が終わらなくなる経路（＝判定材料が
 * 際限なく『稼働中』を返し続ける経路）を作らないことがこのモジュールの責務になる。
 * 具体的には次の 2 つを塞いである。
 *
 *   - 実行面とのクロックずれで `lastOutputTime` が未来を指し続ける経路 → 下の `isPaneWorking`
 *   - 掴み違えた別タスクのペインの稼働状況で保留し続ける経路 → 呼び出し側
 *     （scanInProgressIssues が `resolvePaneOwnership` で素性照合し、明確な不一致なら保留しない）
 *
 * ## 材料が取れないときは保留しない（fail-open）
 *
 * VK Terminals が停止中 / ペインの状態が取得失敗 / termId が解決できない / 対象ペインが
 * 一覧に無い / 別タスクのペインを掴んでいる、のいずれも「保留しない＝倒す」に倒す。
 * 安全側は常に「本物の質問を埋もれさせない」方向に置く。この関数は材料が欠けたら false を
 * 返すだけで、取得失敗のハンドリング（warn ログ）と素性照合は呼び出し側
 * （scanInProgressIssues）に残す。
 *
 * ## `pane.waiting` が何を指すかは実行面によって違う
 *
 * VK Terminals の `GET /api/states` は入力待ちに関するフラグを 2 つ、別フィールドで返す。
 *
 * | フィールド | 誰が書くか | 意味 |
 * |---|---|---|
 * | `waiting`         | VK Terminals 自身 | PTY 出力のパターンから判定した内部フラグ |
 * | `externalWaiting` | orchestrator      | `POST /api/set-status` で押し込んだ外部フラグ |
 *
 * orchestrator が `status:waiting-input` ラベルを鏡写ししているのは `externalWaiting` の側
 * （waiting-marker-scanner.js）で、`waiting` には触れない（renderer/app.js の `t.waiting` は
 * 内部判定 `checkWaiting()` とユーザー入力 `markPaneInput()` だけが書き換え、
 * `terminal:set-status` は `t.externalWaiting` にしか書かない）。よって **VK Terminals
 * バックエンドでは** `waiting` を読んでも、自分が押し込んだ値を読み返す循環は起きない。
 *
 * **tmux バックエンドは事情が違う。** tmux 側には PTY 出力からの内部判定が存在せず、
 * `setExternalWaiting()` が `p.waiting` を直接書き、`getStates()` がそれを `waiting` として
 * 返す（src/terminals/backend-tmux.js）。つまり tmux では `pane.waiting` は
 * **orchestrator が押し込んだ値そのもの**で、読み返しの循環が成立する。
 * ただし向きは fail-open 側（`waiting` が真 → 保留しない → 従来どおり倒す）なので、
 * 「入力待ちラベルが付いている間は保留されない」という無害な挙動にしかならない。
 * この非対称は将来の判断材料になるため、実態として記録しておく。
 *
 * `waiting` が真のときに保留しないのは、VK Terminals であれば実測で
 * 「人間の入力を待っている」と判定しているから。しかも VK Terminals 側には
 * vektor-inc/vk-orchestrator#212（第三者待ちのナレーションを入力待ちと誤検知しない対応）で
 * 入った許可リストがあり、「和田の修正を待っています」「CI の完了を待っています」のような
 * サブエージェント・CI 待ちの進捗ナレーションでは `waiting` が立たない
 * （vk-terminals の renderer/waitingState.js の `WAITING_TARGET_NOUNS`）。今回の issue と
 * 同じ問題型に対する先行対応なので、その判定をここでも尊重して二重に判断しない。
 *
 * ## 稼働判定に `lastOutputTime` だけを使い、`lastLines` を併用しない理由（実測にもとづく）
 *
 * src/terminals/index.js の `confirmOutputProgressed()` は、送信の到達確認で
 * 「`lastOutputTime` と `lastLines` の両方が変化したこと」を要求する AND 判定にしている。
 * カーソル blink などで `lastOutputTime` だけが進むケースがあるためで、ここでも同じ罠
 * （静止したペインの `lastOutputTime` が進み続けて永久に保留になる）が成立するかを、
 * 稼働中の VK Terminals へ実際に `GET /api/states` を投げて確かめた。
 *
 * 実測（500ms 間隔で 300 秒、7 ペイン同時観測。150 秒 × 6 ペインでも同傾向を確認）:
 *
 *   - 作業中のペイン: 300 秒で 171 回の出力更新。間隔はほぼ一定の約 2 秒で、最大でも 4.1 秒。
 *     Claude Code の TUI がスピナーを描き直し続けるため、作業中は必ず出力が流れる。
 *   - 停止しているペイン（放置されている 4 ペイン）: 300 秒で 0〜2 回だけ。
 *   - `lastOutputTime` だけが進んで `lastLines` が変わらなかった観測は **270 件中 0 件**。
 *     停止ペインで観測された数少ない更新も、`lastLines` の末尾にカーソル移動由来の
 *     1 文字が足されるだけの中身の無い変化で、`lastLines` の差分でも「変化あり」になった。
 *
 * したがって `lastLines` の併用は、ここで防ぎたい「静止しているのに進み続ける」ケースを
 * 実際には弾けない（`lastLines` も一緒に変わってしまう）。前回値をループ間で保持する
 * 仕組み（state.json）を足す割に効かないため採らず、**`lastOutputTime` 単独**とする。
 *
 * 代わりに、永久保留を防ぐ役目は下の `PANE_ACTIVE_WINDOW_MS`（判定窓を短く取ること）に
 * 持たせている。
 */

/**
 * 「直近に出力があった」とみなす時間窓（ms）。
 *
 * 20 秒とした根拠:
 *   - 作業中のペインは実測で約 2 秒ごと、最も間が空いたときでも 4.1 秒で出力が更新される。
 *     20 秒はその約 5 倍あるので、重いツール出力や GC で一時的に間隔が伸びても
 *     作業中を見失わない。
 *   - 一方、オーケストレーターのメインループ間隔は 60 秒（src/engine/index.js の
 *     `POLL_INTERVAL`、既定 60000ms）。判定窓をループ間隔より十分短く取っておくと、
 *     ペインが静止しさえすれば次の走査時点で必ず窓から外れる（＝静止してから 1 巡で倒れる）。
 *     ここで保証されるのは「静止後の追随の速さ」だけで、保留全体の長さではない点に注意。
 *     窓をループ間隔以上にすると、停止ペインの散発的な出力（実測 300 秒に 0〜2 回）が
 *     毎巡ヒットして保留が続きうるので、窓は必ずループ間隔より短く保つこと。
 *
 * ⚠ この「窓 < ループ間隔」は不変条件で、`POLL_INTERVAL_MS`（環境変数で下げられる。
 *   src/engine/index.js）を 20 秒以下にすると崩れる。片方だけを変えないこと。崩れても
 *   本物の質問が消えるわけではない（ペインが本当に静止すれば倒れる）が、停止ペインの
 *   散発出力を毎巡拾って遅延が伸びうる、という劣化になる。
 */
export const PANE_ACTIVE_WINDOW_MS = 20_000;

/**
 * 作業ペインが稼働中か（＝ waiting-input への遷移を保留してよいか）を判定する。
 *
 * @param {object} [input]
 * @param {object|null} [input.pane] VK Terminals states のペイン 1 件（pane-identity.js の
 *   `findPaneByTermId()` の戻り値）。null（未解決・一覧に無い）は false
 * @param {number} [input.now=Date.now()] 判定時刻（テストから固定するために注入可能）
 * @param {number} [input.activeWindowMs=PANE_ACTIVE_WINDOW_MS] 直近とみなす時間窓（ms）
 * @returns {boolean} 稼働中なら true。材料が取れないときは false（＝保留しない / fail-open）
 */
export function isPaneWorking({
  pane = null,
  now = Date.now(),
  activeWindowMs = PANE_ACTIVE_WINDOW_MS,
} = {}) {
  // ペインが引けない（VK Terminals 停止中・termId 未解決・一覧に無い）→ 保留しない。
  if (!pane || typeof pane !== 'object') return false;

  // 実行面が「人間の入力を待っている」と言っているなら、それを尊重して保留しない。
  // 真偽値以外（tmux 以外の実行面が将来 1 などを返す場合）も truthy なら待ち扱いにする。
  // どちらに倒しても fail-open 側（＝倒す）なので、厳密一致より緩い判定を採る。
  if (pane.waiting) return false;

  // 直近に画面出力が更新されているか。未報告・不正値は材料無しとみなして保留しない。
  const lastOutputTime = Number(pane.lastOutputTime);
  if (!Number.isFinite(lastOutputTime) || lastOutputTime <= 0) return false;

  // 窓が不正（NaN・0 以下）なら常時保留になりかねないので、保留しない側へ倒す。
  const windowMs = Number(activeWindowMs);
  if (!Number.isFinite(windowMs) || windowMs <= 0) return false;

  // `lastOutputTime` は **VK Terminals が動いているマシンの時計** で打たれる
  // （vk-terminals の renderer/app.js が `Date.now()` で打刻し、main.js も
  // src/terminals/backend-vk-terminals.js も再スタンプせずそのまま返す）。接続先は
  // `VK_TERMINALS_HOST` で別マシンにできる（src/engine/local-machine-host.js）ため、
  // ここでは **接続先マシンの時刻を orchestrator マシンの `now` から引く** ことになり、
  // 2 台のクロック差がそのまま差分に乗る。
  //
  // 単純に `now - lastOutputTime < windowMs` とすると、接続先の時計が進んでいる場合に
  // 差が負になって**ずれの大きさに関係なく常に true（＝保留）**になる。しかも停止ペインでも
  // 散発的な出力（実測 300 秒に 0〜2 回）で `lastOutputTime` が「未来」に更新され直すため、
  // ずれがその間隔を超えると窓を抜ける前に必ず次の更新が来て、保留が解けなくなる
  // （サスペンド明けや NTP の効いていない VM で数分ずれるのは珍しくない）。
  // それでは「材料が怪しいときは保留しない」という本修正の唯一の安全弁と逆向きなので、
  // 窓 1 つ分を超える未来は「材料が信用できない」として保留しない側へ倒す。
  // 数秒程度のずれは実害が無いので、従来どおり「たった今出力があった」とみなす。
  const age = now - lastOutputTime;
  if (age <= -windowMs) return false;
  return age < windowMs;
}
