// VK Terminals へ注入するサイドバーメニューの payload 組み立てをここに集約する。
// HTTP 送信は terminals/index.js の postMenu に委譲し、このファイルは副作用のない純粋関数だけにする。

import { formatMenuEntry } from './update-messages.js';

// POST /api/menu は source 単位でセクション全体を丸ごと置換するため、この識別子を固定して使う。
export const MENU_SOURCE = 'vk-orchestrator';

// VK Terminals は項目ごとに id を必須にしており、欠けるとセクション全体が拒否される
// （＝1 項目の不備でサイドバー通知そのものが GUI に出なくなる）。source 単位の置換なので
// 項目の識別子は固定値でよい。id は「その source の中で一意」であることだけが要求される。
export const MENU_ITEM_ID_UPDATE = 'update';

/**
 * VK Terminals のサイドバーメニューへ投入する VK Orchestrator セクションを組み立てる。
 *
 * 平常時（新しい版が無く、アップデートも止まっていない）は意図的に空（items: []）にして、
 * サイドバーの「VK Orchestrator」セクションを出さない。task-queue への導線は
 * VK Terminals 側のタスク一覧見出しのリンクへ一本化したため、通常は項目を出さない。
 *
 * 例外として、新しい版があるとき／アップデートが止まっているときだけ 1 項目を出す。
 * 押すと設定画面が開き、そこで詳しい状況と手順を読める（設定モーダルはタブ指定ができず
 * Orchestrator タブに着地するので、アップデート欄はそのタブの先頭に置いている）。
 * 更新が当たれば確認結果の記録も最新に変わるため、次のメニュー再投稿で項目は自動的に消える
 * （押しても何も無い項目が残ると、通知そのものが信用されなくなる）。
 *
 * POST /api/menu は同じ source の再投稿でセクション全体を丸ごと置換する冪等 API で、
 * items.length === 0 のときは該当 source のセクションを削除する。したがって空の items を
 * 返し続けることで、旧バージョンが注入した項目も自己クリアされる。
 * source（MENU_SOURCE）は API 上必須なので常に付ける。
 *
 * @param {{ updateSnapshot?: object|null }} [input] 最後に確認したアップデートの状況
 * @returns {{source:string,title:string,items:Array}} VK Terminals menu section
 */
export function buildOrchestratorMenu({ updateSnapshot = null } = {}) {
  const section = {
    source: MENU_SOURCE,
    title: 'VK Orchestrator',
    items: [],
  };

  if (!updateSnapshot) return section;

  const entry = formatMenuEntry({
    updateAvailable: updateSnapshot.updateAvailable === true,
    latest: updateSnapshot.latest ?? null,
    notice: updateSnapshot.notice ?? null,
    // 「長く確認できていない」は見た瞬間の性質なので、確認時刻を渡して表示側で評価させる。
    lastCheckedAt: updateSnapshot.lastCheckedAt ?? null,
  });
  if (!entry) return section;

  section.items.push({
    // id は VK Terminals の必須項目。欠けるとこのセクション全体が拒否される。
    id: MENU_ITEM_ID_UPDATE,
    // アイコンは label に埋めず icon で渡す（絵文字のみ・最大 2 文字）。
    // 埋め込むと、常に描かれるアイコン枠のぶん組み込み項目とテキスト左端がずれる。
    icon: entry.icon,
    // ラベルはサイドバー既定幅（330px）に収まる長さに抑える。
    label: entry.label,
    action: { type: 'open-settings' },
  });
  return section;
}
