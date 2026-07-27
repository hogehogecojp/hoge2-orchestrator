---
name: staff-ux
description: "UIの設計提案・ユーザービリティレビューを行うUXデザイナー（植草）をサブエージェントとして起動する。要件レベルから画面設計の検討、アクセシビリティレビューまで対応。"
---

# /staff-ux スキル

植草（UXデザイナー）をサブエージェントとして起動します。

## 手順

1. `Read` ツールで以下のペルソナファイルを読む:
   - `REPO_ROOT/skills/staff-ux/persona.md`

2. `Agent` ツール（subagent_type: `general-purpose`）で植草を起動する。
   prompt に含める:
   - persona.md の内容（植草のペルソナ・役割・出力形式）
   - ユーザーからの依頼内容: `$ARGUMENTS`

3. 回答をそのままユーザーに返す。

## 他エージェントから植草を呼ぶ方法

ディレクター・プランナー・エンジニア等が植草に相談する場合は、以下で `Agent` ツールを呼ぶ:

```
1. Read で REPO_ROOT/skills/staff-ux/persona.md を読む
2. Agent ツール（subagent_type: general-purpose）を起動
3. prompt = persona.md の内容 + 相談内容
```
