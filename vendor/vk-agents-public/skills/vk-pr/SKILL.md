---
name: vk-pr
description: "PR ルールに従い、コミット・changelog 記載・確認手順を含む PR を作成する。PR 作成を依頼されたときに使用"
---

# /vk-pr スキル

このスキルは `rules/pull-request.md` の PR ルールに従い、**PR 作成まで** を担う。

## 責務範囲

- **このスキルの責務**: PR 作成前の確認 → changelog 記載 → PR 作成
- **このスキルの責務外**: CodeRabbit 監視・指摘トリアージ・CI 起動・GitHub Actions 監視
  - これらは **呼び出し元エージェント（通常は司 = `/vk-kore`）の責務**（`rules/coderabbit-monitoring.md` 参照）
  - サブエージェントが長時間ループを抱えると指摘を見落としやすいため、PR 作成後は監視を司に引き渡す
  - `rules/coderabbit-monitoring.md`「前提条件」でスキップ判定になる環境では呼び出し元も監視しない。この場合、ハンドオフ文言は、CodeRabbit 未導入なら「CodeRabbit 連携は無効化されています。Claude Code の `/code-review` 等でのレビューをご検討ください」、ignore 指定なら「PR 本文に `@coderabbitai ignore` を記載済みのため、CodeRabbit 監視はスキップ対象です」に読み替える

単発で `/vk-pr` だけ呼ばれた場合（司を経由しない場合）は、PR 作成完了後に「PR を作成しました。CodeRabbit 監視は別途必要な場合にお伝えください」と案内して終了する。`rules/coderabbit-monitoring.md`「前提条件」でスキップ判定になる場合は、CodeRabbit 未導入なら「CodeRabbit 連携は無効化されています。必要であれば `/code-review` 等でのレビューをご検討ください」、ignore 指定なら「PR 本文に `@coderabbitai ignore` を記載済みのため、CodeRabbit 監視はスキップ対象です」と案内する。

## 手順

### 1. ルールファイルの読み込み

まず `Read` ツールで以下のルールファイルを読む:

- `rules/pull-request.md`（PR 作成の全ルール）
- `rules/changelog.md`
- `rules/change-title.md`

### 2. コンテキストの取得

以下のコマンドで現在の状態を把握する:

- 現在のブランチ: `git branch --show-current`
- 差分コミット: `git log main...HEAD --oneline 2>/dev/null || git log origin/main...HEAD --oneline 2>/dev/null || git log master...HEAD --oneline 2>/dev/null || git log origin/master...HEAD --oneline 2>/dev/null || true`
- 変更ファイル: `git diff main...HEAD --name-only 2>/dev/null || git diff origin/main...HEAD --name-only 2>/dev/null || git diff master...HEAD --name-only 2>/dev/null || git diff origin/master...HEAD --name-only 2>/dev/null || true`

### 3. PR 作成

`rules/pull-request.md` に従って以下を実行する:

1. **PR 作成前の確認**（コーディングルール・デザインルール・PHPUnit）
2. **changelog の確認と記載**（記載後・commit 前に `rules/pull-request.md` の「### 4. 記載内容のセルフチェック・自動補正（commit 前）」を必ず実行し、2行以内ルール等への違反があればその場で短縮する）
3. **PR の作成**（タイトル形式・確認手順・スクリーンショット・元 issue のクローズ参照 `Closes #N` を含む。元 issue 参照は `rules/pull-request.md` 参照）

### 4. PR タイトルのセルフチェック・自動補正

PR 作成後、ハンドオフ前に必ず以下を実行し、タイトルが `rules/change-title.md` のルールに沿っているか確認する。違反があれば `gh pr edit` で修正する。`gh pr create` の引数で渡したタイトルが、変換や省略でルール違反になるケースを拾う。

1. 作成された PR のタイトルを取得する:

   ```bash
   gh pr view <PR_NUMBER> --json title --jq '.title'
   ```

2. `rules/change-title.md` を **改めて Read で読み込み**、取得したタイトルが分類の許可リスト・分類表記・記載言語・本文ルールに沿っているか照合する。**判定基準はルールファイルを唯一の正としてここでは複製しないこと**（このファイルにルールを直書きすると二元管理になり、ルール更新が反映されなくなるため）。

3. ルール違反と判定した場合は、該当ルールファイルに従ってタイトル全体を書き直し、`gh pr edit <PR_NUMBER> --title "<新タイトル>"` で修正する。

4. 修正した場合、ハンドオフ時の報告に **修正前後のタイトル両方** を含めて呼び出し元（司またはユーザー）に伝える。

`rules/change-title.md` のルールに沿っていれば、修正不要として次へ進む。

### 4-2. PR 本文の元 issue 参照セルフチェック

PR 作成後、ハンドオフ前に、対応する元 issue が判明している場合（司から渡された・ブランチや文脈から特定できる場合）、PR 本文に元 issue のクローズ参照（`Closes #N` 等のクローズキーワード + issue 番号）が含まれているか照合する。判定基準は `rules/pull-request.md` の「元 issue の参照」を唯一の正とし、ここには詳細を直書きしない。

含まれていなければ `gh pr edit <PR_NUMBER> --body` 等で `Closes #N` の 1 行を追記する。元 issue が特定できない単発利用では、この照合はスキップしてよい。

### 4-3. CodeRabbit ignore 指定のセルフチェック

`rules/coderabbit-monitoring.md` の「前提条件」を参照し、`features.coderabbit` が有効（`false` でない）かつ `features.coderabbit_ignore: true` の場合は、PR 本文に `@coderabbitai ignore` が含まれていることを確認する。含まれていなければ `gh pr edit <PR_NUMBER> --body` 等で追記する。

`features.coderabbit: false` の場合は CodeRabbit 未導入扱いを優先し、`@coderabbitai ignore` は記載しない。判定詳細は `rules/coderabbit-monitoring.md` を唯一の正とし、このスキル側に複製しない。

### 5. ハンドオフ

PR 作成およびタイトル・本文セルフチェック完了後:

- 呼び出し元（司）から呼ばれた場合: **PR URL を司に渡して終了する**。監視開始時刻 `START` の取得は司側の責務（PR の `createdAt` を `gh pr view --json createdAt` で取得する方式）。サブエージェント側で `date -u` を打つと、PR 作成 → CodeRabbit 即応答 → サブエージェント完了通知 → 司が受領 の順序競合で取り逃すため、和田は `START` 取得をしない（責務の詳細は `rules/coderabbit-monitoring.md` 参照）
- 単発で呼ばれた場合: ユーザーに「PR を作成しました。CodeRabbit 監視は別途必要な場合にお伝えください」と伝えて終了する。`rules/coderabbit-monitoring.md`「前提条件」でスキップ判定になる場合は、上記の責務範囲にある読み替え文言で案内する

マージはユーザーが判断するため、自動でマージしないこと。
