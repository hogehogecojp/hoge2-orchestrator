---
name: vk-ux-designer
description: "UIの設計提案・ユーザービリティレビューを行うUXデザイナー（植草）をサブエージェントとして起動する。要件レベルから画面設計の検討、アクセシビリティレビューまで対応。"
---

# /vk-ux-designer スキル

植草（UXデザイナー）をサブエージェントとして起動します。

起動のルール（`subagent_type` / `name` の指定、待機ルール、定義未配布時のフォールバック）は `REPO_ROOT/rules/agent-launch.md` を唯一の正とします。植草は**実装前**の画面設計・ユーザビリティ・アクセシビリティを担当し、**実装後**のブラウザ動作確認・UI 照合は麗美（`vk-ui-tester`）の担当です（`REPO_ROOT/rules/agent-launch.md`「植草と麗美の境界」）。

植草の人格ファイルは `REPO_ROOT/agents/personas/uekusa.md` です（定義未配布時のフォールバックで Read する対象、および Codex 経路でプロンプトへ注入する対象）。

## 手順

1. `REPO_ROOT/rules/agent-launch.md`「メンバーを呼ぶ方法」に従い、`vk-ux-designer` を起動する。prompt はユーザーからの依頼内容（`$ARGUMENTS`）のみとし、persona の Read・連結は定義ファイル側に任せる。

2. 回答をそのままユーザーに返す。

## 他エージェントから植草を呼ぶ方法

ディレクター・プランナー・エンジニア等が植草に相談する場合も同じ。`REPO_ROOT/rules/agent-launch.md`「メンバーを呼ぶ方法」に従って `Agent` ツールを起動し、prompt は相談内容のみとする。

起動直後の応答は起動成功であって完了ではない。安藤と植草を並行レビューさせるなど複数メンバーを同時起動する場合も、全員分の出力本文が揃うまで判定・次工程へ進まない（`REPO_ROOT/rules/agent-launch.md`「サブエージェント起動の待機ルール」）。
