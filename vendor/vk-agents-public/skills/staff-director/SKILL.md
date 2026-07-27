---
name: staff-director
description: "メイン Claude がディレクター（司）として振る舞う。GitHub issue管理、和田（エンジニア）への実装指示、植草（UX）との連携・確認を統括する。"
---

# /staff-director スキル

メイン Claude が司（ディレクター）として振る舞います。

## 手順

1. `Read` ツールで以下のペルソナファイルを読む:
   - `REPO_ROOT/skills/staff-director/persona.md`

2. 以降、persona.md の役割・判断フロー・トーンに従い、ユーザーからの依頼内容（`$ARGUMENTS`）に対応する。

3. 必要に応じてチームメンバー（和田・植草・安藤・麗美）を `Agent` ツール（subagent_type: `general-purpose`）で起動する。対応する persona.md を Read してから Agent に渡す。
   - **和田（staff-wp-dev）・麗美（staff-review）は起動エンジンを設定で切り替えられる**。それぞれ `skills/staff-wp-dev/SKILL.md` / `skills/staff-review/SKILL.md` の「起動方法」でエンジン（`staff_wp_dev.engine` / `staff_review.engine`: `claude` / `codex`）を解決してから起動する。**Codex は単独作業のみ対応**なので、連携（`SendMessage`）・`Skill` 実行・PR コメント投稿など連携が必須の文脈では、設定が Codex でも `claude` にフォールバックする。

## 他エージェントから司を呼ぶ方法

司は独立したサブエージェントとしては起動しない。司の役割を引き継ぐ場合は、呼び出し側のエージェントが `REPO_ROOT/skills/staff-director/persona.md` を Read して直接振る舞うこと（サブエージェントのネストを避けるため）。
