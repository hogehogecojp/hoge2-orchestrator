// -------------------------------------------------------
// GitHub 連携 capability（#138 方針5 / #157）
// -------------------------------------------------------
// キュークライアント自身に「この実行で GitHub API アクセス（＝トークンを解決できたか）
// があるか」を capability として宣言させ、エンジンは GitHub 依存処理の冒頭でこのフラグを
// 見て早期 return する。queue.backend とは独立の軸で、ローカルモードでもトークンがあれば
// GitHub 連携系はフル稼働する。トークン無し × ローカルモードのときだけ無効になる。
//
// - GitHubClient        : 常に true（トークンが無いとそもそも構築段階で exit する）
// - LocalQueueClient    : 内部 GitHubClient を生成できたか（＝トークン有り or 注入あり）
//
// capabilities を宣言しないクライアント（将来の実装・簡易モック等）は後方互換のため
// 「有効」とみなす（明示的に false を宣言したときだけ無効化する fail-open）。

/**
 * クライアントが GitHub 連携を有効と宣言しているか判定する。
 * @param {{ capabilities?: { githubIntegration?: boolean } }} client
 * @returns {boolean} 明示的に false を宣言しているときだけ false。未宣言は true。
 */
export function hasGitHubIntegration(client) {
  return client?.capabilities?.githubIntegration !== false;
}

/**
 * GitHub 連携が無効なときにスキップされる機能の一覧（ログ・README 文言の単一の出所）。
 * @returns {string[]}
 */
export function disabledGitHubFeatures() {
  return [
    'source import（作業対象リポジトリからの取り込み）',
    'PR 監視（PR 検索・CI 判定）',
    'automerge（マージ検知・自動マージ）',
    '対象 issue 操作（close・コメント投稿）',
  ];
}
