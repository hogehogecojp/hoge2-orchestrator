# tasks-widget.json スキーマ契約

VK Orchestrator が書き出す宣言的タスク一覧ウィジェット（`~/.task-queue/tasks-widget.json`）の
スキーマ契約。VK Terminals（ビューア）はこの宣言だけを読み、タスク一覧の語彙・色・遷移・操作を
自前に持たずに描画する。表示定義の正本は orchestrator 側（`src/engine/task-domain.js`）にあり、
このファイルはその宣言形式（#229 で VK Terminals が消費する契約）を固定する。

- 生成元: `src/engine/tasks-widget.js` の `buildTasksWidget(view, { domain, now, staleThresholdMs })`
- 書き出し: `writeTasksWidgetFile(widget, { filePath })`（`writeJsonAtomic` による原子的書き込み）
- 契約テスト: `tests/contract/tasksWidgetContract.js`（`tests/tasksWidgetContract.test.js` から実行）
- 移行方針: 旧 `tasks-view.json` と新 `tasks-widget.json` を当面 dual-write する。旧形式の廃止は
  #229 リリース後の後続 PR。

## トップレベル

| フィールド | 型 | 説明 |
|---|---|---|
| `schemaVersion` | integer | スキーマ版。互換を壊す変更のたびに増やす（現在 `1`）。ビューアは値で分岐可能。 |
| `kind` | string | 固定値 `"task-list"`。 |
| `lang` | string | 宣言内の文言（ラベル・確認文言・aria）の言語。現在 `"ja"`。 |
| `updatedAt` | string (ISO8601) | スナップショット生成時刻。staleness 判定にビューアが使う。 |
| `viewer` | string \| null | 自分（ログイン名）。担当者フィルタ既定判定用。`all`／未指定は `null`。 |
| `staleThresholdMs` | number | この閾値（ms）を超えて `updatedAt` が古ければ orchestrator 停止中とみなす。既定 `120000`。 |
| `emptyText` | string | タスクが 1 件も無いときの表示文言。 |
| `groups` | array | ステータスグループの配列（下記）。空グループは含めない。 |

### staleness の扱い

`stale` のような boolean は宣言に焼き込まない。ビューアが `updatedAt` と `staleThresholdMs` から
`now - updatedAt > staleThresholdMs` を毎描画で再計算する（orchestrator 停止を即時に反映するため）。

## グループ（`groups[]`）

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | グループの識別子＝bare ステータス名（例 `"in-progress"`）。未知ステータスはその bare 名。 |
| `label` | string | グループ見出しの表示文言（例 `"実行中"`）。 |
| `tone` | string | tone トークン（下記語彙）。ビューアが tone→色へマッピングする。 |
| `order` | integer | 表示順（配列内 index と一致。0 始まり）。 |
| `items` | array | タスクアイテムの配列（下記）。 |

グループの並び順は「グループ表示順」（`in-progress → waiting-input → ready → awaiting-approval →
waiting-merge → failed → done`）。既知ステータスをこの順に並べ、未知ステータスはその後ろに
登場順で続く。これは後述のプルダウン選択肢順とは別定義。

## アイテム（`items[]`）

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string | タスク ID（issue 番号の文字列）。 |
| `title` | string | タスクタイトル。 |
| `links` | array | 外部リンク。`{ rel: "queue" \| "pr" \| "target", url, label }`。`url` は `^https?://` のみ許可（`javascript:`/`data:` 等は生成側で除外）。無ければ空配列。 |
| `badges` | array | バッジ。`{ label, tone }`（優先度・直列/並列）。 |
| `updatedAt` | string \| null | タスクの最終更新時刻。 |
| `editable` | boolean | 操作可否。`done` は `false`。 |
| `emphasis` | string (任意) | 意味的強調。`waiting-input` は `"attention"`（現行のパルス相当を色ではなく意味で表す）。該当時のみ存在。 |
| `assignee` | string (任意) | 担当者ログイン名。存在時のみ。 |
| `controls` | array | 操作コントロール（下記）。`editable=false` のときは空配列。 |

`links[].rel` は、`queue` が task-queue 側の issue、`pr` が関連 PR、`target` が対象 issue の URL を表す。
ビューアはローカルモードのタスクタイトルリンク先として `target` を利用できる。

### バッジ（`badges[]`）

