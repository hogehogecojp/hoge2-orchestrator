# tmux モード設計

- 日付: 2026-07-14
- 対象: vk-orchestrator に「tmux を実行面にするモード」を追加する
- 状態: 設計合意済み（実装計画はこの後）

## 背景・目的

vk-orchestrator は GitHub issues をキューに、実行面（ペイン群）で Claude を
自動実行させるオーケストレーターである。現状の実行面は **VK Terminals**（Electron/GUI アプリ）
1択で、`src/terminals/index.js` から HTTP API（既定 `127.0.0.1:13847`）で駆動している。

Electron/GUI は**コンテナ内で動かすのが難しい**（画面が必要 → Xvfb + VNC が要る）。
一方でやりたいことは「**Claude をコンテナ内に隔離して動かし、各セッションに `tmux attach` で
入って会話する**」であり、これは tmux がそのまま満たす。

そこで **既存の VK Terminals モードはそのまま残し**、実行面を tmux に差し替える
**tmux モード**を追加する。

### ゴール

- 実行面として tmux を選べる（設定でモード切替）。
- tmux モードでは Electron を一切起動せず、コンテナ内で完結する。
- 各 Claude セッションは `tmux attach`（コンテナなら `docker exec -it … tmux attach`）で
  覗いて操作できる。
- **オーケストレーターの既存挙動・VK Terminals モードは不変**（互換性維持）。

### 非ゴール（YAGNI）

- Claude の承認プロンプト（y/n）を端末から検知する仕組みは作らない。
  現状のオーケストレーターも端末からは検知しておらず（後述）、tmux でも作らない。
- tmux モード用の新しい GUI／ビューアは作らない（tmux 標準の attach で足りる）。
- VNC / noVNC / Xvfb は一切使わない。

## 現状アーキテクチャの要点（設計の前提）

### 実行面との結合は 1 ファイルに集約

オーケストレーターが実行面に要求することは、すべて `src/terminals/index.js` 経由。
`src/engine/index.js` が実際に使う関数は以下：

```
checkHealth, createNewPane, getStates, postMenu, setExternalWaiting,
setOwnPaneTitle, setTerminalPrUrl, setTerminalTitle, submitToClaude,
waitForClaudeReady
```

このうち **`submitToClaude` / `waitForClaudeReady` / `findIdleTerminal` /
`setTerminalPrUrl`** などは、より低位の 3 プリミティブ
（**`getStates` / `sendToTerminal` / `createNewPane`**）の上に組まれた
**バックエンド非依存のロジック**である。つまり相手が VK Terminals でも tmux でも
同じコードが使える。

### 進捗判断は GitHub 経由。端末は「見張り」だけ

重要な前提として、**オーケストレーターは端末の内容を読んで進捗や完了を判断していない**：

- **入力待ちか** … 端末ではなく GitHub issue のマーカーで判断（Claude 自身が issue に
  マーカーを付け、`scanWaitingMarkers` が `setExternalWaiting` でペイン表示へ反映するだけ）。
  `term.waiting` はオーケストレーターが自分でセットし、`findIdleTerminal` が
  「busy なペインを避ける」ために読み戻す**往復ストア**であり、端末解析ではない。
- **完了したか** … GitHub の PR 作成・マージで判断。
- **端末を見る唯一の用途はウォッチドッグ（安全網）**：`scanWatchdog` が
  `lastOutputTime`（最終出力時刻）でペインのクラッシュ／長時間無反応だけを検知する
  （消失→自動再開、長時間無言→PR 無ければ failed）。承認待ちで止まっているのか
  死んだのかは区別しない。

→ 結論：**tmux モードでも承認検知は不要**。今の挙動をそのまま引き継げばよい。
- bypass permissions で動かす人 → そもそも止まらない。
- bypass しない人 → VK Terminals モードと同一挙動（GitHub マーカー＋ウォッチドッグ）。

## 設計

### 全体の形：共通ロジック層 ＋ バックエンド層

`src/terminals/index.js` を 2 層に分割する。

1. **共通ロジック層（バックエンド非依存・変更しない）**
   - `submitToClaude`（本文エコー確認・再送、Enter 確定確認）
   - `waitForClaudeReady`（出力静止による起動待ち）
   - `findIdleTerminal`, `getTerminalBaseline`, `confirmOutputProgressed`,
     `waitForHealth`, `setOwnPaneTitle` / `buildPaneTitleSequence`
   - これらは下記バックエンドインターフェースのプリミティブだけを呼ぶように保つ。

2. **バックエンド層（差し替え可能）** — 実際に実行面を叩く部分。以下のインターフェースを
   2 実装で満たす。

   | メソッド | 意味 | 戻り |
   |---|---|---|
   | `health()` | 実行面が生きているか | `boolean` |
   | `getStates()` | 全端末状態 | `{ terminals: { <id>: { termId, waiting, lastOutputTime, lastLines, apiTitle?, apiUrl? } } }` |
   | `createNewPane(cwd, {noClaude, stashed})` | 端末作成 | `termId` |
   | `sendToTerminal(termId, input)` | 生入力送信 | 送信結果 |
   | `setTerminalTitle(termId, title, url?)` | 見出し（飾り） | — |
   | `setTerminalPrUrl(termId, prUrl, {prMerged})` | PR ボタン（飾り） | — |
   | `setExternalWaiting(termId, waiting)` | 入力待ちマーカー（往復ストア） | — |
   | `postMenu(section)` | サイドバーメニュー（飾り） | — |

   - **backend = `vk-terminals`（既定）**：現行の HTTP 実装をそのまま移設。挙動不変。
   - **backend = `tmux`（新規）**：下記のとおり tmux コマンドへ写像。

