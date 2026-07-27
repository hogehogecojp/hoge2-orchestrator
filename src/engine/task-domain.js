// タスクドメインの表示定義を一元管理するモジュール。
//
// ステータス7種の「表示に関わる定義」（グループ表示順・プルダウン選択肢順・tone
// トークン・日本語表示ラベル・遷移マトリクス・確認文言・優先度/直列の選択肢とバッジ）を
// この1箇所に集約する。VK Terminals はこれらを焼き込んだ宣言的ウィジェット
// （tasks-widget.json）を受け取り、語彙・色・遷移・操作を自前に持たずに描画する。
//
// 【tone について】ここでは生の HEX 色を持たず、意味語彙（tone トークン）だけを持つ。
// 具体的な配色はビューア側（VK Terminals）が tone → 色へマッピングする責務を負う。
//
// 【ラベル文字列の正本】`status:xxx` などの GitHub ラベル綴りは従来どおり
// src/config.js の getLabelsConfig() が正本で、必要な箇所だけ commands-file.js の
// statusLabelFor() 等で解決する（ユーザーのラベルリネーム機能を壊さないため）。
// このモジュールは bare 名（awaiting-approval 等）をキーにし、画面表示用の
// 日本語ラベル（承認待ち 等）だけを完成文として持つ（i18n 責務は orchestrator 側）。

const STATUS_PREFIX = 'status:';

// ステータス7種の bare 名（正準の綴り）。
export const STATUS_NAMES = Object.freeze([
  'awaiting-approval',
  'ready',
  'in-progress',
  'waiting-input',
  'waiting-merge',
  'done',
  'failed',
]);

// 許可されたステータス遷移（`from->to` の集合）。commands-file.js から移設。
// GUI からのステータス変更依頼は、この集合に含まれる遷移だけを受理する。
export const ALLOWED_TRANSITIONS = new Set([
  'awaiting-approval->ready',
  'ready->awaiting-approval',
  'in-progress->awaiting-approval',
  'waiting-input->awaiting-approval',
  'waiting-merge->awaiting-approval',
  'failed->awaiting-approval',
  'waiting-merge->done',
  'failed->ready',
  'ready->failed',
]);

/**
 * from → to のステータス遷移が許可されているか判定する。
 * `status:` 接頭辞付き・bare 名のどちらでも受け付ける（接頭辞は落として比較）。
 * @param {string} from 遷移元ステータス
 * @param {string} to 遷移先ステータス
 * @returns {boolean}
 */
export function isAllowedTransition(from, to) {
  const normalizedFrom = typeof from === 'string' && from.startsWith(STATUS_PREFIX)
    ? from.slice(STATUS_PREFIX.length)
    : String(from ?? '');
  const normalizedTo = typeof to === 'string' && to.startsWith(STATUS_PREFIX)
    ? to.slice(STATUS_PREFIX.length)
    : String(to ?? '');
  return ALLOWED_TRANSITIONS.has(`${normalizedFrom}->${normalizedTo}`);
}

// グループ表示順。タスク一覧を status ごとにまとめて並べる際の順序。
// 「作業中（要注目）を上、完了を末尾」の運用意図に沿う（プルダウン選択肢順とは別物）。
export const STATUS_GROUP_ORDER = Object.freeze([
  'in-progress',
  'waiting-input',
  'ready',
  'awaiting-approval',
  'waiting-merge',
  'failed',
  'done',
]);

// プルダウン（ステータス変更セレクト）内の選択肢の並び順。
// グループ表示順とは別に持つ（現行 VK Terminals でも別定義のため両方必要）。
export const STATUS_SELECT_ORDER = Object.freeze([
  'awaiting-approval',
  'ready',
  'in-progress',
  'waiting-input',
  'waiting-merge',
  'done',
  'failed',
]);

// 画面表示用の日本語ラベル（bare 名 → 表示文字列）。
// GitHub ラベル綴り（status:xxx）とは別物。グループ見出し・確認文言にも使う。
export const STATUS_DISPLAY_LABELS = Object.freeze({
  'awaiting-approval': '承認待ち',
  ready: '実行待ち',
  'in-progress': '実行中',
  'waiting-input': '入力待ち',
  'waiting-merge': 'マージ待ち',
  done: '完了',
  failed: '失敗',
});

// ステータスごとの tone トークン（意味語彙。生 HEX は持たない）。
// 現行 VK Terminals の配色を意味づけしたもの:
//   in-progress=進行中(緑)=progress / waiting-input=注意(黄)=warning /
//   ready・waiting-merge=情報(青)=info / awaiting-approval=承認待ち(紫)=attention /
//   failed=危険(赤)=danger / done=中立(灰)=neutral。
export const STATUS_TONES = Object.freeze({
  'awaiting-approval': 'attention',
  ready: 'info',
  'in-progress': 'progress',
  'waiting-input': 'warning',
  'waiting-merge': 'info',
  done: 'neutral',
  failed: 'danger',
});

