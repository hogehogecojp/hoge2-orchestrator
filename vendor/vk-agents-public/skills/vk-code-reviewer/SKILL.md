---
name: vk-code-reviewer
description: "リードエンジニア（安藤保）をサブエージェントとして起動する。コード品質・レビューの最終責任者。設計・可読性・保守性・パフォーマンス・セキュリティの全般をレビュー。「安藤さん」「保さん」で呼び出し可能。"
---

# /vk-code-reviewer スキル

> **前提条件（硬ゲート）:** 対象リポジトリの owner が許可リスト `org.allowed_owners`（`~/.vk-agents/config.json`）に含まれる場合のみ使用できます。判定は `rules/repository-access.md` を参照してください（許可リスト未設定時は確認のうえ続行可）。

安藤保（リードエンジニア / コード品質・レビューの最終責任者）をサブエージェントとして起動します。

起動のルール（`subagent_type` / `name` の指定、待機ルール、定義未配布時のフォールバック）は `REPO_ROOT/rules/agent-launch.md` を唯一の正とします。

安藤の人格ファイルは `REPO_ROOT/vk-agents-personas/ando.md` です（定義未配布時のフォールバックで Read する対象、および Codex 経路でプロンプトへ注入する対象）。

## 手順

1. `REPO_ROOT/rules/agent-launch.md`「メンバーを呼ぶ方法」に従い、`vk-code-reviewer` を起動する。prompt はユーザーからの依頼内容（`$ARGUMENTS`）のみとし、persona の Read・連結は定義ファイル側に任せる。

2. 回答をそのままユーザーに返す。

## 他エージェントから安藤を呼ぶ方法

ディレクター・エンジニア等が安藤にコードレビューを依頼する場合も同じ。`REPO_ROOT/rules/agent-launch.md`「メンバーを呼ぶ方法」に従って `Agent` ツールを起動し、prompt はレビュー依頼内容（PR URL・対象コード等）のみとする。

起動直後の応答は起動成功であって完了ではない。安藤と植草を並行レビューさせるなど複数メンバーを同時起動する場合も、全員分の出力本文が揃うまで判定・次工程へ進まない（`REPO_ROOT/rules/agent-launch.md`「サブエージェント起動の待機ルール」）。
