---
name: vk-wp-developer
description: "WordPressエンジニア（和田）をサブエージェントとして起動する。テーマ・プラグイン・ブロック開発全般を担当。ディレクター・プランナーからの指示受け、植草（UX）との連携も行う。"
---

# /vk-wp-developer スキル

和田（WordPressエンジニア）をサブエージェントとして起動します。

起動のルール（エンジン解決の優先順位、`subagent_type` / `name` の指定、待機ルール、定義未配布時のフォールバック、「Codex は単独作業のみ」の原則）は `REPO_ROOT/rules/agent-launch.md` を唯一の正とします。`codex exec` の共通手順は `REPO_ROOT/skills/_shared/codex-launch.md` を唯一の正とします。

和田の人格ファイルは `REPO_ROOT/agents/personas/wada.md` です（定義未配布時のフォールバックで Read する対象、および Codex 経路でプロンプトへ注入する対象）。

## 手順

1. `REPO_ROOT/rules/agent-launch.md`「起動エンジンの解決」に従ってエンジンを解決する（設定キーは `agents.engine.vk-wp-developer`）。

2. 解決したエンジンで和田を起動する。
   - `claude` の場合 → 下記「エンジン `claude` の場合」
   - `codex` の場合 → 下記「エンジン `codex` の場合」

3. 回答をそのままユーザーに返す。

## エンジン `claude` の場合（Agent tool）

`REPO_ROOT/rules/agent-launch.md`「メンバーを呼ぶ方法」に従い、`subagent_type` / `name` に `vk-wp-developer` を指定して起動する。prompt は依頼内容のみ（persona の Read・連結は定義ファイル側が行う）。加えて和田固有の指定:

- **単独起動では** `run_in_background: false` を指定する。実装完了報告の出力本文を受け取るまで次工程へ進まない。
- 複数の依頼を並列で処理する場合は 1 メッセージで複数呼び出し、既定のバックグラウンド実行で並列起動する。並列時の `name` の一意化は `REPO_ROOT/rules/agent-launch.md`「name の付け方」に従う。全員分の実装完了報告の出力本文が揃うまで次工程へ進まない。
- gh・git の確認プロンプトをスキップする必要がある文脈（`vk-kore` 等）では `mode: "bypassPermissions"` を指定する。

## エンジン `codex` の場合（`codex exec`）

手順は `REPO_ROOT/skills/_shared/codex-launch.md` に従う。和田固有の差分は以下。

### ① worktree の要否

**必要。** 和田は実装してローカルコミットするため、起動側（司）が先に `git worktree add` で worktree を作成し、その絶対パスを `-C` に渡す。

### ② 責務境界（Codex 用オーバーライドに明記する）

> あなたは Codex 実行のため `SendMessage`（メンバー連携）と `Skill`（`/vk-pr` 等）が使えません。植草連携・push・PR 作成（`/vk-pr`）・CodeRabbit 対応は司が担うため行いません。責務は **実装とローカルコミットまで** です。

### ③ 注入するルール

`REPO_ROOT/agents/personas/wada.md` の「作業開始時に読み込むファイル」表がリストするルール（`rules/coding-rules.md`・`rules/common.md`・`rules/architecture-design.md`・`rules/block-deprecation.md`・`rules/design-rules.md`・`rules/css.md`・`rules/changelog.md`・`rules/testing/phpunit.md`・`rules/testing/e2e.md`）を REPO_ROOT 起点の絶対パスへ読み替えて注入する。

### ④ 出力スキーマ

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["status", "branch", "summary", "changed_files", "error"],
  "properties": {
    "status":        { "type": "string", "enum": ["committed", "stuck"] },
    "branch":        { "type": "string" },
    "summary":       { "type": "string" },
    "changed_files": { "type": "array", "items": { "type": "string" } },
    "error":         { "type": "string" }
  }
}
```

コミットできたら `status=committed`、詰まったら `status=stuck` とし `error` に理由を書く。Codex 未認証で失敗した場合も `stuck` 扱いとする。

### ⑤ 完了後の扱い

司が JSON から `status` / `branch` / `summary` / `changed_files` / `error` を取り出す。以降の push・`/vk-pr`・CodeRabbit 監視は司が引き取る。

## 他エージェントから和田を呼ぶ方法

ディレクター・プランナー等が和田に実装を依頼する場合も、本スキルの手順1でエンジンを解決したうえで、上記「エンジン `claude` の場合」／「エンジン `codex` の場合」に従う。植草連携が要る依頼・和田自身に `/vk-pr` を実行させる依頼では、設定が `codex` でも `claude` にフォールバックする（`REPO_ROOT/rules/agent-launch.md`「Codex は単独作業のみ」）。
