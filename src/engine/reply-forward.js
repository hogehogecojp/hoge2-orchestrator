/**
 * @fileoverview
 * 指示待ちスキャン:
 * 対象 issue/PR に付いたユーザー返信（単独 Status: 行を持たない、直近 waiting-input
 * より後のコメント）を pane に転送して in-progress に戻す。bot 投稿（CodeRabbit 等）は
 * 返信扱いせず転送しない（#141）。返信内容の意味解釈はせず、Status: 行の有無と
 * 投稿者種別だけで機械的に判定する（中身は vk-kore が判断し、必要なら再度
 * waiting-input を出す）。`Status: answered` による転送不要の復帰は、別スキャナの
 * scanAnsweredRecovery が扱う。
 */

/** 同じ返信を作業ペインへ転送する最大試行回数の既定値。 */
export const DEFAULT_REPLY_FORWARD_RETRY_MAX = 2;

export function normalizeReplyForwardRetryMax(
  value,
  fallback = DEFAULT_REPLY_FORWARD_RETRY_MAX
) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function decideReplyForward({ replyId, saved, maxAttempts }) {
  if (saved?.lastForwardedCommentId === replyId) {
    return { type: 'already-forwarded', attempt: 0, notifyExhausted: false };
  }
  const prev = saved?.replyForward;
  const same = prev?.commentId === replyId;
  const attempt = same ? (prev.attempts ?? 0) + 1 : 1;
  if (attempt > maxAttempts) {
    return {
      type: 'exhausted',
      attempt,
      notifyExhausted: prev?.exhaustedNotified !== true,
    };
  }
  return { type: 'forward', attempt, notifyExhausted: false };
}

const REPLY_FORWARD_EXHAUSTED_COMMENT = [
  'Comment by vk-agents',
  'Status: waiting-input',
  '',
  '**⚠️ VK Orchestrator からのお知らせ**',
  '',
  '返信を作業ペインへ届けられませんでした。次のいずれかを行ってください。この issue へ投稿した返信を作業ペインの入力欄に手動で貼り付けるか、同じ内容をこの issue に新しいコメントとして投稿してください。',
].join('\n');

