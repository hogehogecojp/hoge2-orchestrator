// VK Terminals へ注入するサイドバーメニューの payload 組み立てをここに集約する。
// HTTP 送信は terminals/index.js の postMenu に委譲し、このファイルは副作用のない純粋関数だけにする。
// 将来、実行中タスク一覧などの動的メニューを追加するときも、組み立てと送信を分けたまま拡張できる。

// POST /api/menu は source 単位でセクション全体を丸ごと置換するため、この識別子を固定して使う。
export const MENU_SOURCE = 'vk-orchestrator';

/**
 * VK Terminals のサイドバーメニューへ投入する VK Orchestrator セクションを組み立てる。
 *
 * このセクションは意図的に空（items: []）にして、サイドバーの「VK Orchestrator」
 * セクションを出さない（クリアする）。task-queue への導線は VK Terminals 側の
 * タスク一覧見出しのリンクへ一本化したため、orchestrator からは項目を出さない。
 *
 * POST /api/menu は同じ source の再投稿でセクション全体を丸ごと置換する冪等 API で、
 * items.length === 0 のときは該当 source のセクションを削除する。したがって空の items を
 * 返し続けることで、旧バージョンが注入した task-queue 項目も自己クリアされる。
 * source（MENU_SOURCE）は API 上必須なので残す。
 *
 * @returns {{source:string,title:string,items:Array}} VK Terminals menu section（items は常に空）
 */
export function buildOrchestratorMenu() {
  return {
    source: MENU_SOURCE,
    title: 'VK Orchestrator',
    items: [],
  };
}