// パルス等の強調（emphasis）を意味属性として持つ（色ではなく意味で表す）。
// 現行 waiting-input の点滅アニメーション相当を emphasis:'attention' で表現する。
export const STATUS_EMPHASIS = Object.freeze({
  'waiting-input': 'attention',
});

// 操作可能（編集 UI を出す）ステータス集合。done は操作不可（false）。
export const EDITABLE_STATUSES = new Set([
  'awaiting-approval',
  'ready',
  'in-progress',
  'waiting-input',
  'waiting-merge',
  'failed',
]);

// 優先度の選択肢（プルダウン用）。none を含む＝選択肢集合。
export const PRIORITY_OPTIONS = Object.freeze([
  Object.freeze({ value: 'high', label: '高' }),
  Object.freeze({ value: 'medium', label: '中' }),
  Object.freeze({ value: 'low', label: '低' }),
  Object.freeze({ value: 'none', label: 'なし' }),
]);

// バッジ表示する優先度値の集合。none はバッジ化しない＝選択肢集合とは別。
export const PRIORITY_BADGE_VALUES = new Set(['high', 'medium', 'low']);

// 優先度バッジの tone。high=危険(赤) / medium=注意(黄) / low=成功(緑)。
export const PRIORITY_TONES = Object.freeze({
  high: 'danger',
  medium: 'warning',
  low: 'success',
});

// 直列/並列の選択肢（プルダウン用）。
export const SEQUENTIAL_OPTIONS = Object.freeze([
  Object.freeze({ value: 'sequential', label: '直列' }),
  Object.freeze({ value: 'parallel', label: '並列' }),
]);

// 直列/並列バッジの tone。sequential=情報(青) / parallel=中立(灰)。
export const SEQUENTIAL_TONES = Object.freeze({
  sequential: 'info',
  parallel: 'neutral',
});

// 自動マージの選択肢（プルダウン用）。
export const AUTOMERGE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'automerge', label: 'する' }),
  Object.freeze({ value: 'manual', label: 'しない' }),
]);

// 自動マージバッジの tone。automerge=成功(緑) / manual=中立(灰)。
export const AUTOMERGE_TONES = Object.freeze({
  automerge: 'success',
  manual: 'neutral',
});

// バッジ単体でも意味が伝わるよう、選択肢ラベルとは別に短い表示名を持つ。
export const AUTOMERGE_BADGE_LABELS = Object.freeze({
  automerge: '自動マージ',
  manual: '手動マージ',
});

// 宣言の言語。今回は日本語完成文のみ。
export const DOMAIN_LANG = 'ja';

// 未知値/未知フィールドのフォールバック規約。
export const DEFAULT_TONE = 'neutral';
export const EMPTY_TEXT = '表示できるタスクがありません。';

/**
 * bare ステータス名の表示ラベルを返す。未知値はその bare 名をそのまま返す
 * （未知値フォールバック規約: 既定ラベル＝bare 名）。
 * @param {string} status bare ステータス名
 * @returns {string}
 */
export function statusDisplayLabel(status) {
  return STATUS_DISPLAY_LABELS[status] ?? String(status ?? '');
}

/**
 * bare ステータス名の tone を返す。未知値は既定 tone（neutral）。
 * @param {string} status bare ステータス名
 * @returns {string}
 */
export function statusTone(status) {
  return STATUS_TONES[status] ?? DEFAULT_TONE;
}

/**
 * 優先度値の表示ラベルを返す。未知値はその値をそのまま返す。
 * @param {string} value 優先度値（high/medium/low/none）
 * @returns {string}
 */
export function priorityLabel(value) {
  return PRIORITY_OPTIONS.find((option) => option.value === value)?.label ?? String(value ?? '');
}

/**
 * 直列/並列値の表示ラベルを返す。未知値はその値をそのまま返す。
 * @param {string} value 'sequential' | 'parallel'
 * @returns {string}
 */
export function sequentialLabel(value) {
  return SEQUENTIAL_OPTIONS.find((option) => option.value === value)?.label ?? String(value ?? '');
}

/**
 * 自動マージ値の表示ラベルを返す。未知値はその値をそのまま返す。
 * @param {string} value 'automerge' | 'manual'
 * @returns {string}
 */
