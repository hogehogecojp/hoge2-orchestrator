#!/usr/bin/env bash
# check-coderabbit.sh
#
# Usage:
#   ./scripts/check-coderabbit.sh <REPO> <PR_NUMBER> <SINCE_ISO8601>
#
# 説明:
#   GitHub の PR について、CodeRabbit (coderabbitai[bot]) からの新規投稿を3エンドポイント
#   （PR通常コメント・インラインレビューコメント・レビュー本体）を一括取得して検出する補助ツール。
#   SINCE 以降の投稿が1件でもあれば標準出力に整形して出し exit 0、無ければ stderr に notice を
#   出して exit 1、引数不足・取得失敗などは exit 2 を返す。司の until-loop から呼び出して使う。
#
# 引数:
#   REPO         "owner/repo" 形式 (例: vektor-inc/vk-blocks-pro)
#   PR_NUMBER    PR 番号 (整数)
#   SINCE        ISO 8601 形式の UTC 時刻 (例: 2026-05-14T12:34:56Z)
#
# 依存:
#   - gh (GitHub CLI, 認証済み)
#   - jq
#   - Bash 3.2+
#
# 終了コード:
#   0 : CodeRabbit からの新規投稿を検出し標準出力に整形して出力した
#   1 : 新規投稿なし (stderr に "no new coderabbitai posts since SINCE")
#   2 : 引数不足や API エラーなどの問題 (stderr にメッセージ)

set -euo pipefail

err() {
    printf '%s\n' "$*" >&2
}

# features.coderabbit / features.coderabbit_ignore フラグ確認
#
# CodeRabbit 未導入の環境（社外・個人リポジトリ等）では、監視ループが新規投稿を
# 検知できず無限に空振りする。~/.vk-agents/config.json（または VK_AGENTS_CONFIG で指定した正本）の
# features.coderabbit が false の場合はここで
# 即 exit 0 し、呼び出し元の until-loop を待たせない。
#
# CodeRabbit は導入済みだが通常レビューを走らせたくない環境では、
# features.coderabbit_ignore が true の場合もここで即 exit 0 し、PR 本文側に
# @coderabbitai ignore を書く運用と合わせて監視をスキップする。
# features.coderabbit=false が優先で、未導入環境には ignore コメントを書かない。
#
# 判定は「true 扱い（デフォルト有効）」を基本とする: ファイルが無い・キーが無い・
# JSON パース失敗のいずれも coderabbit=true / coderabbit_ignore=false とみなす
# （社内メンバー全員の既存環境で挙動を変えない）。
#
# 注意: `jq -r '.features.coderabbit // true'` のように `//` は書かない。jq の
# `//` は左辺が false のときも右辺にフォールバックするため、明示的に false を
# 設定していても true に化けてしまう（jq の仕様上のハマりどころ）。
# 素の値を文字列比較する。
SETTINGS_FILE="${VK_AGENTS_CONFIG:-$HOME/.vk-agents/config.json}"
coderabbit_enabled=true
coderabbit_ignore=false
if [ -f "$SETTINGS_FILE" ]; then
    val=$(jq -r '.features.coderabbit' "$SETTINGS_FILE" 2>/dev/null || echo true)
    [ "$val" = "false" ] && coderabbit_enabled=false
    ignore_val=$(jq -r '.features.coderabbit_ignore' "$SETTINGS_FILE" 2>/dev/null || echo false)
    [ "$ignore_val" = "true" ] && coderabbit_ignore=true
fi
if [ "$coderabbit_enabled" = false ]; then
    printf 'CodeRabbit 連携は無効化されています（features.coderabbit: false）\n'
    exit 0
fi
if [ "$coderabbit_ignore" = true ]; then
    printf 'CodeRabbit レビューは ignore 指定のためスキップします（features.coderabbit_ignore: true）\n'
    exit 0
fi

