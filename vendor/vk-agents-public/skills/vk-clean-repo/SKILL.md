---
name: vk-clean-repo
description: "マージ済みブランチと不要な git worktree を一括削除してリポジトリを整理する"
---

# /vk-clean-repo スキル

作業が完了したマージ済みブランチや、不要になった git worktree を検出・削除してリポジトリをクリーンな状態に戻す。

## トリガー

以下の表現でこのスキルを使う:
- 「ブランチを掃除して」
- 「worktree を削除して」
- 「リポジトリを整理して」
- 「マージ済みブランチを削除して」
- 「クリーンアップして」

## 引数

- `$ARGUMENTS` にリポジトリパスが指定された場合は、そのリポジトリで実行する
- 引数なしの場合は、カレントディレクトリのリポジトリで実行する

## 手順

### 1. 対象リポジトリの確認

1. 対象リポジトリへ移動する（引数があればそのパス、なければカレントディレクトリ）
2. `git rev-parse --show-toplevel` でリポジトリルートを確認する
3. メインブランチ名を特定する（`refs/remotes/origin/HEAD` を優先して解決）
   ```bash
   git symbolic-ref --short refs/remotes/origin/HEAD | sed 's@^origin/@@'
   ```
   取得できない場合のみ `main` / `master` をフォールバックする

### 2. リモートの最新化

```bash
git fetch --prune
```

リモートで削除済みのトラッキングブランチも整理される。

### 3. 不要な worktree の検出と分類

1. `git worktree list` で全 worktree を一覧取得する
2. worktree が存在しない場合はこのステップをスキップする
3. 各 worktree で以下を確認する:
   - メインの worktree（リポジトリルート）はスキップする
   - 現在の作業ディレクトリと一致する worktree はスキップする
   - worktree 内の未コミット変更を確認する（`git -C <worktree_path> status --porcelain`）
   - worktree のブランチが **マージ済みか** を以下のいずれかで判定する:
     - **通常マージ**: `git branch --merged <main_branch>` の出力に含まれる
     - **squash / rebase merge**: `gh pr list --search "head:<branch_name> is:merged" --limit 1 --json number,mergedAt --jq 'length'` が `1` を返す（PR API で merged 確認できれば実質マージ済み）
4. 検出した worktree を以下に分類する:
   - **安全に削除可能**: 未コミット変更なし、かつブランチが上記いずれかの方法でマージ済みと判定された
   - **要確認**: 未コミット変更あり、または **通常マージ判定にも PR API のマージ判定にもヒットしない**（= 真の未マージ）ブランチを持つ worktree

### 4. 安全な worktree とマージ済みブランチの無確認削除

以下は **ユーザー確認なし** で削除する（マージ済み・未コミット変更なしに限る）:

1. ステップ 3 で「安全に削除可能」に分類した worktree を削除する:
   - 削除前に worktree ルート直下の `.wp-env.override.json` を確認する。存在する場合は wp-env 起動の可能性があるため、worktree ディレクトリで wp-env destroy を実行する:
     ```bash
     if [ -f "<worktree_path>/.wp-env.override.json" ]; then
       (cd "<worktree_path>" && yes | npx wp-env destroy) || true
     fi
     ```
     - `yes` パイプで対話確認をスキップする
     - wp-env が未起動または destroy 済みでエラーになっても、`|| true` で握りつぶして次へ進む
     - `.wp-env.override.json` がない worktree は本体 wp-env と Docker プロジェクト名が衝突しうるため触らない
   - その後 worktree とブランチを削除する:
     ```bash
     git worktree remove <worktree_path>
     # 通常マージ判定で安全と確認したものは -d、PR API のマージ判定（squash / rebase）の場合は -D を使う
     # （PR API でマージ済みが確証済みのため -D でも安全）
     git branch -d <branch_name>   # 通常マージ判定の場合
     git branch -D <branch_name>   # squash / rebase merge を PR API で確認した場合
     ```
   - `git worktree remove` が `locked` で失敗した場合は `git worktree unlock <worktree_path>` で解錠して再試行する
2. マージ済みローカルブランチを削除する:
   - **通常マージ済み**: `git branch --merged <main_branch>` の出力から、メインブランチ自身・現在チェックアウト中のブランチ・残存 worktree のブランチを除外したものを `git branch -d <branch_name>` で削除
   - **squash / rebase merge 済み**: `git branch` で全ローカルブランチを取得し、通常マージ済みブランチ・メインブランチ・現在チェックアウト中のブランチ・残存 worktree のブランチを除外したものについて、以下で PR が merged 状態か確認する:
     ```bash
     gh pr list --search "head:<branch_name> is:merged" --limit 1 --json number,mergedAt --jq 'length'
     ```
     - 戻り値が `1` ならその PR は merged 確定。ローカルブランチを `git branch -D <branch_name>` で削除する（PR API で merged 確証済みのため `-D` でも安全）
     - 戻り値が `0` なら真の未マージ。ステップ 5 の「要確認」へ回す
   - **除外**: メインブランチ自身、現在チェックアウト中のブランチ、残存 worktree のブランチ

### 5. 要確認項目の処理

ステップ 3 で「要確認」に分類した worktree、または未マージのローカルブランチが残る場合のみ、ユーザーに確認する:

1. 要確認項目を表示する（パス・ブランチ名・未コミット変更の有無・未マージの旨）
2. ユーザーに削除可否を確認する
3. 承認された場合、強制削除前に `.wp-env.override.json` があれば wp-env destroy を実行する（ステップ 4 と同じ要領）:
   ```bash
   if [ -f "<worktree_path>/.wp-env.override.json" ]; then
     (cd "<worktree_path>" && yes | npx wp-env destroy) || true
   fi
   git worktree remove <worktree_path> --force
   git branch -D <branch_name>
   ```

要確認項目が無い場合はこのステップ全体をスキップする（ユーザーへの確認は不要）。

### 6. 結果の報告

削除した worktree とブランチ、確認待ちで残した項目（あれば）を表示し、完了を報告する。

## 注意事項

- **メインブランチと現在のブランチは絶対に削除しない**
- マージ済みかつ未コミット変更なしのものは安全とみなし、ユーザー確認なしで削除する
- **squash / rebase merge も「マージ済み」として扱う**。`git branch --merged` では検出できないため、必ず `gh pr list --search "head:<branch> is:merged"` でフォールバック判定すること。PR API で merged 確認できたブランチは `git branch -D` で削除してよい（既に merge が確証済みのため）
- 未コミット変更のある worktree、および通常マージ判定にも PR API 判定にもヒットしない（= 真の未マージ）ブランチは必ずユーザー確認を取る
- `.wp-env.override.json` を持つ worktree は `git worktree remove` の前に `wp-env destroy` を実行し、Docker コンテナとボリュームを片付ける（override がない worktree は本体 wp-env と Docker プロジェクト名が一致するため触らない）