export function automergeLabel(value) {
  return AUTOMERGE_OPTIONS.find((option) => option.value === value)?.label ?? String(value ?? '');
}

/**
 * 自動マージバッジの表示ラベルを返す。未知値はその値をそのまま返す。
 * @param {string} value 'automerge' | 'manual'
 * @returns {string}
 */
export function automergeBadgeLabel(value) {
  return AUTOMERGE_BADGE_LABELS[value] ?? String(value ?? '');
}

/**
 * ステータス遷移の確認ダイアログ文言（完成文）を返す。文言はデータ依存で、
 * orchestrator 側で PR 有無を解決した完成文を返す（ビューアは分岐しない）。
 *
 *  - 承認待ちへの差し戻し（to='awaiting-approval'）: 二重起動注意を本文に載せる。
 *  - マージ待ち→完了（waiting-merge->done）: PR がある場合のみ
 *    「PR のマージは行われません（PR は開いたまま残ります）。」を本文に載せる。
 *  - 上記以外の遷移: 確認不要（null）。
 * @param {{ from?: string, to?: string, hasPrUrl?: boolean }} [params]
 * @returns {{ title: string, body: string } | null} 確認が必要なら完成文、不要なら null
 */
export function getTransitionConfirm({ from, to, hasPrUrl } = {}) {
  if (to === 'awaiting-approval') {
    return {
      title: `ステータスを「${statusDisplayLabel('awaiting-approval')}」に変更しますか？`,
      body: '実行中のセッションがある場合、再承認で二重起動につながる可能性があります。',
    };
  }
  if (from === 'waiting-merge' && to === 'done') {
    return {
      title: `ステータスを「${statusDisplayLabel('done')}」に変更しますか？`,
      body: hasPrUrl ? 'PR のマージは行われません（PR は開いたまま残ります）。' : '',
    };
  }
  return null;
}

/**
 * ステータス変更プルダウンの選択肢が遷移不可かを判定する。
 * 現在値と同じ選択肢は選択可（false）。それ以外は許可遷移でなければ不可（true）。
 * @param {string} currentStatus 現在の bare ステータス
 * @param {string} optionStatus 選択肢の bare ステータス
 * @returns {boolean}
 */
export function isStatusOptionDisabled(currentStatus, optionStatus) {
  if (optionStatus === currentStatus) return false;
  return !isAllowedTransition(currentStatus, optionStatus);
}

/**
 * ステータス変更プルダウンの選択肢の並び（bare 名の配列）を返す。
 * 現在値が未知（既知の7種以外）の場合は、その未知値を先頭に足して選択可能にする
 * （未知値フォールバック規約）。
 * @param {string} currentStatus 現在の bare ステータス
 * @returns {string[]}
 */
export function statusSelectOrderFor(currentStatus) {
  const isKnown = STATUS_SELECT_ORDER.includes(currentStatus);
  const hasUnknownCurrent = typeof currentStatus === 'string' && currentStatus && !isKnown;
  return hasUnknownCurrent
    ? [currentStatus, ...STATUS_SELECT_ORDER]
    : [...STATUS_SELECT_ORDER];
}

// tasks-widget.js が既定で参照するドメイン定義オブジェクト。
// buildTasksWidget(view, { domain }) の domain 引数に注入できる形でまとめる。
export const TASK_DOMAIN = Object.freeze({
  lang: DOMAIN_LANG,
  statusNames: STATUS_NAMES,
  groupOrder: STATUS_GROUP_ORDER,
  selectOrder: STATUS_SELECT_ORDER,
  displayLabels: STATUS_DISPLAY_LABELS,
  tones: STATUS_TONES,
  emphasis: STATUS_EMPHASIS,
  editableStatuses: EDITABLE_STATUSES,
  priorityOptions: PRIORITY_OPTIONS,
  priorityBadgeValues: PRIORITY_BADGE_VALUES,
  priorityTones: PRIORITY_TONES,
  sequentialOptions: SEQUENTIAL_OPTIONS,
  sequentialTones: SEQUENTIAL_TONES,
  automergeOptions: AUTOMERGE_OPTIONS,
  automergeTones: AUTOMERGE_TONES,
  automergeBadgeLabels: AUTOMERGE_BADGE_LABELS,
  defaultTone: DEFAULT_TONE,
  emptyText: EMPTY_TEXT,
  allowedTransitions: ALLOWED_TRANSITIONS,
  isAllowedTransition,
  statusDisplayLabel,
  statusTone,
  priorityLabel,
  sequentialLabel,
  automergeLabel,
  automergeBadgeLabel,
  getTransitionConfirm,
  isStatusOptionDisabled,
  statusSelectOrderFor,
});