- 優先度: `high` / `medium` / `low` のみバッジ化する（`none` はバッジにしない＝選択肢集合とバッジ集合は別）。
  tone は `high=danger` / `medium=warning` / `low=success`。
- 直列/並列: 常に表示。tone は `sequential=info` / `parallel=neutral`。
- 自動マージ: 常に表示。tone は `automerge=success` / `manual=neutral`。

## コントロール（`controls[]`）

`editable` なアイテムは `status` / `priority` / `sequential` / `automerge` の 4 コントロールを持つ。

| フィールド | 型 | 説明 |
|---|---|---|
| `type` | string | 固定値 `"select"`。 |
| `field` | string | `"status"` \| `"priority"` \| `"sequential"` \| `"automerge"`。 |
| `label` | string | コントロールの表示ラベル。 |
| `ariaLabel` | string | スクリーンリーダ向けラベル。 |
| `current` | string | 現在値（bare 名）。`priority` は none 相当で `"none"`。 |
| `options` | array | 選択肢（下記）。 |

### 選択肢（`options[]`）

| フィールド | 型 | 説明 |
|---|---|---|
| `value` | string | 選択肢の値（bare 名）。 |
| `label` | string | 表示ラベル。 |
| `disabled` | boolean | 遷移不可なら `true`。現在値は常に `false`。 |
| `disabledReason` | string (任意) | `disabled=true` の理由テキスト（スクリーンリーダ向け）。 |
| `command` | object (任意) | 適用時に発行するコマンド断片（下記）。現在値には付かない。`disabled` の選択肢にも付かない。 |
| `confirm` | object (任意) | 確認ダイアログの完成文 `{ title, body }`（遷移に確認が要る場合のみ）。 |

#### command 発行形式

`option.command` は、単項目を確定するときに `commands.jsonl` の 1 行へ展開できる断片:

```json
{ "action": "set-status", "taskId": "139", "to": "awaiting-approval", "expected": "ready" }
```

- 単項目の `action`: `"set-status"` \| `"set-priority"` \| `"set-sequential"` \| `"set-automerge"` の 4 種。
- 複数項目の一括確定だけは `action: "apply-batch"` を使い、内側の `ops[]` に上記 4 種の
  `{ action, to, expected }` 断片を入れる（下記）。
- `taskId`: タスク ID（文字列）。
- `to`: 変更先の bare 値。
- `expected`: 変更前の現在値（CAS 用）。orchestrator 側で現状と突き合わせ、不一致なら破棄する。
- `id` と `requestedAt` は **含めない**。ビューアが commands.jsonl へ発行するときに一意 `id` と
  `requestedAt`（ISO8601）を付与する。最終的な 1 行は
  `{ id, taskId, action, to, expected, requestedAt }` になる。

#### 一括確定（`apply-batch`）

ビューアがサイドバー編集で複数項目をまとめて確定する場合は、既存の `option.command` 断片から
`action` / `to` / `expected` だけを集め、1 タスクにつき 1 行の `apply-batch` で包む。生成側は原則として
既存 option.command 断片を出し続け、`apply-batch` の組み立て責務はビューア側に置く。

```json
{
  "id": "batch-a1b2c3",
  "taskId": "139",
  "action": "apply-batch",
  "ops": [
    { "action": "set-priority", "to": "high", "expected": "medium" },
    { "action": "set-sequential", "to": "sequential", "expected": "parallel" },
    { "action": "set-automerge", "to": "automerge", "expected": "manual" },
    { "action": "set-status", "to": "awaiting-approval", "expected": "ready" }
  ],
  "requestedAt": "2026-07-22T00:00:00.000Z"
}
```

- トップレベルの `taskId` は 1 つだけで、`ops[]` 側には `taskId` を持たせない。
- `ops[]` は非空配列。指定できる op は `set-status` / `set-priority` / `set-sequential` / `set-automerge` の 4 種だけで、
  同一項目の重複は禁止する。
- orchestrator は対象 issue を 1 回だけ取得し、その単一スナップショットに対して全 op を事前判定する。
  1 つでも現在値と食い違えば、GitHub の変更 API は一切呼ばずに一括で破棄する。
- 判定はリトライ安全性のため、「現在値が `expected` と一致する」または「現在値が `to` と一致する」の
  どちらかを満たせば可とする。`to` と一致済みの op は適用済みとして set を呼ばない。
