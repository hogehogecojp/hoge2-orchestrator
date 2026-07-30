/**
 * 同梱している vk-agents（スキル・ルール）を ~/.claude へ再展開すべきかを決める純粋関数。
 *
 * アプリ本体を新しくしても、~/.claude 側に展開済みのスキルは古いまま残る。これまでは
 * 「展開済みかどうか（マニフェストの有無）」しか見ていなかったため、古い版が展開済みの
 * 状態を検知できなかった。そこで同梱側に版を記録（vendor/vk-agents-public/.vendor-version.json）し、
 * 展開済み側の記録（~/.claude/skills/.agent-skills-manifest-source の sourceVersion）と
 * 突き合わせる。
 *
 * 比較は「異なるか」ではなく「同梱のほうが新しいか」で行う。~/.claude は利用者の
 * グローバル設定で、`sync.sh --claude-global` による書き換えは取り返しがつかない。
 * そして同梱 vendor が利用者自身の vk-agents clone より古いのは通常の定常状態である
 * （リリースのたびに同梱をそろえるが、利用者は自分の clone から先に同期している）。
 * そのため「異なれば展開」にすると、自分で vk-agents を同期している利用者の ~/.claude を
 * 古い内容へ巻き戻してしまう。
 *
 * 判断に足る材料が無いときも展開しない。展開済みの中身が新しい可能性があるかぎり、
 * 書き換えない側が安全側になる。
 */

import { cmpTuple, toTuple } from '../../scripts/vk-terminals-tags.mjs';

/**
 * 同梱と展開済みの版を突き合わせ、どういう状態かを 1 つのコードで表す。
 *
 * 版の比較を持つのはこの関数だけにして、再展開の判断（needsAgentsRedeploy /
 * resolveAgentsSyncAction）・doctor の表示・利用者へ出す文言が同じ結論を共有する。
 *
 * @param {object} input
 * @param {string|null} input.vendorVersion 同梱している vk-agents の版（読めなければ null）
 * @param {string|null} input.recordedVersion 展開済みとして記録されている版（旧形式では無い＝null）
 * @param {boolean} input.manifestExists ~/.claude 側にスキルのマニフェストがあるか
 * @returns {{ code: 'not-deployed'|'vendor-unknown'|'recorded-unknown'|'invalid-version'
 *                   |'vendor-newer'|'vendor-older'|'up-to-date',
 *             vendor: string|null, recorded: string|null }}
 */
export function evaluateAgentsVersionState({
  vendorVersion = null,
  recordedVersion = null,
  manifestExists = false,
} = {}) {
  const vendor = normalize(vendorVersion);
  const recorded = normalize(recordedVersion);
  const state = (code) => ({ code, vendor, recorded });

  // そもそも展開されていない（初回・~/.claude を消した後）。
  if (!manifestExists) return state('not-deployed');

  // 同梱側の版が読めないと比較の材料が無い。
  if (vendor === null) return state('vendor-unknown');

  // 展開済み側の版が分からない（この仕組みより前から使っている環境）。
  // 「分からない」は「古い」ではない。展開済みのほうが新しい可能性があるので触らない。
  if (recorded === null) return state('recorded-unknown');

  const vendorTuple = toTuple(vendor);
  const recordedTuple = toTuple(recorded);
  // どちらかが semver として読めなければ大小を決められない。
  if (!vendorTuple || !recordedTuple) return state('invalid-version');

  const diff = cmpTuple(vendorTuple, recordedTuple);
  if (diff > 0) return state('vendor-newer');
  if (diff < 0) return state('vendor-older');
  return state('up-to-date');
}

/**
 * 再展開が必要かを返す。
 *
 * `not-deployed` も deploy 側に入るが、実際に走らせるかは resolveAgentsSyncAction が決める
 * （初回セットアップは案内に任せる）。
 *
 * @param {object} input evaluateAgentsVersionState と同じ
 * @returns {{ action: 'deploy'|'skip', reason: string }}
 */
export function needsAgentsRedeploy(input = {}) {
  const { code } = evaluateAgentsVersionState(input);
  if (code === 'not-deployed') return { action: 'deploy', reason: 'manifest-missing' };
  if (code === 'vendor-newer') return { action: 'deploy', reason: 'vendor-newer' };
  return { action: 'skip', reason: code };
}

/**
 * 起動時に `sync.sh --claude-global` を実行してよいかを決める。
 *
 * sync.sh は利用者のグローバル設定（~/.claude）を書き換えるため、走らせるのは
 * 「同梱のほうが新しいと確かに分かる」ときだけにする。
 *
 *   - 同梱が新しい（vendor-newer）… 走らせる
 *   - 同梱が古い（vendor-older）… 走らせない。走らせると利用者の ~/.claude を巻き戻す。
 *     同梱が利用者の clone より古いのは通常の定常状態
 *   - 同じ（up-to-date）… 走らせない（毎起動で書き換えない）
 *   - 展開済みの版が分からない（recorded-unknown）… 走らせない。分からない以上、展開済みの
 *     中身が新しい可能性がある。doctor で「確認できない」と案内するだけにする
 *   - 同梱の版が読めない・semver でない（vendor-unknown / invalid-version）… 走らせない
 *   - まだ一度も展開されていない（not-deployed）… 走らせない。初回セットアップは
 *     `/vk-orchestrator-setup` の案内に任せる。ここで勝手に書き換えると、セットアップ前の
 *     環境で意図しない配布が起きてしまう
 *
 * 明示的な `npm run setup:agents` は利用者が自分で選んだ操作なので、この判定を通さず
 * 従来どおり無条件に展開する。
 *
 * @param {object} input evaluateAgentsVersionState と同じ
 * @returns {{ run: boolean, reason: string }}
 */
export function resolveAgentsSyncAction(input = {}) {
  const { code } = evaluateAgentsVersionState(input);
  if (code === 'vendor-newer') return { run: true, reason: 'vendor-newer' };
  if (code === 'not-deployed') return { run: false, reason: 'initial-setup-required' };
  return { run: false, reason: code };
}

/**
 * 版表記のゆらぎ（前後空白・先頭の v）を吸収する。
 * `v0.14.0` と `0.14.0` を別物として扱わないため。
 * @param {unknown} value
 * @returns {string|null}
 */
function normalize(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return null;
  return raw.replace(/^v/, '');
}
