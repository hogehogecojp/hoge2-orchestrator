#!/usr/bin/env bash
# agent-skills sync script
#
# 使い方:
#   ./scripts/sync.sh --target /path/to/project             # 指定プロジェクトに展開
#   ./scripts/sync.sh --target /path/to/project --wordpress # WordPress公式スキルも一緒に展開
#   ./scripts/sync.sh --claude-global                       # グローバルClaude設定に追記・更新

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RULES_DIR="$(cd "$SCRIPT_DIR/../rules" && pwd)"
TARGET=""
CLAUDE_GLOBAL=false
WORDPRESS=false
WP_SKILLS_PATH="${HOME}/wordpress-agent-skills"
WP_SKILLS_REPO="https://github.com/WordPress/agent-skills"
# 個人設定 config.json の skills.disabled（無効化するスキルのディレクトリ名）を格納する。
# load_disabled_skills で読み込み、sync_claude_global / sync_to_project の両方から参照する。
DISABLED_SKILLS=()

usage() {
    cat <<'EOF'
使い方: sync.sh [オプション]

オプション:
  --target [PATH]       指定プロジェクトへ各AIツール向けファイルを展開（省略時: カレントディレクトリ）
  --wordpress           WordPress公式スキルも展開（自社ルールが優先）
  --wp-skills PATH      WordPress/agent-skills のクローン先パス
                        （デフォルト: ~/wordpress-agent-skills）
  --claude-global       グローバルClaude設定 (~/.claude/CLAUDE.md) に追記・更新
  -h, --help            このヘルプを表示

使用例:
  ./scripts/sync.sh                                          # カレントディレクトリに展開
  ./scripts/sync.sh --target ~/projects/my-project           # 指定プロジェクトに展開
  ./scripts/sync.sh --target ~/projects/my-project --wordpress
  ./scripts/sync.sh --claude-global

展開先（自社ルール）:
  Claude Code    → {target}/.claude/skills/agent-skills/
  Cursor         → {target}/.cursor/rules/agent-skills/
  GitHub Copilot → {target}/.github/copilot-instructions.md（マーカーセクションを更新）
  Codex          → {target}/.codex/skills/agent-skills/

展開先（--wordpress 指定時）:
  Claude Code    → {target}/.claude/skills/wordpress/
  Cursor         → {target}/.cursor/rules/wordpress/
  Codex          → {target}/.codex/skills/wordpress/
  ※自社ルールは wordpress/ の後に agent-skills/ として展開されるため優先されます
EOF
}

# 引数パース
while [[ $# -gt 0 ]]; do
    case $1 in
        --target)
            if [[ -z "${2:-}" ]] || [[ "${2:-}" == -* ]]; then
                TARGET="$(pwd)"
                shift 1
            else
                TARGET="$2"
                shift 2
            fi
            ;;
        --wordpress)
            WORDPRESS=true
            shift
            ;;
        --wp-skills)
            [[ -z "${2:-}" ]] && { echo "エラー: --wp-skills にパスを指定してください"; exit 1; }
            WP_SKILLS_PATH="$2"
            shift 2
            ;;
        --claude-global)
            CLAUDE_GLOBAL=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "不明なオプション: $1"
            usage
            exit 1
            ;;
    esac
done

if [[ -z "$TARGET" ]] && [[ "$CLAUDE_GLOBAL" == false ]]; then
    TARGET="$(pwd)"
fi

# 個人設定 config.json の正本パス。未指定時は永続領域 ~/.vk-agents/config.json を読む。
VK_AGENTS_CONFIG_PATH="${VK_AGENTS_CONFIG:-$HOME/.vk-agents/config.json}"

# 旧配置（リポ直下・git 管理外）の config.json が残っている初回だけ、新しい正本へコピーする。
# 既に正本がある場合は、GUI 等が書き込んだ値を上書きしないため何もしない。
migrate_config() {
    local legacy_config="$SCRIPT_DIR/../config.json"
    [[ ! -f "$VK_AGENTS_CONFIG_PATH" ]] || return 0
    [[ -f "$legacy_config" ]] || return 0

    mkdir -p "$(dirname "$VK_AGENTS_CONFIG_PATH")"
    cp "$legacy_config" "$VK_AGENTS_CONFIG_PATH"
    echo "正本を $VK_AGENTS_CONFIG_PATH へ移行しました。今後リポ直下 config.json は読まれません。削除して構いません。"
}

