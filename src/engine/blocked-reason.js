import { isPRConflicted } from './conflict-handback.js';
import { BLOCKED_REASON_DISPLAY_LABELS } from './task-domain.js';

/**
 * ワークフロー上の位置（status）とは別に、タスクが人手待ちで止まっている理由を扱う純関数群。
 *
 * GitHub API への副作用を呼び出し側へ残し、PR 状態から blocked ラベルの付け外しを決める
 * ロジック、表示可否、ステータス遷移後に取り残されたラベルの検出をここへ集約する。
 * ラベルそのものを冪等性の唯一の真実にすることで、コメント本文や head SHA に依存せず、
 * ポーリングの再実行・プロセス再起動後も同じ判断を再現できる。
 */

export const BLOCKED_REASON_CONFLICT = 'conflict';

const BLOCKED_PREFIX = 'blocked:';
const DISPLAYABLE_BLOCKED_STATUSES = new Set(['waiting-merge']);

function labelName(label) {
  return typeof label === 'string' ? label : label?.name;
}

function isDisplayableBlockedStatus(labelsConfig, label) {
  const entry = Object.entries(labelsConfig?.status ?? {})
    .find(([, configuredLabel]) => configuredLabel === label);
  const status = entry
    ? ({
        waitingMerge: 'waiting-merge',
        waitingInput: 'waiting-input',
      }[entry[0]] ?? null)
    : (label?.startsWith('status:') ? label.slice('status:'.length) : null);
  return DISPLAYABLE_BLOCKED_STATUSES.has(status);
}

/**
 * PR が明確にコンフリクト解消済みか判定する。
 * `mergeableState` の unknown / behind / blocked / unstable だけを根拠に解消済みとは読まず、
 * GitHub が `mergeable=true` と確定しており、かつ dirty でない場合だけ解消済みとする。
 */
export function isConflictResolved(prState) {
  return prState?.mergeable === true && prState?.mergeableState !== 'dirty';
}

/** PR がマージ済み、または open ではなくなったか判定する。 */
export function isPRFinished(prState) {
  if (prState == null) return false;
  return prState?.merged === true || prState?.state !== 'open';
}

/** 通常のマージ監視で、人手対応を示す conflict ラベルが必要か判定する。 */
export function requiresConflictBlockedLabel({ prState, hasAutomergeLabel = false } = {}) {
  return isPRConflicted(prState) && !hasAutomergeLabel;
}

/**
 * 現在の PR 状態とラベル状態から blocked:conflict の操作を決める。
 *
 * mergeable=null は GitHub 側の非同期計算中であり、解消とも再コンフリクトとも断定できない。
 * この状態では付与・除去のどちらも行わず、false → null → false の観測揺れでバッジや通知が
 * 点滅しないよう次ループまで fail-closed で保留する。
 */
export function decideBlockedLabelForConflict({
  prState,
  hasBlockedLabel = false,
  humanActionRequired = false,
} = {}) {
  if (isPRFinished(prState)) {
    return { action: hasBlockedLabel ? 'remove' : 'none' };
  }
  if (isConflictResolved(prState)) {
    return { action: hasBlockedLabel ? 'remove' : 'none' };
  }
  if (
    prState?.mergeable !== null &&
    isPRConflicted(prState) &&
    humanActionRequired === true
  ) {
    return { action: hasBlockedLabel ? 'none' : 'add' };
  }
  return { action: 'none' };
}

/** issue の labels から設定済み blocked reason の bare 名を返す。未知の blocked:* も保持する。 */
export function blockedReasonFromLabels(labels, { labelsConfig } = {}) {
  const names = (labels ?? [])
    .map(labelName)
    .filter((name) => typeof name === 'string' && name !== '');
  for (const [reason, configuredLabel] of Object.entries(labelsConfig?.blocked ?? {})) {
    if (names.includes(configuredLabel)) return reason;
  }
  const blockedLabel = names.find((name) => name.startsWith(BLOCKED_PREFIX));
  return blockedLabel?.slice(BLOCKED_PREFIX.length) ?? null;
}

/** blocked reason を GUI に出してよいステータスか判定する表示側ガード。 */
export function shouldDisplayBlockedReason({ status, blockedReason } = {}) {
  return Object.hasOwn(BLOCKED_REASON_DISPLAY_LABELS, blockedReason) &&
    DISPLAYABLE_BLOCKED_STATUSES.has(status);
}

/**
 * blocked:* を持つのに waiting-merge 以外へ移った open issue を抽出する。
 */
export function collectStaleBlockedIssues(issues, { labelsConfig } = {}) {
  const stale = [];
  const configuredBlockedLabels = new Set(
    Object.values(labelsConfig?.blocked ?? {})
      .filter((name) => typeof name === 'string' && name !== '')
  );
  for (const issue of issues ?? []) {
    const names = (issue?.labels ?? [])
      .map(labelName)
      .filter((name) => typeof name === 'string' && name !== '');
    const blockedLabels = names.filter((name) => configuredBlockedLabels.has(name));
    if (blockedLabels.length === 0) continue;
    const statusLabel = names.find((name) =>
      name.startsWith('status:') ||
      Object.values(labelsConfig?.status ?? {}).includes(name)
    );
    if (!isDisplayableBlockedStatus(labelsConfig, statusLabel)) {
      stale.push({ number: issue.number, blockedLabels });
    }
  }
  return stale;
}

/**
 * 取得済み issue 群から取り残し blocked ラベルを除去する独立スキャナを作る。
 * listAllQueueIssues の結果を注入するため、このスキャナ自身は読み取り API を増やさない。
 */
export function createStaleBlockedLabelReconciler({
  removeBlockedLabel,
  getLabelsConfig,
  logger = console,
}) {
  return async function reconcileStaleBlockedLabels(issues) {
    try {
      const staleIssues = collectStaleBlockedIssues(issues, {
        labelsConfig: getLabelsConfig(),
      });
      for (const { number, blockedLabels } of staleIssues) {
        for (const blockedLabel of blockedLabels) {
          try {
            await removeBlockedLabel(number, blockedLabel);
            logger.log?.(`  [blocked-sweep] issue #${number}: ${blockedLabel} を除去`);
          } catch (err) {
            logger.warn?.(`  [blocked-sweep] issue #${number}: ${blockedLabel} の除去失敗（次ループで再試行）: ${err.message}`);
          }
        }
      }
    } catch (err) {
      logger.warn?.(`[blocked-sweep] 取り残しラベルの照合失敗（次ループで再試行）: ${err.message}`);
    }
  };
}
