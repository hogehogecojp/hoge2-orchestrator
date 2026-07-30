// -------------------------------------------------------
// レビュー完了マーカー未付与による自動マージ保留の可視化（#251）
//
// automerge の最終判定は、PR にレビュー完了マーカー
// （`agent-review-passed` ラベル＋現 head SHA と一致する `agent-review-passed-sha:` コメント）が
// 無いと保留する。保留自体は安全側で正しいが、従来はオーケストレーターのログに出るだけで、
// メタ issue にも VK Terminals のタスクカードにも何も出なかった。運用者から見ると
// 「マージ待ち」のまま無言で止まり続けるため、放置に気づけない。
//
// そこで停止理由ラベル（`blocked:review-incomplete`）＝要対応バッジを付け、
// 付けた瞬間に 1 度だけメタ issue へ復帰手順を通知する。ラベルの有無を冪等性の
// 唯一の真実にするので、ポーリングが何周しても通知は増えない（blocked-reason.js の設計思想）。
//
// GitHub API 呼び出しは呼び出し側から注入し、ユニットテストで実 API を叩かずに
// 分岐（付与・据え置き・除去・判定不能）を検証できるようにしている。
// -------------------------------------------------------

import {
  BLOCKED_REASON_REVIEW_INCOMPLETE,
  decideBlockedLabelForReviewIncomplete,
  issueHasLabel,
} from './blocked-reason.js';
import { REVIEW_PASSED_LABEL, REVIEW_PASSED_SHA_PREFIX } from '../github/index.js';

// コミット ID（head SHA）として通知本文に載せてよい形式。GitHub が返す短縮 SHA も許容する。
// これに通らない値でコマンド例を組み立てると、コピペしても絶対に一致しないマーカーが
// PR へ投稿され、付けた本人が「付けたのに動かない」と詰まるため、形式で門番する。
const HEAD_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * 自動マージ保留をメタ issue へ知らせる通知本文を組み立てる。
 *
 * コンフリクト差し戻し打ち切り通知（notifyConflictHandbackExhausted）と同じトーンで、
 * 「何が起きているか → PR → 人がやること → いつ再開するか」の順に書く。
 * gh コマンド例は PR URL をそのまま貼らず、URL から解決済みの owner / repo / number で
 * 組み立てる（本文由来の文字列をコマンド行に流し込まないため）。
 *
 * コミット ID か PR の owner / repo / 番号のどちらかが確定できないときはコマンド例を
 * 一切出さず、PR 画面での手順に切り替える。どちらの分岐でも、読んだ人がそのまま実行できる
 * 手順で終わるようにする。
 *
 * @param {object} params
 * @param {string} params.prUrl 対象 PR の URL
 * @param {{owner?:string, repo?:string, number?:number|string}} [params.prRef] PR URL のパース結果
 * @param {string} [params.headSha] 検証時点の head SHA（PR ブランチの最新コミット ID）
 * @param {string} params.blockedLabel 付与した停止理由ラベル名（設定で改名可能）
 * @returns {string}
 */