# 個人設定 config.json（正本）から skills.disabled を読み込み DISABLED_SKILLS に格納する。
# config.json が無い / skills キーが無い / disabled が無い / JSON が壊れている場合は空リスト扱い
# （＝現行どおり全スキルをインストール）。壊れた JSON で sync 全体を落とさないよう python3 側で
# 例外を握りつぶし、1行1要素で吐かせて bash 配列へ読み込む。
load_disabled_skills() {
    local config="$VK_AGENTS_CONFIG_PATH"
    [[ -f "$config" ]] || return 0
    local line
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        DISABLED_SKILLS+=("$line")
    done < <(python3 - "$config" <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    skills = data.get("skills") if isinstance(data, dict) else None
    disabled = skills.get("disabled") if isinstance(skills, dict) else None
    if isinstance(disabled, list):
        for s in disabled:
            if isinstance(s, str) and s:
                print(s)
except Exception:
    pass
PYEOF
)
}

# 指定スキル名が DISABLED_SKILLS に含まれるかを判定する（含まれれば 0）。
# bash 3.2 + set -u で空配列の "${arr[@]}" が unbound になるためガードする。
is_disabled_skill() {
    local name="$1" s
    for s in ${DISABLED_SKILLS[@]+"${DISABLED_SKILLS[@]}"}; do
        [[ "$s" == "$name" ]] && return 0
    done
    return 1
}

# rules/ 以下のファイルをディレクトリ構造を維持してコピー
copy_rules() {
    local dest="$1"
    mkdir -p "$dest"
    while IFS= read -r f; do
        rel="${f#"$RULES_DIR"/}"
        dest_file="$dest/$rel"
        mkdir -p "$(dirname "$dest_file")"
        cp "$f" "$dest_file"
    done < <(find "$RULES_DIR" -name "*.md" | sort)
}

