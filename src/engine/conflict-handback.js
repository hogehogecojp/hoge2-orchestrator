/**
 * automerge 対象 PR のコンフリクトを担当エージェントへ差し戻すための純関数群。
 *
 * GitHub API・state・VK Terminals への副作用は呼び出し側に残し、このモジュールでは
 * コンフリクト判定、設定値の健全化、同じ head SHA への重複差し戻しと試行上限の判定だけを
 * 扱う。コンフリクトの定義を 1 箇所に集約することで、マージ監視と in-progress 遷移が
 * 将来別々の条件にずれて、差し戻した直後にマージ待ちへ戻る事態を防ぐ。
 */

// コンフリクト差し戻し試行回数の既定上限。
export const DEFAULT_CONFLICT_HANDBACK_MAX = 2;
export const DEFAULT_CONFLICT_HANDBACK_SEND_FAILURE_MAX = 3;

/**
 * GitHub が返した PR 状態を、コンフリクトとして扱うべきか判定する。
 *
 * `mergeable === null` は GitHub 側での非同期計算中なのでコンフリクトには含めず、
 * 呼び出し側が次ループで再判定する。null / undefined も状態不明として false に倒す。
 *
 * @param {null|undefined|{mergeable?: boolean|null, mergeableState?: string}} prState PR 状態
 * @returns {boolean}
 */
export function isPRConflicted(prState) {
  return prState != null &&
    (prState.mergeable === false || prState.mergeableState === 'dirty');
}

/**
 * コンフリクト差し戻しの上限回数を健全化する。
 *
 * 上限判定は maxAttempts が NaN だと常に false になり、automerge PR 同士の競合で
 * 差し戻しが行き来し続けるのを止める安全装置が沈黙のうちに外れる。そのため有限数かつ
 * 0 以上だけを採用し、小数は切り捨て、それ以外は既定値へフォールバックする。
 * 0 は「差し戻し機能を無効化する」という有効な指定として許容する。
 *
 * null / undefined / 空白のみの文字列は未設定として扱う。`Number('') === 0` のため、
 * 先に除外しないと空の環境変数が意図せず機能無効化として解釈される。
 *
 * @param {*} value 環境変数・設定経由の生値
 * @param {number} [fallback=DEFAULT_CONFLICT_HANDBACK_MAX] 不正値時のフォールバック
 * @returns {number} 0 以上の整数
 */
export function normalizeConflictHandbackMax(
  value,
  fallback = DEFAULT_CONFLICT_HANDBACK_MAX
) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * コンフリクト解消時に保存する、配達状態だけをリセットしたレコードを作る。
 *
 * headSha=null は次の非空 head SHA と必ず不一致になるため、次回のコンフリクトは
 * head 変化経路で attempts + 1 になる。通算回数は保持し、打ち切り通知済み状態は
 * 次の上限到達を改めて通知できるよう解除する。
 *
 * @param {object|null} saved state.json のタスクレコード
 * @returns {{
 *   headSha: null,
 *   attempts: number,
 *   sendFailures: 0,
 *   delivered: false,
 *   exhaustedNotified: false
 * }}
 */
export function buildResolvedConflictHandbackState(saved) {
  return {
    headSha: null,
    attempts: saved?.conflictHandback?.attempts ?? 0,
    sendFailures: 0,
    delivered: false,
    exhaustedNotified: false,
  };
}

/**
 * 現在の PR head に対してコンフリクト差し戻しを行うべきか決める。
 *
 * head SHA が不明なら、同じ内容への冪等性を保証できず毎ループ送信しうるため fail-closed
 * で見送る。maxAttempts=0 は明示的な機能無効化として、上限到達通知も出さない。
 *
 * 同じ head SHA でも、重複扱いにするのは本文の配達を確認済み（delivered=true）の場合だけ。
 * 送信前の state 記録後にペイン確保や送信が失敗しても、未達の依頼を永久に解消 push 待ちへ
 * してしまわないためである。未達の再送では通算 attempts を増やさない。依頼が担当者へ届く
 * 前の通信障害を、コンフリクト解消そのものの試行として数えると、本来の差し戻し上限を
 * 消費してしまうためである。ただし障害中の無限リトライを防ぐため sendFailures は増やし、
 * 別上限に達したら通知付きで打ち切る。
 *
 * head が変わったときだけ通算試行回数を増やし、上限超過後の打ち切り通知は state 上で
 * 1 回に制限する。
 *
 * @param {object} input
 * @param {string} input.headSha 現在の PR head SHA
 * @param {object|null} input.saved state.json のタスクレコード
 * @param {number} input.maxAttempts 健全化済みの試行上限
 * @param {number} [input.maxSendFailures=DEFAULT_CONFLICT_HANDBACK_SEND_FAILURE_MAX] 同一 head の送信失敗上限
 * @returns {{
 *   type: 'skip-unknown-head'|'disabled'|'skip-duplicate'|'skip-send-failed'|'skip-exhausted'|'handback',
 *   attempt: number,
 *   sendFailures: number,
 *   notifyExhausted: boolean
 * }}
 */