### tmux バックエンドの写像

対象 tmux セッション名（例 `vk-orch`）配下の **1 window = 1 Claude セッション**とする。

| インターフェース | tmux 実装 |
|---|---|
| `health()` | `tmux has-session -t <session>` が成功するか（無ければ起動時に作成） |
| `createNewPane(cwd, {noClaude})` | `tmux new-window -t <session> -c <cwd> -P -F '#{window_id}'` で window を作り、`noClaude` でなければその window で Claude 起動コマンドを実行。返った `window_id`（例 `@3`）を termId にする |
| `sendToTerminal(termId, input)` | 本文は `tmux send-keys -t <termId> -l -- <input>`（リテラル送信）。`\r` は `tmux send-keys -t <termId> Enter`。`\x01\x0b`(Ctrl-A/Ctrl-K) はリテラルに送れば効く |
| `getStates()` | 各 window について：`capture-pane -p -t <id> -S -<N>` の末尾を `lastLines`、`#{window_activity}`（最終活動 epoch 秒→ms）を `lastOutputTime`、`waiting` は `setExternalWaiting` で保持している値。窓が消えていれば terminals から除外（ウォッチドッグの消失検知に乗る） |
| `setExternalWaiting(termId, waiting)` | プロセス内 Map に保持し `getStates` で返すだけ（VK Terminals と同じ往復ストア） |
| `setTerminalTitle` / `setTerminalPrUrl` / `postMenu` | 飾り。`setTerminalTitle` は任意で `tmux rename-window`、その他は no-op |

補足:
- `lastOutputTime` の粒度は `window_activity`（秒）で足りる（ウォッチドッグは分単位判定、
  `submitToClaude` の進捗確認は `lastLines` の変化と AND 判定のため秒粒度で問題ない）。
- Claude 起動コマンド（bypass の有無を含む）は **設定から与える**。無人運用は bypass、
  有人運用は通常起動を選べるようにし、bypass をコードに埋め込まない。

### 起動フロー（bin/ 側）

`bin/vk-orchestrator.js` の `up` は現状 Electron(VK Terminals) を spawn してから
オーケストレーターループを起動する。tmux モードでは：

- **Electron を spawn しない**（GUI 起動分岐を mode で切替）。
- 対象 tmux セッションが無ければ作成（`tmux new-session -d -s <session>`）。
- ヘルスは tmux セッション存在で判定し、ループを開始。
- `start`（GUI を起動せず既存実行面へ接続）は tmux モードでも自然に機能する。

### 設定

- `terminals.mode`: `'vk-terminals'`（既定）| `'tmux'`。env でも上書き可
  （例 `VK_TERMINALS_MODE` 等、既存 env 命名に合わせる）。
- tmux モード用に最低限：
  - `tmux.session`（既定 `vk-orch`）
  - Claude 起動コマンド（bypass 有無を含む起動コマンド文字列）
- VK Terminals モードの既存設定キーは変更しない。

## 挙動互換性

- VK Terminals モードは**コード経路・設定・挙動すべて不変**。
- tmux モードでも、進捗判断（GitHub 経由）・ウォッチドッグ・入力待ちマーカーの
  往復は同一に振る舞う。
- 差が出るのは「実行面が GUI か tmux か」と「飾り系 API が no-op になる」点のみ。

## テスト方針

- **バックエンド境界のユニットテスト**：tmux バックエンドの各メソッドが、期待どおりの
  tmux コマンド文字列を組み立てるか（`tmux` 実行はスタブ/インジェクトして検証）。
  特に `getStates` の `capture-pane` / `window_activity` パース、`sendToTerminal` の
  `\r`→Enter 変換、`createNewPane` の window_id 取得。
- **共通ロジック層の非回帰**：`submitToClaude` / `waitForClaudeReady` は
  バックエンドをモックに差し替え、既存テストがそのまま通ることを確認。
- 既存の VK Terminals 向けテスト（node --test tests/*.test.js）は不変で全パス維持。
- tmux 実体を使う軽い結合確認は任意（CI では tmux をスタブ）。

## 未決事項 / リスク

- `capture-pane` の取得行数 `N`：VK Terminals の `lastLines` 相当に合わせて決める
  （エコー確認が効く十分な行数。実装時に既存 `lastLines` の実長を確認して合わせる）。
- Claude 起動コマンドの設定形式（単一文字列か配列か）と、bypass の明示方法は実装計画で確定。
- `window_activity` を持たない極端に古い tmux への配慮は不要（要件は新しめの tmux 前提）。