export function buildReviewIncompleteComment({
  prUrl,
  prRef = null,
  headSha = null,
  blockedLabel,
}) {
  const sha = typeof headSha === 'string' && HEAD_SHA_PATTERN.test(headSha.trim())
    ? headSha.trim()
    : null;
  const hasPrRef = Boolean(prRef?.owner && prRef?.repo && prRef?.number != null);
  const repoOption = hasPrRef ? `--repo ${prRef.owner}/${prRef.repo}` : '';
  // コミット ID と PR の指定先が両方そろったときだけ、コピペで完結するコマンド例を出す。
  const commandGuide = sha !== null && hasPrRef
    ? [
        `現在の head SHA（PR ブランチの最新コミット ID）は \`${sha}\` です。gh CLI なら次の 2 コマンドで付けられます。`,
        '',
        '```sh',
        `gh pr edit ${prRef.number} ${repoOption} --add-label ${REVIEW_PASSED_LABEL}`,
        `gh pr comment ${prRef.number} ${repoOption} --body "${REVIEW_PASSED_SHA_PREFIX} ${sha}"`,
        '```',
        '',
        `対象リポジトリに \`${REVIEW_PASSED_LABEL}\` ラベルがまだ無い場合は、\`gh label create ${REVIEW_PASSED_LABEL} ${repoOption}\` で先に作成してください（未作成だと 1 つ目のコマンドが失敗します）。`,
      ]
    : [
        // コマンド例を出せない＝コピペで事故る余地があるので、PR 画面での手順に寄せる。
        // Conversation タブの最下部は「最新コミット」とは限らない（後からコメントが付くと下へ流れる）ため、
        // コミットだけが時系列で並ぶ Commits タブを案内する。
        `コミット ID は PR の Commits タブの最下段のコミット、または \`gh pr view ${hasPrRef ? `${prRef.number} ${repoOption} ` : '<PR 番号> '}--json headRefOid\` で確認したものを使ってください。`,
        '',
        `上の 2・3 は PR 画面だけでも行えます。右サイドバーの Labels から \`${REVIEW_PASSED_LABEL}\` を付け、コメント欄に \`${REVIEW_PASSED_SHA_PREFIX} <コミットID>\` を投稿してください。`,
      ];
  return [
    '⚠️ この PR は CI などマージ前の確認をすべて満たしていますが、レビューが終わったことを示す目印（レビュー完了マーカー）が現在のコミットに対して付いていないため、自動マージを保留しています。',
    '',
    `PR: ${prUrl}`,
    '',
    `メタ issue は \`status:waiting-merge\`（マージ待ち）のままですが、\`${blockedLabel}\`（要対応: レビュー未完了）を付けました。オーケストレーターの不具合ではなく、人がレビューして目印を付けるまで進まない「対応待ち」の状態です。次の手順で対応してください。`,
    '',
    '1. PR の変更内容をレビューする',
    `2. PR に \`${REVIEW_PASSED_LABEL}\` ラベル（レビュー完了マーカーのラベル）を付ける`,
    `3. 現在の head SHA（PR ブランチの最新コミット ID）で \`${REVIEW_PASSED_SHA_PREFIX} <コミットID>\` コメント（どのコミットをレビューしたかを示すマーカー）を PR に付ける`,
    '',
    ...commandGuide,
    '',
    'マーカーが揃うと、次の巡回でオーケストレーターが自動マージを再開します（このコメントへの返信は不要です）。レビュー後に新しいコミットを push した場合は、その最新コミット ID で `' + REVIEW_PASSED_SHA_PREFIX + '` コメントを付け直してください（古いコミットのマーカーのままでは再開しません）。',
    '',
    '- タスクカードの「要対応: レビュー未完了」バッジも次の巡回で消えます。バッジが出ていなければ、このコメントへの対応は完了しています。',
    '- このタスクの自動マージをやめて手動でマージする場合は、この issue の `automerge` ラベルを外してください。',
  ].join('\n');
}

/**
 * blocked:review-incomplete の付け外しと保留通知を行う関数を作る。
 *
 * @param {object} deps
 * @param {(issueNumber:number|string, reason:string)=>Promise<any>} deps.addBlockedReasonLabel
 * @param {(issueNumber:number|string, reason:string)=>Promise<any>} deps.removeBlockedReasonLabel
 * @param {(issueNumber:number|string, body:string)=>Promise<any>} deps.addComment
 * @param {()=>string} deps.getBlockedLabel 設定から解決した停止理由ラベル名を返す
 * @param {object} [deps.logger=console]
 * @returns {(params:{issue:object, prState?:object|null, reviewPassed?:boolean|null, statusAllowsBlockedLabel?:boolean, prUrl?:string, prRef?:object|null, headSha?:string|null, tag:string})=>Promise<{action:string, notify:boolean}>}
 */
export function createReviewIncompleteBlockedSync({
  addBlockedReasonLabel,
  removeBlockedReasonLabel,
  addComment,
  getBlockedLabel,
  logger = console,
}) {
  return async function syncReviewIncompleteBlockedLabel({
    issue,
    prState = null,
    reviewPassed = null,
    statusAllowsBlockedLabel = true,
    prUrl = null,
    prRef = null,
    headSha = null,
    tag = '[automerge]',
  }) {
    const blockedLabel = getBlockedLabel();
    const decision = decideBlockedLabelForReviewIncomplete({
      prState,
      reviewPassed,
      statusAllowsBlockedLabel,
      hasBlockedLabel: issueHasLabel(issue, blockedLabel),
    });
    if (decision.action === 'none' && !decision.notify) return decision;
    try {
      if (decision.action === 'add') {
        // ラベルを先に付けてからコメントする。ラベルが冪等性の唯一の真実なので、
        // コメント投稿に失敗しても次ループで再通知しない（毎ループの通知連投を防ぐ）。
        // その場合もタスクカードのバッジは出ているため、止まっていること自体は伝わる。
        await addBlockedReasonLabel(issue.number, BLOCKED_REASON_REVIEW_INCOMPLETE);
      } else if (decision.action === 'remove') {
        await removeBlockedReasonLabel(issue.number, BLOCKED_REASON_REVIEW_INCOMPLETE);
      }
      if (decision.notify) {
        await addComment(
          issue.number,
          buildReviewIncompleteComment({ prUrl, prRef, headSha, blockedLabel })
        );
      }
    } catch (err) {
      logger.warn?.(
        `  ${tag}: ${blockedLabel} の${decision.action === 'remove' ? '除去' : '付与・通知'}に失敗（次ループで再試行）: ${err.message}`
      );
    }
    return decision;
  };
}
