/**
 * vk-orchestrator 自身の自己更新可否を決める純粋関数。
 *
 * 実際の git / npm / zip 入れ替え / re-exec は CLI 側で行い、このモジュールは
 * package.json の version とリモート最新版、入手経路（チャネル）、作業ツリー状態だけから判断する。
 *
 * 戻り値は必ず `{ action, reason }` の 2 フィールドのみ。呼び出し側とテストがこの形に依存しているため、
 * 情報を増やしたいときはフィールドを足さず reason を増やすこと。
 */

import { cmpTuple, toTuple } from '../../scripts/vk-terminals-tags.mjs';

/**
 * @param {object} input
 * @param {string|null} [input.current] package.json の現在 version
 * @param {string|null} [input.latest] リモート最新版（git ならタグ、zip なら更新情報ファイルの version）
 * @param {boolean} [input.dirty] 未コミット変更があるか（git チャネルのみ意味を持つ）
 * @param {string} [input.branch] 現在のブランチ名（git チャネルのみ意味を持つ）
 * @param {boolean} [input.optOut] 自己更新を無効化しているか
 * @param {boolean} [input.alreadyUpdated] re-exec 後の再チェックか
 * @param {'git'|'zip'|'off'|'unknown'} [input.channel] 入手経路。既定は従来動作の git
 * @param {boolean} [input.busy] GUI 稼働中・engine 起動中か（zip チャネルのみ意味を持つ）
 * @returns {{ action: 'update'|'skip', reason: string }}
 */
export function orchestratorUpdateDecision({
  current = null,
  latest = null,
  dirty = false,
  branch = '',
  optOut = false,
  alreadyUpdated = false,
  channel = 'git',
  busy = false,
} = {}) {
  if (alreadyUpdated) return { action: 'skip', reason: 'already-updated' };
  // env で off を明示した場合も「自動更新を切っている」状態そのものなので opt-out に寄せる
  // （利用者に出す文言も設定 OFF と同じで正しい）。
  if (optOut || channel === 'off') return { action: 'skip', reason: 'opt-out' };
  // 入手経路が決まらない状態で git / zip のどちらの手順も実行してはいけない
  // （とくに親リポジトリ配下へ zip を展開された状態で git 操作をしない）。
  if (channel === 'unknown') return { action: 'skip', reason: 'channel-unresolved' };

  if (!current || !latest) return { action: 'skip', reason: 'version-unresolved' };

  const currentTuple = toTuple(current);
  const latestTuple = toTuple(latest);
  if (!currentTuple || !latestTuple) return { action: 'skip', reason: 'invalid-version' };
  if (cmpTuple(latestTuple, currentTuple) <= 0) return { action: 'skip', reason: 'up-to-date' };

  if (channel === 'zip') {
    // zip 入れ替えは走行中のプロセスとターミナルを巻き込むため、静止していないときは当てない。
    // dirty / ブランチは zip 環境には存在しない概念なので見ない。
    if (busy) return { action: 'skip', reason: 'busy' };
    return { action: 'update', reason: 'newer-release' };
  }

  // git チャネル: 作業中の変更・作業ブランチを壊さない。
  if (dirty) return { action: 'skip', reason: 'dirty' };
  if (branch !== 'main') return { action: 'skip', reason: 'non-main-branch' };

  return { action: 'update', reason: 'newer-release' };
}