if [ $# -lt 3 ]; then
    err "Usage: $0 <REPO> <PR_NUMBER> <SINCE_ISO8601>"
    err "  例: $0 vektor-inc/vk-blocks-pro 123 2026-05-14T12:34:56Z"
    exit 2
fi

REPO="$1"
PR="$2"
SINCE="$3"

# 簡易バリデーション (owner/repo / 数字 / Z 終わり ISO8601)
case "$REPO" in
    */*) : ;;
    *)
        err "ERROR: REPO must be in 'owner/repo' format (got: $REPO)"
        exit 2
        ;;
esac

case "$PR" in
    ''|*[!0-9]*)
        err "ERROR: PR_NUMBER must be a positive integer (got: $PR)"
        exit 2
        ;;
esac

case "$SINCE" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) : ;;
    *)
        err "ERROR: SINCE must be ISO 8601 UTC (e.g. 2026-05-14T12:34:56Z); got: $SINCE"
        exit 2
        ;;
esac

# 一時ファイル (3 レスポンスを格納)。trap で必ず後片付け
TMPDIR_WORK=$(mktemp -d 2>/dev/null || mktemp -d -t 'check-cr')
trap 'rm -rf "$TMPDIR_WORK"' EXIT

ISSUE_JSON="$TMPDIR_WORK/issue_comments.json"
INLINE_JSON="$TMPDIR_WORK/inline_comments.json"
REVIEWS_JSON="$TMPDIR_WORK/reviews.json"

fetch() {
    # $1: gh api 引数 (path)
    # $2: 出力先ファイル
    if ! gh api --paginate "$1" >"$2" 2>"$TMPDIR_WORK/err.log"; then
        err "ERROR: gh api $1 failed"
        if [ -s "$TMPDIR_WORK/err.log" ]; then
            sed 's/^/  /' "$TMPDIR_WORK/err.log" >&2
        fi
        exit 2
    fi
}

fetch "repos/$REPO/issues/$PR/comments" "$ISSUE_JSON"
fetch "repos/$REPO/pulls/$PR/comments"  "$INLINE_JSON"
fetch "repos/$REPO/pulls/$PR/reviews"   "$REVIEWS_JSON"

# CodeRabbit 投稿だけ抽出し、SINCE より後の「actionable な新規」に絞り込む。
#
# 新規 actionable の定義:
#   (created_at > since または updated_at > since) かつ body がプレースホルダーにマッチしない
#
# - updated_at も見るのは、CodeRabbit が指摘ゼロ時などに新規投稿せず既存の要約コメントを
#   in-place 編集する（created_at 据え置き・updated_at 更新）ケースを取り逃さないため (弱点2)。
# - プレースホルダー除外は、push 直後の "Currently processing" / "review in progress by
#   coderabbit.ai" という仮コメントを「完了」と誤判定しないため (弱点1)。
# - レビュー本体 (reviews) は updated_at を持たないことがあるため submitted_at のみで判定する。
#
# 抽出形式: {created_at, html_url, body, kind}
#
# 入力の正規化について:
#   gh api --paginate は配列を返すエンドポイントを複数ページ取得した際、gh のバージョンに
#   よってはページごとに別々のトップレベル JSON 配列を出力する（NDJSON 的に複数の値になる）。
#   そのまま `[.[]? | ...]` を流すと jq が入力値ごとにプログラムを評価し配列が複数出力され、
#   後段の `jq 'length'` が複数行を返して TOTAL の算術が壊れる。
#   これを避けるため `jq -n '[inputs] | .[] | .[]? | ...'` で全トップレベル値を一度集約し
#   （[inputs]）、ページ→要素の順に1段ずつ展開する。単一配列・複数配列・空配列のいずれでも
#   常に単一の結果配列に正規化される。
PLACEHOLDER_RE='(Currently processing)|(review in progress)'
EXTRACT_COMMENT='[inputs] | [.[] | .[]? | select(.user.login == "coderabbitai[bot]") | select((.created_at > $since) or ((.updated_at // "") > $since)) | select((.body // "") | test($placeholder) | not) | {created_at: .created_at, html_url: .html_url, body: (.body // ""), kind: $kind}]'
EXTRACT_REVIEW='[inputs] | [.[] | .[]? | select(.user.login == "coderabbitai[bot]") | select((.submitted_at // "") > $since) | select((.body // "") | test($placeholder) | not) | {created_at: .submitted_at, html_url: .html_url, body: (.body // ""), kind: "review"}]'

ISSUE_FILTERED=$(jq -n --arg since "$SINCE" --arg kind "issue_comment" --arg placeholder "$PLACEHOLDER_RE" "$EXTRACT_COMMENT" "$ISSUE_JSON")
INLINE_FILTERED=$(jq -n --arg since "$SINCE" --arg kind "inline_comment" --arg placeholder "$PLACEHOLDER_RE" "$EXTRACT_COMMENT" "$INLINE_JSON")
REVIEW_FILTERED=$(jq -n --arg since "$SINCE" --arg placeholder "$PLACEHOLDER_RE" "$EXTRACT_REVIEW" "$REVIEWS_JSON")

ISSUE_COUNT=$(printf '%s' "$ISSUE_FILTERED" | jq 'length')
INLINE_COUNT=$(printf '%s' "$INLINE_FILTERED" | jq 'length')
REVIEW_COUNT=$(printf '%s' "$REVIEW_FILTERED" | jq 'length')

TOTAL=$((ISSUE_COUNT + INLINE_COUNT + REVIEW_COUNT))

if [ "$TOTAL" -eq 0 ]; then
    err "no new coderabbitai posts since $SINCE"
    exit 1
fi

# 出力フェーズ
printf 'issuecomments=%d inline=%d reviews=%d\n' "$ISSUE_COUNT" "$INLINE_COUNT" "$REVIEW_COUNT"

# 3 ソースを連結し時刻昇順で並べる
MERGED=$(jq -s 'add | sort_by(.created_at)' \
    <(printf '%s' "$ISSUE_FILTERED") \
    <(printf '%s' "$INLINE_FILTERED") \
    <(printf '%s' "$REVIEW_FILTERED"))

# レビュー完了の確実な合図として、本文に "Actionable comments posted:" を含む投稿が
# あるかを併せて出力する (呼び出し側が完了判定を補強できるよう情報として添えるのみ)。
if printf '%s' "$MERGED" | jq -e 'any(.[]; (.body // "") | test("Actionable comments posted:"))' >/dev/null 2>&1; then
    printf 'actionable_comments_posted=yes\n'
else
    printf 'actionable_comments_posted=no\n'
fi

# 1件ずつヘッダ + 本文 (最大2000文字で切り詰め) を出力
printf '%s' "$MERGED" | jq -c '.[]' | while IFS= read -r item; do
    created_at=$(printf '%s' "$item" | jq -r '.created_at')
    html_url=$(printf '%s'  "$item" | jq -r '.html_url')
    body=$(printf '%s'      "$item" | jq -r '.body')

    printf -- '--- [%s] %s\n' "$created_at" "$html_url"

    # マルチバイトを正しく数えるため wc -m を利用し、2000 文字超なら切り詰め
    body_len=$(printf '%s' "$body" | wc -m | tr -d ' ')
    if [ "$body_len" -gt 2000 ]; then
        # macOS 標準 awk の substr はバイト単位で日本語などのマルチバイト文字を分断し
        # 壊れた UTF-8 を出しうる。jq の文字列スライスはコードポイント単位で安全なため、
        # 依存済みの jq で先頭 2000 文字を切り出す（-R 生入力・-s 全体を1文字列・-r 生出力）。
        truncated=$(printf '%s' "$body" | jq -Rrs '.[0:2000]')
        printf '%s...(truncated)\n' "$truncated"
    else
        printf '%s\n' "$body"
    fi
done

exit 0