# WordPress公式スキルをプロジェクトに展開
install_wordpress_skills() {
    local target="$1"

    # クローンされていなければ確認して取得
    if [[ ! -d "$WP_SKILLS_PATH" ]]; then
        echo "  WordPressスキルが見つかりません: $WP_SKILLS_PATH"
        echo -n "  クローンしますか？ [y/N]: "
        read -r answer
        if [[ "$answer" =~ ^[Yy]$ ]]; then
            git clone "$WP_SKILLS_REPO" "$WP_SKILLS_PATH"
        else
            echo "  スキップ: WordPressスキルはインストールされませんでした"
            return
        fi
    fi

    local wp_skills_dir="$WP_SKILLS_PATH/skills"
    if [[ ! -d "$wp_skills_dir" ]]; then
        echo "エラー: skills/ ディレクトリが見つかりません: $wp_skills_dir"
        return 1
    fi

    echo "  WordPressスキルを展開中... ($WP_SKILLS_PATH)"

    for tool_dir in \
        "$target/.claude/skills/wordpress" \
        "$target/.cursor/rules/wordpress" \
        "$target/.codex/skills/wordpress"
    do
        mkdir -p "$tool_dir"
        for item in "$wp_skills_dir"/*/; do
            # skills/ が空だと glob が展開されずリテラルのままになるためスキップ
            [[ -d "$item" ]] || continue
            cp -r "$item" "$tool_dir/"
        done
    done

    echo "  → .claude/skills/wordpress/ .cursor/rules/wordpress/ .codex/skills/wordpress/"
}

# プロジェクトへの展開
sync_to_project() {
    local target="$1"

    if [[ ! -d "$target" ]]; then
        echo "エラー: ディレクトリが存在しません: $target"
        exit 1
    fi

    # vendor/ サブモジュールは対象プロジェクトにはコピーされないため、
    # スキル内の vendor/ 参照はソース（vk-agents チェックアウト）の絶対パスへ書き換える
    local escaped_repo_root
    escaped_repo_root=$(printf '%s' "$(cd "$SCRIPT_DIR/.." && pwd)" | sed 's/[\\#&]/\\&/g')

    local start_marker="<!-- agent-skills:start -->"
    local end_marker="<!-- agent-skills:end -->"

    echo "展開先: $target"

    # WordPress公式スキルを先に展開（自社ルールが後から上書きして優先される）
    if [[ "$WORDPRESS" == true ]]; then
        install_wordpress_skills "$target"
    fi

    echo "  → .claude/skills/agent-skills/"
    copy_rules "$target/.claude/skills/agent-skills"

    echo "  → .cursor/rules/agent-skills/"
    copy_rules "$target/.cursor/rules/agent-skills"

    echo "  → .codex/skills/agent-skills/"
    copy_rules "$target/.codex/skills/agent-skills"

    # スキルをプロジェクトに展開（Claude Code のみ）
    # vk-sync-skills は vk-agents リポジトリ固有（config/, scripts/ を参照）のため除外。
    # 個人設定 config.json の skills.disabled も同様に除外する（target 側にはマニフェスト削除機構が無いため
    # 「入れない」だけで要件を満たす）。
    local skills_src="$SCRIPT_DIR/../skills"
    local skip_skills="vk-sync-skills"
    local disabled_skill
    for disabled_skill in ${DISABLED_SKILLS[@]+"${DISABLED_SKILLS[@]}"}; do
        skip_skills="$skip_skills $disabled_skill"
    done
    if [[ -d "$skills_src" ]]; then
        for skill_dir in "$skills_src"/*/; do
            [[ -d "$skill_dir" ]] || continue
            local skill_name
            skill_name="$(basename "$skill_dir")"
            if [[ " $skip_skills " == *" $skill_name "* ]]; then
                continue
            fi
            local dest_dir="$target/.claude/skills/$skill_name"
            mkdir -p "$dest_dir"
            while IFS= read -r -d '' src_file; do
                local rel_path
                rel_path="${src_file#"$skill_dir"}"
                mkdir -p "$(dirname "$dest_dir/$rel_path")"
                if [[ "$src_file" == *.md ]]; then
                    # rules/ と vendor/ は参照の先頭（行頭・非単語かつ非スラッシュ文字の直後）にある
                    # 時だけ置換する。REPO_ROOT/rules/・$VK_AGENTS_DIR/rules/・**/rules/ や myvendor/ の
                    # ように / や単語文字の直後にある同名部分を巻き込むと二重置換・誤置換になるため
                    # 境界でアンカーする。REPO_ROOT/rules/ 等は REPO_ROOT/ 置換でソースチェックアウトの
                    # 絶対パスとして解決する。
                    sed -E -e 's#(^|[^A-Za-z0-9_/])rules/#\1.claude/skills/agent-skills/#g' \
                        -e 's#REPO_ROOT/skills/#.claude/skills/#g' \
                        -e "s#REPO_ROOT/#${escaped_repo_root}/#g" \
                        -e "s#(^|[^A-Za-z0-9_/])vendor/#\1${escaped_repo_root}/vendor/#g" \
                        "$src_file" > "$dest_dir/$rel_path"
                else
                    cp "$src_file" "$dest_dir/$rel_path"
                fi
            done < <(find "$skill_dir" -type f -print0)
            echo "  → .claude/skills/$skill_name/"
        done
    fi

    echo "  → .github/copilot-instructions.md"
    mkdir -p "$target/.github"
    local copilot_md="$target/.github/copilot-instructions.md"

    # マーカー間のコンテンツを生成
    local content=""
    while IFS= read -r f; do
        content+=$'\n---\n\n'
        content+="$(cat "$f")"
        content+=$'\n'
    done < <(find "$RULES_DIR" -name "*.md" | sort)

    if [[ ! -f "$copilot_md" ]]; then
        {
            echo "$start_marker"
            echo "$content"
            echo "$end_marker"
        } > "$copilot_md"
    elif grep -qF "$start_marker" "$copilot_md"; then
        # 既存のマーカーセクションを更新
        local tmp
        tmp=$(mktemp)
        CONTENT="$content" \
        AG_START="$start_marker" \
        AG_END="$end_marker" \
        python3 - "$copilot_md" "$tmp" <<'PYEOF'
import sys, re, os
src, dst = sys.argv[1], sys.argv[2]
content = open(src).read()
body = os.environ['CONTENT']
start = os.environ['AG_START']
end = os.environ['AG_END']
section = start + '\n' + body + '\n' + end
pattern = re.escape(start) + r'.*?' + re.escape(end)
# 置換文字列 section をそのまま渡すと \1 や \d 等がエスケープ解釈され
# re.error になるため、関数置換で本文をリテラルとして差し込む。
result = re.sub(pattern, lambda m: section, content, flags=re.DOTALL)
open(dst, 'w').write(result)
PYEOF
        mv "$tmp" "$copilot_md"
    else
        # ファイルはあるがマーカーがない → 末尾に追記
        {
            echo ""
            echo "$start_marker"
            echo "$content"
            echo "$end_marker"
        } >> "$copilot_md"
    fi

    echo "完了: $target への展開が完了しました"
}