export function decideConflictHandback({
  headSha,
  saved,
  maxAttempts,
  maxSendFailures = DEFAULT_CONFLICT_HANDBACK_SEND_FAILURE_MAX,
} = {}) {
  if (typeof headSha !== 'string' || !headSha) {
    return {
      type: 'skip-unknown-head',
      attempt: 0,
      sendFailures: 0,
      notifyExhausted: false,
    };
  }

  if (!(maxAttempts > 0)) {
    return {
      type: 'disabled',
      attempt: 0,
      sendFailures: 0,
      notifyExhausted: false,
    };
  }

  const previous = saved?.conflictHandback;
  const sameHead = previous?.headSha === headSha;
  if (sameHead && previous.delivered === true) {
    return {
      type: 'skip-duplicate',
      attempt: previous?.attempts ?? 0,
      sendFailures: previous?.sendFailures ?? 0,
      notifyExhausted: false,
    };
  }

  const attempt = sameHead
    ? Math.max(previous?.attempts ?? 0, 1)
    : (previous?.attempts ?? 0) + 1;
  if (attempt > maxAttempts) {
    return {
      type: 'skip-exhausted',
      attempt,
      sendFailures: sameHead ? (previous?.sendFailures ?? 0) : 0,
      notifyExhausted: previous?.exhaustedNotified !== true,
    };
  }

  if (sameHead) {
    const sendFailures = previous?.sendFailures ?? 0;
    if (sendFailures >= maxSendFailures) {
      return {
        type: 'skip-send-failed',
        attempt,
        sendFailures,
        notifyExhausted: previous?.exhaustedNotified !== true,
      };
    }
    return {
      type: 'handback',
      attempt: Math.max(attempt, 1),
      sendFailures: sendFailures + 1,
      notifyExhausted: false,
    };
  }

  return {
    type: 'handback',
    attempt,
    sendFailures: 1,
    notifyExhausted: false,
  };
}

/**
 * 差し戻しを打ち切った判断が、人手対応を示す blocked ラベルを必要とするか判定する。
 * 通知済みかどうかはコメントの重複防止だけに使い、ラベルの自己修復には影響させない。
 */
export function requiresBlockedLabelForHandbackDecision(decision) {
  return decision?.type === 'skip-exhausted' ||
    decision?.type === 'skip-send-failed';
}

/**
 * コンフリクト解消を担当エージェントへ依頼する本文を組み立てる。
 *
 * @param {object} input
 * @param {{owner: string, repo: string, number: number}} input.prRef 対象 PR
 * @param {string} input.prUrl 対象 PR URL
 * @param {string|null} input.headRefName PR の head ブランチ名
 * @param {number} input.attempt 通算差し戻し回数
 * @param {number} input.maxAttempts 通算差し戻し上限
 * @returns {string}
 */
export function buildConflictHandbackPrompt({
  prRef,
  prUrl,
  headRefName,
  attempt,
  maxAttempts,
}) {
  const lines = [
    `既存タスクの続きです。${prRef.owner}/${prRef.repo} の PR #${prRef.number}（${prUrl}）がコンフリクトし、自動マージが停止しています。`,
  ];
  if (typeof headRefName === 'string' && headRefName.trim()) {
    lines.push(
      `対象ブランチ: \`${headRefName.trim()}\``,
      'このペインが別のディレクトリまたは別のブランチで開かれている場合は、対象リポジトリの作業ディレクトリへ移動し、対象ブランチをチェックアウトしてから作業してください。',
    );
  } else {
    lines.push(
      `対象ブランチ名を取得できませんでした。まず \`gh pr view ${prRef.number} -R ${prRef.owner}/${prRef.repo} --json headRefName\` で確認し、表示されたブランチをチェックアウトしてから作業してください。`,
    );
  }
  lines.push(
    '',
    '次の対応を行ってください。',
    '1. 対象リポジトリのデフォルトブランチを対象ブランチへ取り込み、コンフリクトを解消する。`readme.txt` と `CHANGELOG.md` のバージョン行・エントリは片方を落としやすいため、双方の変更が残っていることを確認する',
    '2. 解消内容を確認して push し、push 後に CI が通過することを確認する。CI が落ちた場合は修正して再 push する',
    '3. 新しい head SHA（PR ブランチの最新コミット ID）の内容を再レビューする',
    '4. 現 head SHA で `agent-review-passed-sha: <SHA>` コメントを PR に投稿し、レビュー完了マーカーを付け直す',
    '',
    'レビュー完了マーカーを現 head SHA で付け直すまで、自動マージは再開しません。',
    '',
    `コンフリクト差し戻し: ${attempt}/${maxAttempts} 回目。上限に達すると自動依頼は打ち切られ、人手での対応に切り替わります。`,
  );
  return lines.join('\n');
}
