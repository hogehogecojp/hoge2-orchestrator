// CodeRabbit 待機ゲートの判定（automerge / waiting-merge 共通）。
//
// 兄弟の判定モジュール（waiting-merge-action.js / in-progress-decision.js /
// automerge-candidates.js）と同じく I/O を持たない純関数で統一する。設定の解決
// （loadCoderabbitFeatureConfig）は呼び出し側が反復ごとに 1 回だけ行い、その 1 つの
// スナップショットをゲート判定と説明文言の両方へ渡す。こうすると「マージを許した判定」と
// 「issue コメントに書く理由」が別時点の設定に基づいてズレることがない。
// キャッシュは持たない（プロセス生存中キャッシュにすると、設定パネルで切り替えても再起動まで
// 反映されないという #215 と同型の症状を作ってしまう）。
import { isCoderabbitEnabled, isCoderabbitIgnored, isCoderabbitReviewExpected } from '../config.js';

/**
 * checkPRCompletion に渡すオプションを解決する。
 *
 * CodeRabbit のコメントが来ないことが設定上確定しているとき（監視が無効 features.coderabbit=false、
 * またはレビュー抑止 features.coderabbit_ignore=true）は、待っても新しいコメントは増えないため
 * 待機時間を 0 にし、CI・mergeable・レビュー完了マーカーが揃った時点で即マージできるようにする。
 * コメントが来る見込みがあるときは checkPRCompletion 既定の 30 分をそのまま使う。
 * @param {object} [cfg] loadCoderabbitFeatureConfig() で解決した CodeRabbit 設定。
 *   省略時は既定（監視 ON・抑止 OFF）＝安全側の「30 分待つ」として扱う。
 * @returns {{ coderabbitIdleMs?: number }}
 */
export function prCompletionOptions(cfg = {}) {
  return isCoderabbitReviewExpected(cfg) ? {} : { coderabbitIdleMs: 0 };
}

/**
 * issue コメントに書く「CodeRabbit のコメント待ち」1 行を組み立てる。
 *
 * マージ待ち遷移コメントと automerge 完了コメントで同じ文言ソースを使い、待機 0 分になる条件
 * （prCompletionOptions）と説明文が食い違わないようにする。周囲の箇条書きと同じ「条件: 状態」型に
 * 揃え、待機なしのケースはその理由（監視無効か、レビュー抑止か）と、どちらも該当する設定キーを
 * 添える（運用者が「この即マージ挙動を止めたい」と思ったときに触る対象を示すため）。
 * 「指摘」ではなく「コメント」と書くのは、待機時間の起点が CodeRabbit の最終コメント
 * （レビュー・インラインコメント・PR コメントのいずれか。1 件も無ければ PR 作成時刻）であり、
 * 指摘に限らないため（src/github/index.js の checkPRCompletion / getLastCodeRabbitCommentTime）。
 * @param {object} [cfg] loadCoderabbitFeatureConfig() で解決した CodeRabbit 設定
 * @returns {string}
 */
export function coderabbitGateLine(cfg = {}) {
  if (!isCoderabbitEnabled(cfg)) return '- CodeRabbit のコメント待ち: 監視を無効にする設定（features.coderabbit = false）のため待機なし';
  if (isCoderabbitIgnored(cfg)) return '- CodeRabbit のコメント待ち: PR 本文の @coderabbitai ignore でレビュー抑止（features.coderabbit_ignore = true）のため待機なし';
  return '- CodeRabbit のコメント待ち: 30 分間 新規コメントなし';
}