export function createReplyForwardScanner({
  githubIntegration,
  fetchWaitingInputIssues,
  getTask,
  gatherTargetState,
  ensurePRRecorded,
  findReplyAfterWaitingInput,
  submitToClaude,
  reconfirmBodyEcho,
  updateTask,
  setStatus,
  addTargetComment,
  port,
  maxAttempts,
  logger = console,
}) {
  // watch モードの setInterval は前回の loop 完了を待たないため、スキャナ単位で
  // 同一プロセス内の read-decide-write が重なるのを防ぐ。
  let isScanning = false;

  const scan = async () => {
    let issues;
    try {
      issues = await fetchWaitingInputIssues();
    } catch (err) {
      logger.warn?.(`[scan-waiting-input] waiting-input issue 取得失敗: ${err.message}`);
      return;
    }
    if (issues.length === 0) return;

    for (const issue of issues) {
      let saved = null;
      try {
        saved = await getTask(issue.number);
      } catch { /* state 取得失敗 */ }

      let state;
      try {
        state = await gatherTargetState(issue);
      } catch (err) {
        logger.warn?.(`  [scan-waiting-input] issue #${issue.number}: 状態収集失敗: ${err.message}`);
        continue;
      }

      // 指示待ち中に PR ができたケースの URL/アイコン補完（確認中も PR に飛べるように）。
      if (state.pr && state.prState) {
        await ensurePRRecorded(issue, state.target, state.pr);
      }

      // `Status: answered`（ペイン経由で解決済み＝転送不要）の復帰は scanAnsweredRecovery が
      // 健全性ゲートより前で処理済み。ここに来る waiting-input issue は返信転送が必要なケース。
      if (!saved || saved.termId == null) {
        // termId が分からないと返信を pane に転送できない（再起動等で state 喪失）。
        logger.warn?.(`  [scan-waiting-input] issue #${issue.number}: termId 不明のため返信転送をスキップ`);
        continue;
      }

      const reply = findReplyAfterWaitingInput(state.comments);
      if (!reply) continue;
      const decision = decideReplyForward({
        replyId: reply.id,
        saved,
        maxAttempts,
      });
      // 二重転送ガード（毎ティック走るため、転送済み返信は再送しない）。
      // ただし「転送は成功したが直後の setStatus('status:in-progress') が失敗した」場合、
      // この issue は waiting-input のまま残り、次ティック以降は毎回ここで continue するため
      // setStatus が二度と再試行されず永久に固着する（#154）。
      // 転送（submitToClaude）はスキップしつつ、in-progress 復帰だけを再試行する。
      // scanWaitingInputIssues は waiting-input の issue しか走査しないので、復帰成功後は
      // 自然に対象から外れる（冪等）。
      if (decision.type === 'already-forwarded') {
        try {
          await setStatus(issue.number, 'status:in-progress');
          logger.log?.(`  [scan-waiting-input] issue #${issue.number}: 転送済み・in-progress 復帰のみ再試行 → in-progress`);
        } catch (err) {
          logger.warn?.(`  [scan-waiting-input] issue #${issue.number}: in-progress 復帰再試行失敗（次ループ再試行）: ${err.message}`);
        }
        continue;
      }

      if (decision.type === 'exhausted') {
        if (decision.notifyExhausted) {
          // この通知自身を最新の waiting-input マーカーにすることで、届かなかった返信を
          // マーカーより前へ下げる。ユーザーが改めてコメントすれば別の新しい返信として
          // 検出され、reply id ごとの試行回数が 1 から始まって自己回復できる。この書式を
          // 通常コメントへ変えると古い未達返信を拾い続けるため、decision-record を維持する。
          // findReplyAfterWaitingInput が読むのは gatherTargetState で集めた対象側のコメント列
          // なので、メタ issue ではなく state.target へ投稿しなければ自己回復できない。
          try {
            await addTargetComment(state.target, REPLY_FORWARD_EXHAUSTED_COMMENT);
          } catch (err) {
            logger.warn?.(
              `  [scan-waiting-input] issue #${issue.number}: 上限到達コメント投稿失敗（次ループ再試行）: ${err.message}`
            );
            continue;
          }
          const prev = saved.replyForward;
          try {
            // 通知投稿後の state 更新に失敗すると次巡回で再投稿されうるが、通知済み判定の
            // 唯一の真実は state.json なのでこの順序を維持し、次巡回での再試行を許容する。
            await updateTask(issue.number, {
              replyForward: {
                ...prev,
                exhaustedNotified: true,
              },
            });
          } catch (err) {
            logger.warn?.(
              `  [scan-waiting-input] issue #${issue.number}: 上限到達通知 state 更新失敗（次ループ再試行）: ${err.message}`
            );
            continue;
          }
        }
        continue;
      }

      // プロセス停止を挟んでも送信済み回数を失わないよう、試行回数は送信前に記録する。
      await updateTask(issue.number, {
        replyForward: {
          commentId: reply.id,
          attempts: decision.attempt,
          exhaustedNotified: false,
        },
      });

      let forwardResult;
      try {
        // clearBeforeSend:false — この経路の転送先は「waiting-input＝Claude が y/n 確認や
        // 権限承認のダイアログを出して止まっているペイン」であることが前提。生きた
        // ダイアログへ Ctrl-A(\x01) + Ctrl-K(\x0b) を撃つと Claude Code 側がどう解釈するか
        // （意図しない確定・キャンセル）はこちらから検証できないため、初回クリアは撃たない。
        // #189 が守りたいのは新規ディスパッチ時のアイドルペインであって、この経路は対象外。
        forwardResult = await submitToClaude(port, saved.termId, reply.body, undefined, {
          clearBeforeSend: false,
        });
      } catch (err) {
        // confirm:true では本文送信失敗を内部で握って bodyConfirmed:false を返すため、
        // throw まで来た時点では本文が入力欄へ届いた可能性を否定できない。さらに
        // clearBeforeSend:false の再送は追記となり、回数を戻すと同じ外部入力を無限に
        // 多重投入できてしまうので、通信障害でも安全側に倒して試行回数を消費させる。
        // 上限到達時は waiting-input の decision-record が自己回復を案内し、ユーザーが
        // 改めてコメントすれば新しい返信として試行回数 1 から再送できる。
        logger.warn?.(`  [scan-waiting-input] issue #${issue.number}: 返信転送失敗（次ループ再試行）: ${err.message}`);
        continue;
      }
      if (
        forwardResult?.bodyConfirmed === false &&
        !(await reconfirmBodyEcho(port, saved.termId, reply.body))
      ) {
        // reconfirmBodyEcho は /states を読むだけで制御文字を送らないため、生きた
        // ダイアログを守る clearBeforeSend:false の方針と両立する。偽陽性でなければ
        // カーソルを進めず、次巡回の有界再送に委ねる。
        logger.warn?.(
          `  [scan-waiting-input] issue #${issue.number}: 返信本文が入力欄に届いていない可能性があります (termId=${saved.termId})`
        );
        continue;
      }
      // 転送成功直後にカーソルを記録（setStatus 失敗時でも二重転送を防ぐ）。
      try {
        await updateTask(issue.number, {
          lastForwardedCommentId: reply.id,
          replyForward: null,
        });
      } catch { /* カーソル記録失敗は致命的でない */ }
      try {
        await setStatus(issue.number, 'status:in-progress');
        logger.log?.(`  [scan-waiting-input] issue #${issue.number}: 返信(id:${reply.id})を転送 → in-progress`);
      } catch (err) {
        logger.warn?.(`  [scan-waiting-input] issue #${issue.number}: in-progress 復帰失敗（次ループ再試行）: ${err.message}`);
      }
    }
  };

  return async function scanWaitingInputIssues() {
    // 返信転送は対象 issue/PR のコメント収集（gatherTargetState）が前提のため GitHub 連携が必要。無効時はスキップ。
    if (!githubIntegration) return;
    if (isScanning) {
      logger.log?.('[scan-waiting-input] 前回の返信転送処理が継続中のためスキップ');
      return;
    }
    isScanning = true;

    try {
      await scan();
    } finally {
      isScanning = false;
    }
  };
}