# グローバルClaude設定の更新
sync_claude_global() {
    local claude_md="$HOME/.claude/CLAUDE.md"
    local start_marker="<!-- agent-skills:start -->"
    local end_marker="<!-- agent-skills:end -->"

    echo "グローバルClaude設定を更新: $claude_md"
    mkdir -p "$HOME/.claude"

    # vk-agents のルートディレクトリ（rules/ の親）
    local vk_agents_dir="${RULES_DIR%/rules}"

    # テーブル形式のコンテンツを生成（必要な時に Read で読む方式）
    local content
    content="## コーディングルール

タスク開始前に、以下から関連するファイルを **必ず Read で読み込んでから** 作業してください。

| ファイル | 読むべき場面 |
|---|---|
| ${RULES_DIR}/coding-rules.md | PHP/WPコードを書く時 |
| ${RULES_DIR}/common.md | 設計・方針判断が必要な時 |
| ${RULES_DIR}/design-rules.md | CSS/UI実装をする時 |
| ${RULES_DIR}/css.md | CSS/SCSSファイルを編集する時 |
| ${RULES_DIR}/pull-request.md | PRを作成する時 |
| ${RULES_DIR}/changelog.md | changelog（readme.txt / CHANGELOG.md）を書く時 |
| ${RULES_DIR}/testing/phpunit.md | PHPUnitテストを書く時 |
| ${RULES_DIR}/testing/e2e.md | E2Eテストを書く時 |

## 環境変数

vk-agents のドキュメントやスキル内で \`\$VK_AGENTS_DIR\` という記法が出てきた場合は、以下のパスとして解釈してください（このマシンでの clone 先絶対パス）。

| 変数 | 値 |
|---|---|
| \`\$VK_AGENTS_DIR\` | \`${vk_agents_dir}\` |

例: \`\$VK_AGENTS_DIR/scripts/check-coderabbit.sh\` は \`${vk_agents_dir}/scripts/check-coderabbit.sh\` を指します。"

    if [[ ! -f "$claude_md" ]]; then
        # ファイル新規作成
        {
            echo "$start_marker"
            echo ""
            echo "$content"
            echo ""
            echo "$end_marker"
        } > "$claude_md"
        echo "  → $claude_md を新規作成しました"

    elif grep -qF "$start_marker" "$claude_md"; then
        # 既存セクションを更新
        local tmp
        tmp=$(mktemp)
        CONTENT="$content" \
        AG_START="$start_marker" \
        AG_END="$end_marker" \
        python3 - "$claude_md" "$tmp" <<'PYEOF'
import sys, re, os
src, dst = sys.argv[1], sys.argv[2]
content = open(src).read()
body = os.environ['CONTENT']
start = os.environ['AG_START']
end = os.environ['AG_END']
section = start + '\n\n' + body + '\n\n' + end
pattern = re.escape(start) + r'.*?' + re.escape(end)
# 置換文字列 section をそのまま渡すと \1 や \d 等がエスケープ解釈され
# re.error になるため、関数置換で本文をリテラルとして差し込む。
result = re.sub(pattern, lambda m: section, content, flags=re.DOTALL)
open(dst, 'w').write(result)
PYEOF
        mv "$tmp" "$claude_md"
        echo "  → 既存セクションを更新しました"

    else
        # ファイル末尾に追記
        {
            echo ""
            echo "$start_marker"
            echo ""
            echo "$content"
            echo ""
            echo "$end_marker"
        } >> "$claude_md"
        echo "  → セクションを追記しました"
    fi

    echo "完了: グローバルClaude設定を更新しました"

    # 個人設定 config.json の非推奨ミラーを移行窓のために展開する。
    # 現行スキル・ルールは正本（~/.vk-agents/config.json、または VK_AGENTS_CONFIG で指定した絶対パス）を
    # 直接読むが、--target で各プロジェクトに配布済みの旧スキルコピーは再 sync まで派生ファイルを読む。
    # その互換のため ~/.claude/vk-agents-settings.json への複製を残す。次リリースで撤去予定（issue #235）。
    # config.json が無い環境では展開せず（古い展開先があれば掃除し）、各スキルの既定フォールバックに委ねる。
    # テンプレ config.json.example は「正本へコピーして有効化する」ための雛形で、自動展開はしない。
    local vk_settings_personal="$VK_AGENTS_CONFIG_PATH"
    local vk_settings_dest="$HOME/.claude/vk-agents-settings.json"
    if [[ -f "$vk_settings_personal" ]]; then
        # JSON として妥当な場合のみ展開する（壊れた設定で上書きしない）
        if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$vk_settings_personal" 2>/dev/null; then
            cp "$vk_settings_personal" "$vk_settings_dest"
            echo "  → ${vk_settings_dest} を更新しました（元: ${vk_settings_personal}）"
        else
            echo "  ⚠ ${vk_settings_personal} が不正な JSON のため ${vk_settings_dest} は更新しませんでした" >&2
        fi
    else
        # 個人設定が無い → 展開しない。古い展開先が残っていると意図しない既定になるため掃除する。
        if [[ -f "$vk_settings_dest" ]]; then
            rm -f "$vk_settings_dest"
            echo "  → ${vk_settings_personal} が無いため ${vk_settings_dest} を削除しました（各スキルの既定にフォールバック）"
        else
            echo "  → ${vk_settings_personal} が無いため vk-agents-settings.json は展開しません（各スキルの既定にフォールバック）"
        fi
    fi

    # ~/.claude/skills/ にスキルをインストール
    local skills_src="$SCRIPT_DIR/../skills"
    local skills_dest="$HOME/.claude/skills"
    local manifest_file="$skills_dest/.agent-skills-manifest"
    if [[ -d "$skills_src" ]]; then
        local escaped_rules_dir escaped_repo_root
        escaped_rules_dir=$(printf '%s' "$RULES_DIR" | sed 's/[\\#&]/\\&/g')
        escaped_repo_root=$(printf '%s' "$(cd "$SCRIPT_DIR/.." && pwd)" | sed 's/[\\#&]/\\&/g')

        # 現在インストールするスキル名一覧を収集（skills.disabled は除外）。
        # ここで除外すると、旧マニフェストに載っていた disabled スキルは
        # 「マニフェストにあってソースに無いスキル」として下の削除ループで
        # ~/.claude/skills/ から消え、更新後マニフェストにも載らない。
        local current_skills=()
        for skill_dir in "$skills_src"/*/; do
            [[ -d "$skill_dir" ]] || continue
            local cs_name
            cs_name="$(basename "$skill_dir")"
            is_disabled_skill "$cs_name" && continue
            current_skills+=("$cs_name")
        done

        # 旧マニフェストにあって今回のソースにないスキルを削除
        if [[ -f "$manifest_file" ]]; then
            while IFS= read -r old_skill; do
                [[ -z "$old_skill" ]] && continue
                local found=false
                # bash 3.2 + set -u では空配列の "${arr[@]}" が unbound になるためガードする
                for s in ${current_skills[@]+"${current_skills[@]}"}; do
                    [[ "$s" == "$old_skill" ]] && found=true && break
                done
                if [[ "$found" == false ]] && [[ -d "$skills_dest/$old_skill" ]]; then
                    rm -rf "${skills_dest:?}/$old_skill"
                    echo "  → ~/.claude/skills/$old_skill/ を削除しました（廃止スキル）"
                fi
            done < "$manifest_file"
        fi

        for skill_dir in "$skills_src"/*/; do
            [[ -d "$skill_dir" ]] || continue
            local skill_name
            skill_name="$(basename "$skill_dir")"
            # skills.disabled のスキルはインストールしない（上の削除ループで既存分は削除済み）
            is_disabled_skill "$skill_name" && continue
            local dest_dir="$skills_dest/$skill_name"
            mkdir -p "$dest_dir"
            while IFS= read -r -d '' src_file; do
                local rel_path
                rel_path="${src_file#"$skill_dir"}"
                mkdir -p "$(dirname "$dest_dir/$rel_path")"
                if [[ "$src_file" == *.md ]]; then
                    # rules/ と vendor/ は参照の先頭（行頭・非単語かつ非スラッシュ文字の直後）にある
                    # 時だけ置換する。REPO_ROOT/rules/・$VK_AGENTS_DIR/rules/・**/rules/ や myvendor/ の
                    # ように / や単語文字の直後にある同名部分を巻き込むと二重置換・誤置換になるため
                    # 境界でアンカーする。REPO_ROOT/ は別途置換。
                    sed -E -e "s#(^|[^A-Za-z0-9_/])rules/#\1${escaped_rules_dir}/#g" \
                        -e "s#REPO_ROOT/#${escaped_repo_root}/#g" \
                        -e "s#(^|[^A-Za-z0-9_/])vendor/#\1${escaped_repo_root}/vendor/#g" \
                        "$src_file" > "$dest_dir/$rel_path"
                    # #188 以降、repository-access.md を参照するスキルは自前で硬/軟ゲートを宣言する。
                    # 宣言なしスキルだけに org.allowed_owners 参照の汎用硬ゲートを挿入する。
                    if [[ "$(basename "$src_file")" == "SKILL.md" ]]; then
                        if ! grep -q 'repository-access\.md' "$src_file"; then
                            local tmp_skill
                            tmp_skill=$(mktemp)
                            {
                                cat <<GUARD
> **前提条件（硬ゲート）:** このスキルは、対象リポジトリの owner が許可リスト \`org.allowed_owners\`（\`~/.vk-agents/config.json\`）に含まれる場合のみ使用できます。判定手順は \`${RULES_DIR}/repository-access.md\` を参照してください（許可リスト未設定時は確認のうえ続行可）。

GUARD
                                cat "$dest_dir/$rel_path"
                            } > "$tmp_skill"
                            mv "$tmp_skill" "$dest_dir/$rel_path"
                        fi
                    fi
                else
                    cp "$src_file" "$dest_dir/$rel_path"
                fi
            done < <(find "$skill_dir" -type f -print0)
            echo "  → ~/.claude/skills/$skill_name/ をインストールしました"
        done

        # マニフェストを更新（空配列でも set -u で落ちないようガード）
        mkdir -p "$skills_dest"
        if [[ ${#current_skills[@]} -gt 0 ]]; then
            printf '%s\n' "${current_skills[@]}" > "$manifest_file"
        else
            : > "$manifest_file"
        fi
        echo "  → ~/.claude/skills/.agent-skills-manifest を更新しました"

        # 移行済みスキルの旧コマンドファイルを削除
        local commands_dest="$HOME/.claude/commands"
        if [[ -d "$commands_dest" ]]; then
            for skill_dir in "$skills_src"/*/; do
                [[ -d "$skill_dir" ]] || continue
                local skill_name
                skill_name="$(basename "$skill_dir")"
                local old_cmd="$commands_dest/${skill_name}.md"
                if [[ -f "$old_cmd" ]]; then
                    rm "$old_cmd"
                    echo "  → ~/.claude/commands/${skill_name}.md を削除しました（スキルに移行済み）"
                fi
            done
        fi

        # vk-pr スキルに必要なパーミッションを ~/.claude/settings.json に追加
        local user_settings="$HOME/.claude/settings.json"
        # settings.json が存在しない場合は最小構成で新規作成
        if [[ ! -f "$user_settings" ]]; then
            echo '{"permissions": {"allow": []}}' > "$user_settings"
        fi
        local tmp
        tmp=$(mktemp)
        python3 - "$user_settings" "$tmp" <<'PYEOF'
import sys, json
src, dst = sys.argv[1], sys.argv[2]
try:
    with open(src) as f:
        settings = json.load(f)
except json.JSONDecodeError as e:
    print(f"エラー: {src} の JSON パースに失敗しました: {e}", file=sys.stderr)
    sys.exit(1)

permissions = settings.setdefault("permissions", {})
allow = permissions.setdefault("allow", [])

new_perms = [
    "Bash(gh api:*)",
    "Bash(gh pr:*)",
    "Bash(git log:*)",
    "Bash(git diff:*)",
    "Bash(git branch:*)",
    "Bash(git status:*)",
    "Bash(git push:*)",
    "Bash(date:*)",
    "Bash(sleep:*)",
    "Bash(cd:*)",
]
for p in new_perms:
    if p not in allow:
        allow.append(p)

with open(dst, "w") as f:
    json.dump(settings, f, indent=2, ensure_ascii=False)
    f.write("\n")
PYEOF
        mv "$tmp" "$user_settings"
        echo "  → ~/.claude/settings.json に必要なスキル用パーミッションを追加しました"
    fi
}

# 実行
migrate_config
load_disabled_skills
if [[ -n "$TARGET" ]]; then sync_to_project "$TARGET"; fi
if [[ "$CLAUDE_GLOBAL" == true ]]; then sync_claude_global; fi