- 適用順は常に `set-priority` → `set-sequential` → `set-automerge` → `set-status`。`set-status` は
  `waiting-merge → done` で完了コメント投稿の副作用を持つため最後に適用し、既に `to` なら呼ばない。
- GitHub のラベル API はトランザクションではないため、適用途中で恒久エラー（4xx。ただし 403/429 を除く）
  が起きた場合だけ、先に成功した op が残る真の部分適用が起こり得る。この場合は既存の 1 行コマンドと同じく
  恒久失敗として隔離する。
- 旧ビューアは未知 action を無視する前方互換規約に従い、`apply-batch` を描画・実行できないだけで壊れない。

#### confirm（確認文言）

確認文言はデータ依存で、orchestrator 側で PR 有無まで解決した **完成文** を載せる（ビューアは分岐しない）。

- 承認待ちへの差し戻し（`to="awaiting-approval"`）: 二重起動注意を `body` に載せる。
- マージ待ち→完了（`from="waiting-merge"`, `to="done"`）: PR がある場合のみ
  「PR のマージは行われません（PR は開いたまま残ります）。」を `body` に載せる。PR が無ければ `body` は空文字。
- 上記以外: `confirm` は付かない。

### プルダウン選択肢順とグループ表示順は別

ステータスコントロールの選択肢順は「選択肢順」（`awaiting-approval → ready → in-progress →
waiting-input → waiting-merge → done → failed`）で、グループ表示順とは別に持つ。現在値が既知の 7 種に
無い（未知）場合は、その未知値を選択肢の先頭に足して選択可能にする。

## tone 語彙

生 HEX 色は宣言に含めない。ビューアが tone→色へマッピングする。使用する語彙:

| tone | 用途 |
|---|---|
| `warning` | waiting-input / 優先度 medium |
| `info` | ready / waiting-merge / 直列(sequential) |
| `progress` | in-progress |
| `success` | 優先度 low / 自動マージ(automerge) |
| `danger` | failed / 優先度 high |
| `neutral` | done / 並列(parallel) / 手動マージ(manual) / 未知値フォールバック |
| `attention` | awaiting-approval（および emphasis の値としても使用） |

## セキュリティ契約 / 描画側の責務

宣言に載る文字列と URL の扱いを、orchestrator（生成側）とビューア（描画側）の責務分界として契約に固定する。

### 文字列は必ずプレーンテキストとして描画する（必須）

宣言に載る**全ての文字列** — `title` / グループ・アイテム・コントロール・オプションの `label` /
`ariaLabel` / `disabledReason` / 確認文言（`confirm.title` / `confirm.body`）/ 空状態文言（`emptyText`）/
グループ見出し / バッジ `label` / `assignee` など — は、ビューアが **プレーンテキストとして描画**しなければ
ならない。DOM への挿入は `textContent`（または同等のエスケープ経路）を使い、**`innerHTML` は使わない**。

- 理由: これらの文字列には外部由来データ（GitHub issue のタイトル等、第三者が編集できる値）が含まれうる。
  ビューアが `innerHTML` で描画すると stored XSS になりうる。
- 責務分界: orchestrator は値を **エスケープせず JSON にそのまま載せる**（宣言は生の文字列を保持する）。
  **エスケープ（プレーンテキスト描画）は描画側の責務**とする。この分界を契約として固定し、両側の実装が
  勝手に前提を変えないこと。

### リンク URL のスキーム検証（生成側）

`links[].url` は orchestrator 側で `^https?://` にマッチする URL のみを許可し、`javascript:` /
`data:` 等のスキームは落とす（`src/engine/tasks-widget.js` の `httpUrlOrNull`）。宣言に載る `url` は
常に http(s) の実 URL であることを保証する。

## 未知値・未知フィールドのフォールバック規約

- 未知の tone / 未知のステータス: グループ・アイテムの tone は既定 `neutral`、ラベルは bare 名をそのまま表示。
- 未知の現在ステータス: ステータス選択肢の先頭に現在値を足し、他の遷移は `disabled` にする。
- ビューアは知らない `field` / `action` / `rel` / `tone` を受け取っても描画を壊さず、無視または既定表示に
  フォールバックすること（前方互換のため）。
