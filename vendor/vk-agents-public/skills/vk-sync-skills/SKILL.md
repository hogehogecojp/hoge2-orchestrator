---
name: vk-sync-skills
description: "vk-agents のコーディングルール・スキルを指定プロジェクトやグローバル設定（~/.claude）に展開・更新する。『〇〇に展開して』『スキルをアップデートして』等の依頼時に使用"
---

# agent-skills 展開スキル

vk-agents のルールを指定プロジェクトに展開する。

## トリガー

以下の表現でこのスキルを使う:
- 「コーディングスキルを〇〇に展開して」
- 「スキルのコーディングを〇〇に展開して」
- 「agent-skills を〇〇に展開して」
- 「エージェントスキルを〇〇に展開して」
- 「コーディングルールを〇〇に展開して」
- 「スキルをアップデートして」
- 「コーディングスキルをアップデートして」
- 「プラグインリリーススキルをアップデートして」

単に「〇〇に展開して」だけならこのスキルを使わない。

## 設定ファイル

ターゲット一覧: `REPO_ROOT/config/targets.json`（git 管理外。テンプレートは `REPO_ROOT/config/targets.json.example`）

環境別設定: `~/.vk-agents/config.json`（正本。`VK_AGENTS_CONFIG` で絶対パスを上書き可。テンプレートは `REPO_ROOT/config.json.example`）
- 環境ごとに変えたいスキル設定をまとめるファイル。スキルはこの正本を直接読む。テンプレ `config.json.example` は自動展開されない雛形（`mkdir -p ~/.vk-agents && cp REPO_ROOT/config.json.example ~/.vk-agents/config.json` で有効化）。リポ直下の旧 `config.json` は、正本が無い初回だけ正本へコピー移行され、以後は読まれない。
- 移行窓の間、`--claude-global` は配布済み旧スキルコピー互換のため、非推奨ミラー `~/.claude/vk-agents-settings.json` を書き続ける。次リリースで撤去予定（issue #235）。
- 現在のキー:
  - `multi_repo_task.default_engine`（`claude` / `codex` = マルチリポジトリタスクの既定実行エンジン。ファイル不在・キー未設定時のフォールバックは `claude`）
  - `staff_wp_dev.engine`（`claude` / `codex` = 和田（staff-wp-dev）の起動エンジン。ファイル不在・キー未設定時のフォールバックは `claude`。Codex は単独作業のみ対応。詳細は `skills/staff-wp-dev/SKILL.md`「起動方法」参照）
  - `features.coderabbit`（`true` / `false` = CodeRabbit 連携の有効/無効。ファイル不在・キー未設定時・JSON パース失敗時のフォールバックは `true`。詳細は `rules/coderabbit-monitoring.md`「前提条件」参照）
  - `features.coderabbit_ignore`（`true` / `false` = CodeRabbit 導入環境で PR 本文に `@coderabbitai ignore` を記載して監視をスキップするか。ファイル不在・キー未設定時・JSON パース失敗時のフォールバックは `false`。詳細は `rules/coderabbit-monitoring.md`「前提条件」参照）
  - 設定変更時は `~/.claude` を直接編集せず、正本 `~/.vk-agents/config.json` を編集する。

sync スクリプト: `REPO_ROOT/scripts/sync.sh`

## 展開手順

1. `REPO_ROOT/config/targets.json` を Read ツールで読む
   - **存在しない場合**: 処理を中断し、テンプレートをコピーして自分の環境に合わせて編集するようユーザーに案内する
     ```bash
     cp REPO_ROOT/config/targets.json.example REPO_ROOT/config/targets.json
     ```
     コピー後、各パスをユーザーのローカル環境に合わせて編集してもらい、再実行する
2. ユーザーが指定したプロジェクト名（日本語可）をキーに対応パスを取得する
3. パスの `~` を実際のホームディレクトリに展開する
4. 以下のコマンドを実行する:
   ```
   bash REPO_ROOT/scripts/sync.sh --target <展開先パス>
   ```
5. 完了を報告する

## スキルアップデート手順

以下を順に実行し、2つのリポジトリを最新化してグローバル設定に反映する:

### 1. コーディングスキル（vk-agents）をアップデート

```bash
git -C REPO_ROOT/ pull
git -C REPO_ROOT/ submodule update --init --recursive
```

`vendor/` は git submodule 管理で、`submodule.recurse` が未設定のため `git pull` 単体では vendor/ が古いまま残る。`git submodule update --init --recursive` で submodule を superproject が記録する参照（コミット済みの SHA）へ同期する。`--remote` は付けないこと（上流の最新へ bump するのは保守者の別作業で、各メンバーが実行すると未コミットの drift が生じる）。

### 2. グローバル設定に反映

```bash
bash REPO_ROOT/scripts/sync.sh --claude-global
```

## 新しいターゲットの登録

「〇〇を登録して」と言われた場合は `config/targets.json` に追記する。`config/targets.json` は git 管理外のため、追記内容はそのメンバーのローカル環境にのみ反映される。

## 失敗時の対応

`scripts/sync.sh` で問題が起きた場合は、勝手に手動コピー等の代替手段を取らず以下を確認し、解決できなければユーザーにエスカレーションする。

- **sync.sh が存在しない**: リポジトリが最新かを `git -C REPO_ROOT pull` で確認するよう案内する（古いチェックアウトでファイルが無い可能性）。pull 後も無ければパスとリポジトリ状態を添えて報告する。
- **実行権限エラー**（Permission denied など）: `bash REPO_ROOT/scripts/sync.sh ...` のように bash 経由で実行するよう案内する。
- **スクリプトが非ゼロ終了した**: 出力（標準出力・標準エラー）を添えてユーザーにエスカレーションする。失敗を握りつぶして手動でファイルをコピーするなどの代替手段は取らない。

## 使用例

- 「Lightning に展開して」→ Lightning のパスに sync.sh を実行
- 「VK Blocks Pro に展開して」→ vk-blocks-pro のパスに sync.sh を実行
- 「全部に展開して」→ targets.json の全パスにそれぞれ実行
- 「スキルをアップデートして」→ スキルアップデート手順を実行
