// -------------------------------------------------------
// setup:agents — vk-agents の sync.sh 終了コードの解釈
//
// `vk-orchestrator setup:agents` は同梱 vk-agents-public の `scripts/sync.sh` を
// 実行して skills/rules を ~/.claude へ展開する。この sync.sh は終了コードを
// 3 段階で使い分ける（vektor-inc/vk-agents#302）:
//
//   0 … 完全成功。すべての配布物を書き込めた
//   2 … 部分成功。配布自体は最後まで走ったが、配布先に symlink や利用者自身の
//       同名ファイルがあるなどの理由で一部の書き込みを見送った
//   1 … 失敗。引数エラーなどで配布そのものを開始／完走できなかった
//
// 2 を一律で失敗扱いにすると、配布が完了している回でも setup:agents が中断し、
// 直後に行うはずの「展開元サイドカーの記録」（writeVkAgentsManifestSource）が
// 残らない。そこで終了コードの解釈だけをこの純関数へ切り出し、bin 側の巨大な
// switch を経由せずユニットテストで検証できるようにしている。
//
// ただし 2 は部分成功だけを一意に指すコードではない。sync.sh は `set -euo pipefail`
// で走るため内部コマンドが 2 を返して途中で落ちた場合も 2 になり、スクリプトに構文
// エラーがあれば bash 本体が 2 を返す。さらに同梱の sync.sh が #302 反映前の版だと
// 2 は異常しか意味しない。そのため続行はしても「完了した」と断定はせず、上に出て
// いる sync.sh の出力を必ず見に行ってもらう文言にしている。
// -------------------------------------------------------

// sync.sh の終了コード。数値リテラルの意味を呼び出し側でも参照できるよう公開する。
export const SYNC_EXIT_SUCCESS = 0;
export const SYNC_EXIT_PARTIAL_SUCCESS = 2;

// 終了コード 2 のときに表示する警告文。sync.sh 自身が stdio: 'inherit' で出力を出して
// いるため、スキップ一覧もエラーも上に見えている。利用者が「正常に終わった」と早合点
// しないよう、断定を避けてその出力を確認する導線だけを示す。
const PARTIAL_SUCCESS_WARNING =
  '[setup:agents] sync.sh が終了コード 2 で終了しました。一部のファイルは書き込みを見送られた可能性があります。\n' +
  '  ただし sync.sh がエラーで途中終了した場合も 2 になり得ます。上の sync.sh の出力を確認し、\n' +
  '  エラーが出ていないか、どの対象がスキップされたかを必ず確認してください。\n' +
  '  展開元の記録は続行しますが、展開内容が不完全な可能性があります。';

/**
 * sync.sh の終了ステータスから、setup:agents を続行してよいかを判定する。
 *
 * @param {number|null|undefined} status spawnSync の結果 `status`
 *   （シグナル終了・spawn 失敗時は null になる）
 * @returns {{ proceed: boolean, warning: string|null, exitCode: number|null }}
 *   - proceed  … true なら後続処理（展開元の記録など）を続行してよい
 *   - warning  … 表示すべき警告文。不要なら null
 *   - exitCode … 中断する場合のプロセス終了コード。続行する場合は null
 */
export function evaluateSyncExit(status) {
  // 完全成功。警告なしでそのまま続行する。
  if (status === SYNC_EXIT_SUCCESS) {
    return { proceed: true, warning: null, exitCode: null };
  }

  // 部分成功。配布まで到達している可能性があるため中断せず、警告のみ出す。
  if (status === SYNC_EXIT_PARTIAL_SUCCESS) {
    return { proceed: true, warning: PARTIAL_SUCCESS_WARNING, exitCode: null };
  }

  // それ以外（1 などの失敗、および null＝シグナル終了・spawn 失敗）は中断する。
  // status が数値でない場合は従来どおり 1 にフォールバックする。
  return {
    proceed: false,
    warning: null,
    exitCode: typeof status === 'number' ? status : 1,
  };
}
