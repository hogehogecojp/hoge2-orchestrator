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

# 配布先に置く管理名簿のファイル名。vk-agents が配布したスキル・定義・人格ファイルの名前だけを列挙する。
MANIFEST_NAME=".agent-skills-manifest"

# スキル配布先の削除ループで、名簿に載っていても絶対に削除しないディレクトリ名。
# agent-skills はルール集（copy_rules）の展開先、wordpress は WordPress 公式スキルの展開先で、
# どちらも vk-agents のスキル名簿の管理対象ではない。名簿が壊れて名前が混入しても、
# 同じ実行でコピーしたばかりの内容を消さないようここで固定除外する。
SKILLS_NEVER_REMOVE="agent-skills wordpress"

# 旧構成の残骸として一度きりの移行削除を試みるディレクトリ名。
# ★一時コード★ 名簿方式が行き渡れば不要になるため、数リリース後に
# cleanup_legacy_skills ごと削除してよい（issue #293 の移行用）。
LEGACY_SKILL_DIRS="staff-director staff-review staff-security staff-ux staff-wp-dev"

# sync_skills の実行結果（完了行の件数サマリ用）。
SKILLS_INSTALLED_COUNT=0
SKILLS_REMOVED_COUNT=0
SKILLS_DEFERRED_COUNT=0

# 「配るはずだったが書き込めなかった」項目の記録。1件でもあれば末尾で一覧を1行出し exit 2 で終える。
# 呼び出し側が終了コードだけで「全部配れた回（0）」と「一部スキップした回（2）」を見分けられるようにする。
#
# 記録するのは配布の書き込みを見送ったときだけ。次の2つは記録しない:
#   - 削除・掃除の見送り（利用者のものかもしれないので触らない＝所有権を手放す判断であり、
#     配布自体は完了しているため）
#   - 移行用の一度きり処理（cleanup_legacy_personas / cleanup_legacy_skills。★一時コード★ で
#     いずれ消えるため、恒久的な終了コードの意味に混ぜない）
SKIPPED_ITEMS=()

# スキップした対象と理由を1件記録する。$1 = 対象パス, $2 = 理由（短く）。
record_skip() {
    SKIPPED_ITEMS+=("$1（$2）")
}

# スキップ記録をまとめて出し、1件でもあれば部分成功として exit 2 で終える。
# 途中で打ち切らない現行設計を保つため、判定はすべての配布処理が終わったこの時点でだけ行う。
#
# 件数の見出し1行＋1件1行で出す。全件を1行に連結すると、件数が増えたときに端末幅で折り返され、
# パスの途中で改行されて対象と理由の対応が読めなくなるため。
report_skips_and_exit() {
    local count=${#SKIPPED_ITEMS[@]}
    [[ "$count" -gt 0 ]] || exit 0

    local item
    echo "⚠ 配布をスキップした項目が ${count} 件あります:" >&2
    for item in ${SKIPPED_ITEMS[@]+"${SKIPPED_ITEMS[@]}"}; do
        echo "    $item" >&2
    done
    exit 2
}

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
                 → {target}/.claude/agents/
                 → {target}/.claude/vk-agents-personas/
  Cursor         → {target}/.cursor/rules/agent-skills/
  GitHub Copilot → {target}/.github/copilot-instructions.md（マーカーセクションを更新）
  Codex          → {target}/.codex/skills/agent-skills/

展開先（--claude-global）:
  Claude Code    → ~/.claude/skills/
                 → ~/.claude/agents/
                 → ~/.claude/vk-agents-personas/

展開先（--wordpress 指定時）:
  Claude Code    → {target}/.claude/skills/wordpress/
  Cursor         → {target}/.cursor/rules/wordpress/
  Codex          → {target}/.codex/skills/wordpress/
  ※自社ルールは wordpress/ の後に agent-skills/ として展開されるため優先されます

管理名簿（.agent-skills-manifest）:
  配布先の .claude/skills/ ・ .claude/agents/ ・ .claude/vk-agents-personas/ に
  .agent-skills-manifest を置き、vk-agents が配布した名前だけを記録します。
  次回以降はこの名簿に載っていて今回のソースに無いものだけを削除するため、
  利用者が自分で置いたスキル・定義・人格ファイルは削除されません。
  名簿を手で消すと、そこに載っていたものは以後「利用者のもの」と見なされ
  削除対象から外れます（スキルは名簿が無くても上書き更新は続きます）。
  ただしエージェント定義・人格ファイルは、配布内容と中身が完全に一致するものだけ
  次回の実行で名簿へ記録し直し、更新対象に戻します。中身が違うものは
  上書きせず、中身を確認して置き換えるかどうかを利用者が選べるようにします。

終了コード:
  0  すべて配布できた
  1  引数エラーなどで配布を開始できなかった
  2  一部の配布をスキップした（部分成功）。1箇所の異常で全体を止めずに配布を続け、
     スキップした対象と理由を末尾に件数の見出しと1件1行で出力する（詳細は各 ⚠ 行）

  ※ スクリプトや CI から呼ぶ場合は、0 のときだけ成功として扱ってください
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
# 右辺は必ずクォートする（[[ ]] の右辺は未クォートだと glob パターンとして解釈されるため、
# owner_skill: "*" のような値がすべてのスキル名に一致してしまう）。
is_disabled_skill() {
    local name="$1" s
    for s in ${DISABLED_SKILLS[@]+"${DISABLED_SKILLS[@]}"}; do
        [[ "$s" == "$name" ]] && return 0
    done
    return 1
}

# Markdown 内の rules/・REPO_ROOT/・vendor/ 参照を配布形態に合わせて書き換える。
# 各 mode の置換順序とアンカーは既存の配布挙動を維持するため変更しない。
# REPO_ROOT/vk-agents-personas/ は REPO_ROOT/ の一般規則より先に置換する。後にすると
# ソースチェックアウトの絶対パスへ潰れ、配布済みコピー（rules/ 参照が絶対パスへ
# 書き換わっている方）を指せなくなる。
rewrite_md_paths() {
    local mode="$1"
    local src_file="$2"
    local dst_file="$3"
    local escaped_repo_root="$4"
    local escaped_rules_dir="${5:-}"
    local escaped_home_skills="${6:-}"
    local escaped_home_personas
    escaped_home_personas=$(printf '%s' "$HOME/.claude/vk-agents-personas" | sed 's/[\\#&]/\\&/g')

    case "$mode" in
        target)
            sed -E -e 's#(^|[^A-Za-z0-9_/])rules/#\1.claude/skills/agent-skills/#g' \
                -e 's#REPO_ROOT/vk-agents-personas/#.claude/vk-agents-personas/#g' \
                -e 's#REPO_ROOT/skills/#.claude/skills/#g' \
                -e "s#REPO_ROOT/#${escaped_repo_root}/#g" \
                -e "s#(^|[^A-Za-z0-9_/])vendor/#\1${escaped_repo_root}/vendor/#g" \
                "$src_file" > "$dst_file"
            ;;
        global-skill)
            sed -E -e "s#(^|[^A-Za-z0-9_/])rules/#\1${escaped_rules_dir}/#g" \
                -e "s#REPO_ROOT/vk-agents-personas/#${escaped_home_personas}/#g" \
                -e "s#REPO_ROOT/#${escaped_repo_root}/#g" \
                -e "s#(^|[^A-Za-z0-9_/])vendor/#\1${escaped_repo_root}/vendor/#g" \
                "$src_file" > "$dst_file"
            ;;
        global-agent)
            sed -E -e "s#(^|[^A-Za-z0-9_/])rules/#\1${escaped_rules_dir}/#g" \
                -e "s#REPO_ROOT/vk-agents-personas/#${escaped_home_personas}/#g" \
                -e "s#REPO_ROOT/skills/#${escaped_home_skills}/#g" \
                -e "s#REPO_ROOT/#${escaped_repo_root}/#g" \
                -e "s#(^|[^A-Za-z0-9_/])vendor/#\1${escaped_repo_root}/vendor/#g" \
                "$src_file" > "$dst_file"
            ;;
        *)
            echo "エラー: 未対応の Markdown パス書き換え mode です: $mode" >&2
            return 1
            ;;
    esac
}

# エージェント定義の frontmatter から所有スキル名（owner_skill）を取得する。
# skills.disabled に指定されたスキルの定義を連動して配布対象外にするために使う。
# frontmatter 以外の owner_skill: 行は拾わない。owner_skill が無い定義は無効化対象では
# ないものとして扱う（＝常に配布する）。
#
# 改行コードが CRLF の定義でも読めるよう、区切り行 --- と owner_skill: 行の両方で行末の \r を
# 落としてから判定する（1行目が "---\r" のときに設定ブロックごと認識できず、無効化したはずの
# スキルの定義が無言で配布されるのを防ぐ）。値が引用符（" / '）で囲まれている場合は、前後の
# 対になる引用符だけを外す。片側だけの引用符・値の途中の引用符は値の一部として残す。
agent_owner_skill() {
    local src_file="$1"
    awk 'NR==1 { sub(/\r$/, ""); if ($0 != "---") exit; next }
         { sub(/\r$/, "") }
         /^---[[:space:]]*$/ { exit }
         /^owner_skill:/ {
             sub(/^owner_skill:[ \t]*/, "")
             sub(/[ \t]+$/, "")
             first = substr($0, 1, 1)
             last = substr($0, length($0), 1)
             if (length($0) >= 2 && first == last && (first == "\"" || first == "\047")) {
                 $0 = substr($0, 2, length($0) - 2)
             }
             print
             exit
         }' "$src_file"
}

# 配布先の frontmatter から owner_skill 行を落とす。
# owner_skill は vk-agents の配布処理用メタデータであり、Claude Code のエージェント定義
# としては未知のキーになる。配布物に残さないことで Claude Code 側の解釈に依存しない。
#
# 一時ファイルを mv で被せると mktemp のパーミッション（0600）が配布物に残り、同時に配る
# 人格ファイル（umask 由来の 0644）と食い違う。中身だけを書き戻して元のパーミッションを保つ。
#
# mv をやめたことで、この書き戻し単体の原子性（途中で失敗しても元ファイルが壊れない）は無くなる。
# それを許容できるのは、書き込み先が「同じ実行の直前に rewrite_md_paths が sed > dst で作った
# 配布物」に限られるため。元から利用者のファイルを直接書き換える経路ではなく、その sed 自体も
# 原子的ではないので、ここだけ mv にしても配布全体の原子性は得られない。途中で失敗した場合は
# 次回の sync で rewrite_md_paths が同じファイルを丸ごと書き直す。
# パーミッションを固定値（0644）にして mv する案は採らない。umask 077 の環境で人格ファイルが
# 0600 になり、揃えたはずのパーミッションがまた食い違うため。
#
# CRLF の定義でも frontmatter を認識できるよう、判定時だけ行末の \r を無視する。
strip_owner_skill() {
    local file="$1" tmp
    tmp=$(mktemp)
    awk 'BEGIN { fm = 0 }
         { line = $0; sub(/\r$/, "") }
         NR == 1 && $0 == "---" { fm = 1; print line; next }
         fm == 1 && /^---[[:space:]]*$/ { fm = 0; print line; next }
         fm == 1 && /^owner_skill:/ { next }
         { print line }' "$file" > "$tmp"
    cat "$tmp" > "$file"
    rm -f "$tmp"
}

# 管理名簿に載っていない既存ファイルが、これから配布する内容と完全に一致するかを判定する
# （一致すれば 0 を返す）。
#
# 名簿が失われる（symlink 化・ディレクトリ化・削除）と管理対象リストが空になり、正規の配布物まで
# 「利用者が置いたもの」と見なされて上書きされない。名簿を空のファイルで作り直しても状況が変わらず、
# 配布物を永久に更新できない行き止まりになる。中身が一致する＝上書きしても何も変わらないため、
# vk-agents の配布物（名簿だけが失われた状態）と判断して管理対象へ戻せる。利用者が編集した
# ファイルは中身が違うので一致せず、従来どおり保護される。
#
# 比較対象は「配布後の最終形」（パス書き換え後、エージェント定義はさらに owner_skill 行を
# 落とした後）。ソースそのままと比べると、正しく配布済みのファイルまで不一致になるため。
#
# 生成先は mktemp の一時ファイルで、比較後に必ず削除する。この一時ファイルを配布先へ mv / cp は
# しない（mktemp のパーミッション 0600 が配布物に残る。strip_owner_skill のコメント参照）。
# 一致した場合は配布先が既に最終形なので書き込み自体を行わない（mtime を無駄に更新しない）。
#
#   $1 = 種別（agent / persona。agent だけ owner_skill 行を落とす）
#   $2 = 配布モード（rewrite_md_paths に渡す target / global-agent / global-skill）
#   $3 = ソースファイル
#   $4 = 比較する既存ファイル
#   $5 = エスケープ済みリポジトリルート
#   $6 = エスケープ済み rules ディレクトリ（target モードでは使われない）
#   $7 = エスケープ済み ~/.claude/skills（global-agent のみ使用）
distributed_content_matches() {
    local kind="$1"
    local mode="$2"
    local src_file="$3"
    local dest_file="$4"
    local escaped_repo_root="$5"
    local escaped_rules_dir="${6:-}"
    local escaped_home_skills="${7:-}"
    local tmp status=1

    tmp=$(mktemp)
    if [[ "$kind" == "agent" ]]; then
        # 引数の渡し方は sync_agents の配布本体と揃える（mode ごとに必要な引数が違う）。
        if [[ "$mode" == "global-agent" ]]; then
            rewrite_md_paths "$mode" "$src_file" "$tmp" \
                "$escaped_repo_root" "$escaped_rules_dir" "$escaped_home_skills"
        else
            rewrite_md_paths "$mode" "$src_file" "$tmp" "$escaped_repo_root"
        fi
        strip_owner_skill "$tmp"
    else
        rewrite_md_paths "$mode" "$src_file" "$tmp" "$escaped_repo_root" "$escaped_rules_dir"
    fi
    cmp -s "$tmp" "$dest_file" && status=0
    rm -f "$tmp"
    return "$status"
}

# 名簿に記録が無い既存ファイルを、中身の一致を根拠に管理対象へ戻したことを1件1行で伝える。
# 利用者の操作は不要なので警告（⚠）ではなく通常の進捗行として出し、スキップにも数えない。
# 「インストールしました」とは書かない。中身は既に配布後の最終形と一致しており、書き込みを
# 行っていないため（配布したと書くと事実と食い違う）。
report_self_healed_file() {
    echo "  → $1 は内容が配布物と同じだったため、管理対象に戻しました"
}

# 管理対象へ戻した件数を配布先ごとに1回だけまとめる（1件以上のときだけ呼ぶ）。
# 何を根拠に判断したのか・中身は触っていないこと・管理対象から外したい場合の手段まで添える。
# 個別行だけだと「勝手に管理下へ入れられた」と受け取られかねないため。
report_self_healed_summary() {
    local count="$1"
    echo "  ※ 内容が配布物と同じだったファイル ${count} 件を、管理名簿（${MANIFEST_NAME}）へ記録し直しました"
    echo "    名簿に記録が無いものの、中身が今回配布する内容と完全に一致したファイルです。vk-agents が"
    echo "    配布したものと判断し、以後の更新・削除の対象に戻しました。中身は書き換えていないため、"
    echo "    この処理で失われた内容はありません"
    echo "    自分のファイルとして管理対象から外したい場合は、別名で保存してください"
}

# 名簿に記録が無く、中身も配布内容と一致しなかったファイルを上書きしなかったことを伝える。
# 「同名のファイルが既にある」ではなく「中身が違う」と伝える。中身が一致するものは管理対象へ
# 戻すようになったため、ここへ来るのは中身が違うファイルだけになった。
# 利用者が編集したファイルだと断定はしない。古い版の配布物や、vk-agents のクローン先を移動して
# 書き換わる絶対パスがずれた配布物も中身が一致しないため、断定すると正規の配布物を手で
# 消させる誘導になる。
warn_content_mismatch() {
    echo "  ⚠ $1 は中身が配布内容と異なるため上書きしませんでした" >&2
    echo "    利用者が編集したファイル、または古い版の配布物のどちらかです。中身を確認し、配布物で" >&2
    echo "    置き換えてよい場合は、退避（別名で保存）または削除してから再実行してください" >&2
    echo "    そのままでも、他のファイルの配布は完了しています" >&2
}

# 上書きを見送った件数と、詳細の在り処を標準出力にも1行だけ残す（sync_skills と同じ形）。
# 見送りの警告は標準エラー出力に出るため、標準出力だけを見る呼び出し側には何も届かない。
report_deferred_pointer() {
    echo "  ※ 上書きを見送った $1 件の詳細は上の ⚠ 行（標準エラー出力）を確認してください"
}

# 配布先ディレクトリから管理ルートの直下までに symlink が無いことを確認して作成する。
# ~/.claude や {target}/.claude 自体は利用者が symlink で管理する既存運用を維持するため
# 検査対象外とし、vk-agents が管理する agents/・vk-agents/・personas/ だけを検査する。
prepare_distribution_directory() {
    local dest="$1"
    local managed_root="$2"
    local current="$dest"
    local parent

    while [[ "$current" != "$managed_root" ]]; do
        if [[ -L "$current" ]]; then
            echo "  ⚠ $current は symlink のため、この配布処理をスキップしました" >&2
            record_skip "$current" "配布先が symlink"
            return 1
        fi
        parent="$(dirname "$current")"
        [[ "$parent" != "$current" ]] || break
        current="$parent"
    done

    mkdir -p "$dest"
}

# スキル配下の1ファイル分の書き込み先が安全かを判定する。
# 配布先ディレクトリ（$base）から相対パス（$rel）を1階層ずつ降り、途中の1階層でも symlink なら
# 書き込まない。スキルは中に任意のサブディレクトリ・ファイルを持てるため、最上位だけを見る
# prepare_distribution_directory では中身の symlink を経由した配布先外への書き抜けを防げない
# （rewrite_md_paths の > も cp も mkdir -p もリンクを辿るため）。
skill_entry_is_safe() {
    local base="$1"
    local rel="$2"
    local current="$base"
    local remainder="$rel" part

    # 区切りで分解する。パラメータ展開だけを使うため、グロブ展開も改行での打ち切りも起きない
    # （read は最初の改行で読み取りを止めるため、改行を含む名前だと末尾要素を検査できない）。
    while [[ -n "$remainder" ]]; do
        part="${remainder%%/*}"
        if [[ "$part" == "$remainder" ]]; then
            remainder=""
        else
            remainder="${remainder#*/}"
        fi
        [[ -z "$part" ]] && continue
        current="$current/$part"
        if [[ -L "$current" ]]; then
            echo "  ⚠ $current は symlink のため書き込みをスキップしました" >&2
            record_skip "$current" "symlink"
            return 1
        fi
    done

    # 最終要素が既にある場合は通常ファイルでなければ書き込まない。
    if [[ -e "$current" ]] && [[ ! -f "$current" ]]; then
        echo "  ⚠ $current は通常ファイルではないため変更しませんでした" >&2
        record_skip "$current" "通常ファイルではない"
        return 1
    fi
    return 0
}

# マニフェストは通常ファイルまたは未作成の場合だけ読み書きしてよい。
# $2 に quiet を渡すと警告を出さずに判定と記録だけ行う。同じ名簿について呼び出し側が
# あとでより詳しい案内（warn_unreadable_manifest_conflicts）を出す場合に、同じ内容の警告が
# 二重に並ぶのを避けるために使う。
guard_distribution_manifest() {
    local manifest_file="$1"
    local quiet="${2:-}"
    if { [[ -e "$manifest_file" ]] || [[ -L "$manifest_file" ]]; } \
        && { [[ ! -f "$manifest_file" ]] || [[ -L "$manifest_file" ]]; }; then
        [[ "$quiet" == "quiet" ]] || warn_unreadable_manifest "$manifest_file"
        record_skip "$manifest_file" "通常ファイルではない"
        return 1
    fi
}

# 管理名簿を更新できなかったことだけを伝える警告。
warn_unreadable_manifest() {
    echo "  ⚠ $1 は通常ファイルではないため変更しませんでした" >&2
}

# 管理名簿が読めない回に、上書きを見送った理由と対処を配布先ごとに1回だけ出す。
# 原因も対処も対象ファイル全件で同一なので、ファイルごとに長文を繰り返すと画面が警告で埋まり
# 肝心の原因が読めなくなる。まとめの直後に、見送った対象を1件1行で短く並べる。
#   $1 = 管理名簿のパス
#   $2 = 中身が配布内容と一致したファイル数（名簿へ記録できなかった分）
#   $3 以降 = 上書きを見送ったファイルのパス
warn_unreadable_manifest_conflicts() {
    local manifest_file="$1"
    local matched_count="$2"
    shift 2
    local path
    # パスは独立した行に出す。可変長のパスを固定の文言に混ぜると、端末幅での折返しが
    # 環境ごとにガタつき、どこまでが1つの文なのか読み取れなくなるため。
    echo "  ⚠ 管理名簿が通常ファイルではないため（symlink かディレクトリ）、既存ファイルが vk-agents の" >&2
    echo "    配布物か利用者のものか判定できません" >&2
    # 件数は「名簿が読めないことを理由に見送った分」だけ。同じディレクトリで別の理由
    # （名簿自体が通常ファイルでない、配布物がディレクトリに置換されている等）で見送った分は
    # 含まないため、「このディレクトリへの配布」のような広い主語にはしない。
    # 中身が一致して上書きが不要だったファイルもここには含めない（見送りではないため）。
    if [[ $# -gt 0 ]]; then
        echo "    持ち主を判定できず上書きを見送ったファイルが $# 件あります" >&2
    fi
    # 中身が一致したファイルは最新の状態だが、名簿が書けないので管理対象へ戻せない。
    # 次回も同じ照合が走ることを伝え、「毎回この案内が出る」ことの理由が分かるようにする。
    # 「うち」の係り先は名簿に記録が無いファイル全体。直前の見送り件数に一致分は含まれないため、
    # 主語を省くと「見送り 1 件のうち 3 件」のように件数が矛盾して読めてしまう。
    if [[ "$matched_count" -gt 0 ]]; then
        echo "    名簿に記録が無いファイルのうち $matched_count 件は中身が配布内容と一致しており最新の状態ですが、" >&2
        echo "    名簿へ記録できないため次回も同じ確認が必要です" >&2
    fi
    echo "    対象: $manifest_file" >&2
    # 対処は「通常ファイルに戻す」1つだけを案内する。「戻すか削除する」と併記すると、壊れた
    # ディレクトリに対して選びやすい削除のほうへ誘導してしまう。
    # 空のファイルで作り直しても行き止まりにはならない（中身が配布内容と一致するファイルは
    # distributed_content_matches の照合で管理対象へ戻る）ため、その点は明示して不安を残さない。
    echo "    ls -l '$manifest_file' で状態を確認し、通常ファイルに戻してから再実行してください" >&2
    echo "    中身を復元できず空のファイルで作り直しても構いません。中身が現在の配布内容と一致する" >&2
    echo "    ファイルは、次回の実行で自動的に管理対象へ戻ります" >&2
    for path in "$@"; do
        echo "  ⚠ $path は上書きしませんでした（管理名簿が読めず持ち主を判定できないため）" >&2
    done
}

# Claude Code のエージェント定義を配布する。
# 旧マニフェストに載るファイルだけを vk-agents 管理対象とし、それ以外の既存ファイルは
# 利用者所有として削除も上書きもしない。
sync_agents() {
    local agents_src="$SCRIPT_DIR/../agents"
    local agents_dest="$1"
    local mode="$2"
    local managed_root="$3"
    [[ -d "$agents_src" ]] || return 0
    prepare_distribution_directory "$agents_dest" "$managed_root" || return 0

    local escaped_rules_dir escaped_repo_root escaped_home_skills
    escaped_rules_dir=$(printf '%s' "$RULES_DIR" | sed 's/[\\#&]/\\&/g')
    escaped_repo_root=$(printf '%s' "$(cd "$SCRIPT_DIR/.." && pwd)" | sed 's/[\\#&]/\\&/g')
    escaped_home_skills=$(printf '%s' "$HOME/.claude/skills" | sed 's/[\\#&]/\\&/g')

    local manifest_file="$agents_dest/.agent-skills-manifest"
    local old_agents=()
    local current_agents=()
    local old_agent
    local manifest_is_safe=false
    # 名簿が読めない回に同名衝突が起きると、この配布処理の最後により詳しい案内を出す。
    # 同じ名簿について警告が二重に並ばないよう、ここでは判定だけ行い警告は保留する。
    if guard_distribution_manifest "$manifest_file" quiet; then
        manifest_is_safe=true
    fi
    if [[ "$manifest_is_safe" == true ]] && [[ -f "$manifest_file" ]]; then
        while IFS= read -r old_agent; do
            [[ -z "$old_agent" ]] && continue
            # マニフェストを手動編集されても agents/ 外を削除しないよう、ファイル名だけを受け付ける。
            [[ "$old_agent" == */* ]] && continue
            [[ "$old_agent" == "." || "$old_agent" == ".." ]] && continue
            old_agents+=("$old_agent")
        done < "$manifest_file"
    fi

    # 管理名簿が読めない回に上書きを見送ったファイル。理由と対処は全件同じなので、
    # ループ後に warn_unreadable_manifest_conflicts でまとめて出す。
    local unowned_agents=()
    # 中身の一致を根拠に管理対象へ戻した件数（ループ後にまとめて1回伝える）。
    local self_healed_count=0
    # 上書きを見送った件数。標準出力しか見ない呼び出し側へ「詳細は ⚠ 行」と案内するために数える。
    # 名簿そのものの書き込み見送りは「上書きの見送り」ではないので含めない。
    local deferred_count=0

    local src_file agent_name owner_skill managed
    for src_file in "$agents_src"/*.md; do
        [[ -f "$src_file" ]] || continue
        agent_name="$(basename "$src_file")"
        owner_skill="$(agent_owner_skill "$src_file")"
        if [[ -n "$owner_skill" ]] && is_disabled_skill "$owner_skill"; then
            continue
        fi

        managed=false
        for old_agent in ${old_agents[@]+"${old_agents[@]}"}; do
            [[ "$old_agent" == "$agent_name" ]] && managed=true && break
        done
        if [[ -e "$agents_dest/$agent_name" ]] || [[ -L "$agents_dest/$agent_name" ]]; then
            if [[ ! -f "$agents_dest/$agent_name" ]] || [[ -L "$agents_dest/$agent_name" ]]; then
                echo "  ⚠ $agents_dest/$agent_name は通常ファイルではないため変更しませんでした" >&2
                record_skip "$agents_dest/$agent_name" "通常ファイルではない"
                deferred_count=$((deferred_count + 1))
                # 今回書き込めなくても、既存の管理対象なら所有権を手放さず次回の更新対象に残す。
                [[ "$managed" == true ]] && current_agents+=("$agent_name")
                continue
            fi
            if [[ "$managed" == false ]]; then
                # 名簿に無い既存ファイルでも、中身が配布後の最終形と一致するなら vk-agents の
                # 配布物と判断して管理対象へ戻す（名簿を失った状態からの自己修復）。
                # 上書きしても何も変わらない＝配れなかった項目ではないので、部分成功（exit 2）の
                # 理由にはせず record_skip も呼ばない。比較のための生成はこの分岐だけで行うため、
                # 通常の管理対象ファイルには余分なコストがかからない。
                if distributed_content_matches agent "$mode" "$src_file" "$agents_dest/$agent_name" \
                    "$escaped_repo_root" "$escaped_rules_dir" "$escaped_home_skills"; then
                    self_healed_count=$((self_healed_count + 1))
                    # 名簿が読めない回は記録し直せないので「戻しました」とは言わず、件数だけを
                    # 名簿の警告ブロックへ渡す（次回も同じ照合が走ることの理由になる）。
                    if [[ "$manifest_is_safe" == true ]]; then
                        report_self_healed_file "$agents_dest/$agent_name"
                        current_agents+=("$agent_name")
                    fi
                    continue
                fi
                # 管理名簿が読めない回は管理対象リストが空になるため、vk-agents 自身が配った
                # ファイルまでここに来る。その状態で退避・削除を促すと正規の配布物を消させてしまう。
                # 最後にまとめて出るスキップ一覧だけを見た人が誤解しないよう、記録する理由も分ける。
                if [[ "$manifest_is_safe" == true ]]; then
                    warn_content_mismatch "$agents_dest/$agent_name"
                    record_skip "$agents_dest/$agent_name" "中身が配布内容と異なる"
                else
                    unowned_agents+=("$agents_dest/$agent_name")
                    record_skip "$agents_dest/$agent_name" "管理名簿が読めず持ち主を判定できない"
                fi
                deferred_count=$((deferred_count + 1))
                continue
            fi
        fi

        if [[ "$mode" == "global-agent" ]]; then
            rewrite_md_paths "$mode" "$src_file" "$agents_dest/$agent_name" \
                "$escaped_repo_root" "$escaped_rules_dir" "$escaped_home_skills"
            strip_owner_skill "$agents_dest/$agent_name"
            echo "  → ~/.claude/agents/$agent_name をインストールしました"
        else
            rewrite_md_paths "$mode" "$src_file" "$agents_dest/$agent_name" "$escaped_repo_root"
            strip_owner_skill "$agents_dest/$agent_name"
            echo "  → .claude/agents/$agent_name をインストールしました"
        fi
        current_agents+=("$agent_name")
    done

    # 保留していた名簿の警告をここで出す。上書きの見送りか、記録し直せなかった一致があった回は、
    # 原因も対処も含む詳しい案内に差し替える（同じ名簿について同じことを2回言わない）。
    if [[ ${#unowned_agents[@]} -gt 0 ]] \
        || { [[ "$manifest_is_safe" == false ]] && [[ "$self_healed_count" -gt 0 ]]; }; then
        warn_unreadable_manifest_conflicts "$manifest_file" "$self_healed_count" \
            ${unowned_agents[@]+"${unowned_agents[@]}"}
    elif [[ "$manifest_is_safe" == false ]]; then
        warn_unreadable_manifest "$manifest_file"
    fi

    if [[ "$manifest_is_safe" == true ]] && [[ -f "$manifest_file" ]]; then
        for old_agent in ${old_agents[@]+"${old_agents[@]}"}; do
            local found=false
            for agent_name in ${current_agents[@]+"${current_agents[@]}"}; do
                [[ "$agent_name" == "$old_agent" ]] && found=true && break
            done
            if [[ "$found" == false ]] && [[ -f "$agents_dest/$old_agent" ]] && [[ ! -L "$agents_dest/$old_agent" ]]; then
                rm -f "$agents_dest/$old_agent"
                echo "  → $agents_dest/$old_agent を削除しました（廃止または無効化された定義）"
            fi
        done
    fi

    if [[ "$manifest_is_safe" == true ]]; then
        if [[ ${#current_agents[@]} -gt 0 ]]; then
            printf '%s\n' "${current_agents[@]}" > "$manifest_file"
        else
            : > "$manifest_file"
        fi
        echo "  → $manifest_file を更新しました"
        # 名簿へ記録し直したことを伝えるので、実際に名簿を書けた回だけ出す。
        [[ "$self_healed_count" -gt 0 ]] && report_self_healed_summary "$self_healed_count"
    fi

    [[ "$deferred_count" -gt 0 ]] && report_deferred_pointer "$deferred_count"
    return 0
}

# 旧配布先の管理ファイルだけを削除する一度きりの移行処理。
# マニフェストに載っていない利用者ファイルと通常ファイル以外は変更せず、警告して残す。
# 移行完了後に旧配布先が十分に無くなった時点で、この関数と呼び出しを削除できる。
cleanup_legacy_personas() {
    local legacy_dest="$1"
    local manifest_file="$legacy_dest/.agent-skills-manifest"
    [[ -e "$legacy_dest" ]] || [[ -L "$legacy_dest" ]] || return 0

    # vk-agents が作る親階層が symlink の場合、リンク先を旧配布先として削除しない。
    local legacy_parent
    legacy_parent="$(dirname "$legacy_dest")"
    if [[ -L "$legacy_parent" ]]; then
        echo "  ⚠ $legacy_parent は symlink のため旧配布先の掃除をスキップしました" >&2
        return 0
    fi

    if [[ ! -d "$legacy_dest" ]] || [[ -L "$legacy_dest" ]]; then
        echo "  ⚠ 旧人格ファイル配布先 $legacy_dest は通常ディレクトリではないため変更しませんでした" >&2
        return 0
    fi
    if [[ ! -f "$manifest_file" ]] || [[ -L "$manifest_file" ]]; then
        echo "  ⚠ 旧人格ファイル配布先 $legacy_dest に通常ファイルの管理マニフェストがないため変更しませんでした" >&2
        return 0
    fi

    local legacy_persona
    local unhandled=false
    while IFS= read -r legacy_persona; do
        [[ -z "$legacy_persona" ]] && continue
        # マニフェストを手動編集されても旧配布先の外を削除しないよう、ファイル名だけを受け付ける。
        [[ "$legacy_persona" == */* ]] && continue
        [[ "$legacy_persona" == "." || "$legacy_persona" == ".." ]] && continue
        if [[ -f "$legacy_dest/$legacy_persona" ]] && [[ ! -L "$legacy_dest/$legacy_persona" ]]; then
            rm -f "$legacy_dest/$legacy_persona"
            echo "  → $legacy_dest/$legacy_persona を削除しました（旧配布先の管理ファイル）"
        elif [[ -e "$legacy_dest/$legacy_persona" ]] || [[ -L "$legacy_dest/$legacy_persona" ]]; then
            unhandled=true
            echo "  ⚠ $legacy_dest/$legacy_persona は通常ファイルではないため変更しませんでした" >&2
        fi
    done < "$manifest_file"

    if [[ "$unhandled" == true ]]; then
        echo "  ⚠ 旧配布先 $legacy_dest に処理できないファイルが残っているため管理マニフェストを残しました" >&2
        return 0
    fi
    rm -f "$manifest_file"

    if rmdir "$legacy_dest" 2>/dev/null; then
        echo "  → 旧人格ファイル配布先 $legacy_dest を削除しました"
        rmdir "$(dirname "$legacy_dest")" 2>/dev/null || true
    else
        echo "  ⚠ 旧人格ファイル配布先 $legacy_dest に利用者ファイルがあるためディレクトリを残しました" >&2
    fi
}

# 人格ファイル（vk-agents-personas/*.md）を配布する。
#
# 配布先を ~/.claude/agents/ にしないのは、Claude Code が ~/.claude/agents/ 配下を
# エージェント定義として解釈するため。人格ファイルは frontmatter を持たないので、
# エージェント定義の探索に混ぜない専用ディレクトリ（~/.claude/vk-agents-personas/）へ置く。
# 配布先は agents/ と同じくフラットに保ち、旧マニフェストに載るファイルだけを管理対象とする。
sync_personas() {
    local personas_src="$SCRIPT_DIR/../vk-agents-personas"
    local personas_dest="$1"
    local mode="$2"
    local managed_root="$3"
    [[ -d "$personas_src" ]] || return 0
    prepare_distribution_directory "$personas_dest" "$managed_root" || return 0

    local escaped_rules_dir escaped_repo_root
    escaped_rules_dir=$(printf '%s' "$RULES_DIR" | sed 's/[\\#&]/\\&/g')
    escaped_repo_root=$(printf '%s' "$(cd "$SCRIPT_DIR/.." && pwd)" | sed 's/[\\#&]/\\&/g')

    local manifest_file="$personas_dest/.agent-skills-manifest"
    local old_personas=()
    local current_personas=()
    local old_persona
    local manifest_is_safe=false
    # sync_agents と同じく、名簿の警告は配布処理の最後にまとめて出すためここでは保留する。
    if guard_distribution_manifest "$manifest_file" quiet; then
        manifest_is_safe=true
    fi
    if [[ "$manifest_is_safe" == true ]] && [[ -f "$manifest_file" ]]; then
        while IFS= read -r old_persona; do
            [[ -z "$old_persona" ]] && continue
            # マニフェストを手動編集されても配布先の外を削除しないよう、ファイル名だけを受け付ける。
            [[ "$old_persona" == */* ]] && continue
            [[ "$old_persona" == "." || "$old_persona" == ".." ]] && continue
            old_personas+=("$old_persona")
        done < "$manifest_file"
    fi

    # sync_agents と同じく、管理名簿が読めない回の見送り分はループ後にまとめて案内する。
    local unowned_personas=()
    # sync_agents と同じく、管理対象へ戻した件数と上書きを見送った件数を数える。
    local self_healed_count=0
    local deferred_count=0

    local src_file persona_name managed
    for src_file in "$personas_src"/*.md; do
        [[ -f "$src_file" ]] || continue
        persona_name="$(basename "$src_file")"

        managed=false
        for old_persona in ${old_personas[@]+"${old_personas[@]}"}; do
            [[ "$old_persona" == "$persona_name" ]] && managed=true && break
        done
        if [[ -e "$personas_dest/$persona_name" ]] || [[ -L "$personas_dest/$persona_name" ]]; then
            if [[ ! -f "$personas_dest/$persona_name" ]] || [[ -L "$personas_dest/$persona_name" ]]; then
                echo "  ⚠ $personas_dest/$persona_name は通常ファイルではないため変更しませんでした" >&2
                record_skip "$personas_dest/$persona_name" "通常ファイルではない"
                deferred_count=$((deferred_count + 1))
                [[ "$managed" == true ]] && current_personas+=("$persona_name")
                continue
            fi
            if [[ "$managed" == false ]]; then
                # sync_agents と同じく、中身が配布後の最終形と一致するなら配布物と判断して
                # 管理対象へ戻す（人格ファイルは owner_skill を持たないためパス書き換えだけで比較）。
                if distributed_content_matches persona "$mode" "$src_file" "$personas_dest/$persona_name" \
                    "$escaped_repo_root" "$escaped_rules_dir"; then
                    self_healed_count=$((self_healed_count + 1))
                    if [[ "$manifest_is_safe" == true ]]; then
                        report_self_healed_file "$personas_dest/$persona_name"
                        current_personas+=("$persona_name")
                    fi
                    continue
                fi
                # sync_agents と同じ理由で、管理名簿が読めない回は削除を促す文面を出さず、
                # スキップ一覧に残す理由も分ける。
                if [[ "$manifest_is_safe" == true ]]; then
                    warn_content_mismatch "$personas_dest/$persona_name"
                    record_skip "$personas_dest/$persona_name" "中身が配布内容と異なる"
                else
                    unowned_personas+=("$personas_dest/$persona_name")
                    record_skip "$personas_dest/$persona_name" "管理名簿が読めず持ち主を判定できない"
                fi
                deferred_count=$((deferred_count + 1))
                continue
            fi
        fi

        # 人格ファイル内の rules/ 参照を配布形態に合わせて絶対パス（--claude-global）または
        # プロジェクト相対パス（--target）へ書き換える。
        rewrite_md_paths "$mode" "$src_file" "$personas_dest/$persona_name" \
            "$escaped_repo_root" "$escaped_rules_dir"
        echo "  → $personas_dest/$persona_name をインストールしました"
        current_personas+=("$persona_name")
    done

    if [[ ${#unowned_personas[@]} -gt 0 ]] \
        || { [[ "$manifest_is_safe" == false ]] && [[ "$self_healed_count" -gt 0 ]]; }; then
        warn_unreadable_manifest_conflicts "$manifest_file" "$self_healed_count" \
            ${unowned_personas[@]+"${unowned_personas[@]}"}
    elif [[ "$manifest_is_safe" == false ]]; then
        warn_unreadable_manifest "$manifest_file"
    fi

    if [[ "$manifest_is_safe" == true ]] && [[ -f "$manifest_file" ]]; then
        for old_persona in ${old_personas[@]+"${old_personas[@]}"}; do
            local found=false
            for persona_name in ${current_personas[@]+"${current_personas[@]}"}; do
                [[ "$persona_name" == "$old_persona" ]] && found=true && break
            done
            if [[ "$found" == false ]] && [[ -f "$personas_dest/$old_persona" ]] && [[ ! -L "$personas_dest/$old_persona" ]]; then
                rm -f "$personas_dest/$old_persona"
                echo "  → $personas_dest/$old_persona を削除しました（廃止された人格ファイル）"
            fi
        done
    fi

    if [[ "$manifest_is_safe" == true ]]; then
        if [[ ${#current_personas[@]} -gt 0 ]]; then
            printf '%s\n' "${current_personas[@]}" > "$manifest_file"
        else
            : > "$manifest_file"
        fi
        echo "  → $manifest_file を更新しました"
        [[ "$self_healed_count" -gt 0 ]] && report_self_healed_summary "$self_healed_count"
    fi

    [[ "$deferred_count" -gt 0 ]] && report_deferred_pointer "$deferred_count"
    return 0
}

# 前提条件（硬ゲート）のブロッククォートを配布先の SKILL.md 先頭へ挿入する。
# #188 以降、repository-access.md を参照するスキルは自前で硬/軟ゲートを宣言するため、
# 宣言なしのスキルにだけ org.allowed_owners 参照の汎用ガードを入れる。
insert_repository_access_guard() {
    local src_file="$1"
    local dst_file="$2"
    [[ "$(basename "$src_file")" == "SKILL.md" ]] || return 0
    if grep -q 'repository-access\.md' "$src_file"; then
        return 0
    fi
    local tmp
    tmp=$(mktemp)
    {
        cat <<GUARD
> **前提条件（硬ゲート）:** このスキルは、対象リポジトリの owner が許可リスト \`org.allowed_owners\`（\`~/.vk-agents/config.json\`）に含まれる場合のみ使用できます。判定手順は \`${RULES_DIR}/repository-access.md\` を参照してください（許可リスト未設定時は確認のうえ続行可）。

GUARD
        cat "$dst_file"
    } > "$tmp"
    # strip_owner_skill と同じ理由で mv は使わない（mktemp の 0600 が配布物に残るため）。
    # 書き込み先も同様に、直前に rewrite_md_paths が作ったばかりの配布物だけなので、
    # 書き戻し単体の原子性を失っても利用者のファイルを壊さない（詳細は strip_owner_skill のコメント）。
    cat "$tmp" > "$dst_file"
    rm -f "$tmp"
}

# 旧スキルの移行削除を見送ったときの警告。あとから検証・復旧できるよう絶対パスで出し、
# 次の行にそのままコピーできる手動削除コマンドを添える。
warn_legacy_skill_kept() {
    local legacy_dir="$1"
    echo "  ⚠ $legacy_dir は vk-agents が配布した旧スキルと確認できないため削除しませんでした（利用者のディレクトリの可能性）" >&2
    echo "    不要な場合は手動で削除してください: rm -rf '$legacy_dir'" >&2
    SKILLS_DEFERRED_COUNT=$((SKILLS_DEFERRED_COUNT + 1))
}

# 名簿方式の導入前に配布された旧スキルディレクトリを一度きり掃除する移行処理。
#
# 旧 staff-* 5件と旧 _shared（現 vk-shared）は、配布先に管理名簿が無かった時代に配布された
# ため、通常の削除ループ（名簿に載っていて今回のソースに無いものを消す）では拾えない。
# 名簿がまだ無い実行に限り、vk-agents が配布した証拠（指紋）を持つものだけを削除する。
# 指紋を持たない同名ディレクトリは利用者のものとして残し、手動削除を案内する。
#
# ★一時コード★ 名簿は初回 sync で必ず作られるため、各配布先で一度 sync すれば以後この関数は
# 何も削除しない。移行が行き渡った時点（目安: 数リリース後）に、この関数・warn_legacy_skill_kept・
# LEGACY_SKILL_DIRS と呼び出しをまとめて削除してよい。
cleanup_legacy_skills() {
    local skills_dest="$1"
    local name legacy_dir skill_md
    for name in $LEGACY_SKILL_DIRS _shared; do
        legacy_dir="$skills_dest/$name"
        # 不在・symlink・通常ディレクトリ以外は対象にしない（リンク先を消さない）。
        [[ -e "$legacy_dir" ]] || [[ -L "$legacy_dir" ]] || continue
        if [[ ! -d "$legacy_dir" ]] || [[ -L "$legacy_dir" ]]; then
            warn_legacy_skill_kept "$legacy_dir"
            continue
        fi

        if [[ "$name" == "_shared" ]]; then
            # 旧 _shared は SKILL.md を持たず codex-launch.md だけを持つ構成だった。
            if [[ ! -f "$legacy_dir/codex-launch.md" ]] || [[ -L "$legacy_dir/codex-launch.md" ]] \
                || [[ -e "$legacy_dir/SKILL.md" ]] || [[ -L "$legacy_dir/SKILL.md" ]]; then
                warn_legacy_skill_kept "$legacy_dir"
                continue
            fi
        else
            # 旧 staff-* は SKILL.md と persona.md を持ち、SKILL.md には配布時のパス書き換えを
            # 通らないと生まれない .claude/skills/<ディレクトリ名>/persona.md の記述がある。
            skill_md="$legacy_dir/SKILL.md"
            if [[ ! -f "$skill_md" ]] || [[ -L "$skill_md" ]] \
                || [[ ! -f "$legacy_dir/persona.md" ]] || [[ -L "$legacy_dir/persona.md" ]]; then
                warn_legacy_skill_kept "$legacy_dir"
                continue
            fi
            if ! grep -qF ".claude/skills/$name/persona.md" "$skill_md"; then
                warn_legacy_skill_kept "$legacy_dir"
                continue
            fi
        fi

        rm -rf "${skills_dest:?}/$name"
        echo "  → $legacy_dir/ を削除しました（管理名簿の導入前に配布された旧スキル）"
        SKILLS_REMOVED_COUNT=$((SKILLS_REMOVED_COUNT + 1))
    done
}

# スキルを配布先へ展開する（--target / --claude-global 共通）。
#
# mode による差分は次の2点だけで、管理名簿の読み書きと削除判定は完全に共通:
#   target       … Markdown をプロジェクト相対パスへ書き換える
#   global-skill … Markdown を絶対パスへ書き換え、宣言なしスキルへ前提条件ガードを挿入する
#
# 配布先の管理名簿には、この実行で vk-agents が配布したスキル名だけを書き出す。次回は
# 「名簿に載っていて今回のソースに無い名前」だけを削除対象として走査するため、利用者が
# 自分で置いたスキルには触れない。
#
# ソースにあるスキルは、配布先に既存があっても常に上書きする。agents/ や vk-agents-personas/ の
# 「名簿外は上書きしない」保護をスキルへ適用すると、名簿を持たない既存プロジェクトの全スキルが
# 利用者所有と判定され、以後永久に更新されなくなるため。名簿は削除判定にだけ使う。
sync_skills() {
    local skills_dest="$1"
    local mode="$2"
    local managed_root="$3"
    local skills_src="$SCRIPT_DIR/../skills"

    SKILLS_INSTALLED_COUNT=0
    SKILLS_REMOVED_COUNT=0
    SKILLS_DEFERRED_COUNT=0

    [[ -d "$skills_src" ]] || return 0

    # 出力用の表示パス。インストール行は従来どおりの短い表記、削除・警告は絶対パスで出す
    # （複数プロジェクトへ連続実行したときに、どの配布先の行なのかを見失わないため）。
    local display_dir
    case "$mode" in
        target) display_dir=".claude/skills" ;;
        global-skill) display_dir="~/.claude/skills" ;;
        *)
            echo "エラー: 未対応のスキル配布 mode です: $mode" >&2
            return 1
            ;;
    esac

    # 配布先とその親（管理ルートまで）に symlink が無いことを確認してから作成する。
    prepare_distribution_directory "$skills_dest" "$managed_root" || return 0

    local escaped_rules_dir escaped_repo_root
    escaped_rules_dir=$(printf '%s' "$RULES_DIR" | sed 's/[\\#&]/\\&/g')
    escaped_repo_root=$(printf '%s' "$(cd "$SCRIPT_DIR/.." && pwd)" | sed 's/[\\#&]/\\&/g')

    local manifest_file="$skills_dest/$MANIFEST_NAME"
    local manifest_is_safe=false
    local manifest_existed=false
    local old_skills=()
    local current_skills=()
    local old_skill
    if guard_distribution_manifest "$manifest_file"; then
        manifest_is_safe=true
    fi
    # 通常ファイル以外でも「名簿がある実行」として扱う。移行削除は名簿の無い初回だけに限りたいので、
    # 読めない名簿を理由に毎回移行削除を走らせない。
    if [[ -e "$manifest_file" ]] || [[ -L "$manifest_file" ]]; then
        manifest_existed=true
    fi
    if [[ "$manifest_is_safe" == true ]] && [[ -f "$manifest_file" ]]; then
        while IFS= read -r old_skill; do
            [[ -z "$old_skill" ]] && continue
            # 名簿を手編集されても skills/ の外を削除しないよう、ディレクトリ名だけを受け付ける。
            [[ "$old_skill" == */* ]] && continue
            [[ "$old_skill" == "." || "$old_skill" == ".." ]] && continue
            old_skills+=("$old_skill")
        done < "$manifest_file"
    fi

    # 名簿がまだ無い実行のときだけ、名簿導入前に配布された旧スキルの残骸を掃除する（一度きり）。
    if [[ "$manifest_existed" == false ]]; then
        cleanup_legacy_skills "$skills_dest"
    fi

    local skill_dir skill_name dest_dir rel_path src_file
    for skill_dir in "$skills_src"/*/; do
        [[ -d "$skill_dir" ]] || continue
        skill_name="$(basename "$skill_dir")"
        # vk-sync-skills は vk-agents リポジトリ固有（config/・scripts/ を参照）のためプロジェクトには配らない。
        if [[ "$mode" == "target" ]] && [[ "$skill_name" == "vk-sync-skills" ]]; then
            continue
        fi
        # skills.disabled のスキルは配布しない。current_skills に入れないことで、前回配布済みなら
        # 下の削除ループで配布先からも消える。
        is_disabled_skill "$skill_name" && continue

        dest_dir="$skills_dest/$skill_name"
        if { [[ -e "$dest_dir" ]] || [[ -L "$dest_dir" ]]; } \
            && { [[ ! -d "$dest_dir" ]] || [[ -L "$dest_dir" ]]; }; then
            echo "  ⚠ $dest_dir は通常ディレクトリではないため $skill_name を更新できませんでした" >&2
            echo "    退避または削除してから再実行してください: rm -rf '$dest_dir'" >&2
            record_skip "$dest_dir" "通常ディレクトリではない"
            # 今回書き込めなくても管理対象の所有権は手放さない（名簿から外すと次回「利用者のもの」と
            # 誤認され、永久に更新・削除の対象外になる）。
            current_skills+=("$skill_name")
            SKILLS_DEFERRED_COUNT=$((SKILLS_DEFERRED_COUNT + 1))
            continue
        fi

        mkdir -p "$dest_dir"
        while IFS= read -r -d '' src_file; do
            rel_path="${src_file#"$skill_dir"}"
            # スキル配下のファイル・サブディレクトリが symlink になっている場合は書き込まない。
            if ! skill_entry_is_safe "$dest_dir" "$rel_path"; then
                SKILLS_DEFERRED_COUNT=$((SKILLS_DEFERRED_COUNT + 1))
                continue
            fi
            mkdir -p "$(dirname "$dest_dir/$rel_path")"
            if [[ "$src_file" == *.md ]]; then
                # rules/ と vendor/ は参照の先頭（行頭・非単語かつ非スラッシュ文字の直後）にある
                # 時だけ置換する。REPO_ROOT/rules/・$VK_AGENTS_DIR/rules/・**/rules/ や myvendor/ の
                # ように / や単語文字の直後にある同名部分を巻き込むと二重置換・誤置換になるため
                # 境界でアンカーする。REPO_ROOT/ は rewrite_md_paths 内で別途置換する。
                rewrite_md_paths "$mode" "$src_file" "$dest_dir/$rel_path" \
                    "$escaped_repo_root" "$escaped_rules_dir"
                if [[ "$mode" == "global-skill" ]]; then
                    insert_repository_access_guard "$src_file" "$dest_dir/$rel_path"
                fi
            else
                cp "$src_file" "$dest_dir/$rel_path"
            fi
        done < <(find "$skill_dir" -type f -print0)
        echo "  → $display_dir/$skill_name/ をインストールしました"
        current_skills+=("$skill_name")
        SKILLS_INSTALLED_COUNT=$((SKILLS_INSTALLED_COUNT + 1))
    done

    # 前回の名簿に載っていて今回のソースに無い（＝廃止・改名・無効化された）スキルだけを削除する。
    # 走査対象は名簿に列挙された名前だけで、配布先ディレクトリ全体は見ない。
    if [[ "$manifest_is_safe" == true ]]; then
        local found current_name protected never_remove
        for old_skill in ${old_skills[@]+"${old_skills[@]}"}; do
            found=false
            for current_name in ${current_skills[@]+"${current_skills[@]}"}; do
                [[ "$current_name" == "$old_skill" ]] && found=true && break
            done
            [[ "$found" == true ]] && continue
            # ルール集と WordPress 公式スキルの展開先は名簿の管理対象外。名簿が壊れて名前が
            # 混入しても、同じ実行でコピーしたばかりの内容を消さないよう固定除外する。
            # 名簿の値をパターンとして解釈しないよう、部分一致ではなく完全一致で判定する。
            protected=false
            for never_remove in $SKILLS_NEVER_REMOVE; do
                [[ "$never_remove" == "$old_skill" ]] && protected=true && break
            done
            [[ "$protected" == true ]] && continue
            if [[ -d "$skills_dest/$old_skill" ]] && [[ ! -L "$skills_dest/$old_skill" ]]; then
                rm -rf "${skills_dest:?}/$old_skill"
                echo "  → $skills_dest/$old_skill/ を削除しました（廃止または無効化されたスキル）"
                SKILLS_REMOVED_COUNT=$((SKILLS_REMOVED_COUNT + 1))
            elif [[ -e "$skills_dest/$old_skill" ]] || [[ -L "$skills_dest/$old_skill" ]]; then
                # 配布対象外になった名前なので所有権は手放し、名簿には残さない。
                echo "  ⚠ $skills_dest/$old_skill は通常ディレクトリではないため削除しませんでした（以後 vk-agents の管理対象から外れます）" >&2
                echo "    不要な場合は手動で削除してください: rm -rf '$skills_dest/$old_skill'" >&2
                SKILLS_DEFERRED_COUNT=$((SKILLS_DEFERRED_COUNT + 1))
            fi
        done
    fi

    if [[ "$manifest_is_safe" == true ]]; then
        if [[ ${#current_skills[@]} -gt 0 ]]; then
            printf '%s\n' "${current_skills[@]}" > "$manifest_file"
        else
            : > "$manifest_file"
        fi
        if [[ "$manifest_existed" == true ]]; then
            echo "  → $display_dir/$MANIFEST_NAME を更新しました"
        else
            echo "  → $display_dir/$MANIFEST_NAME を作成しました（次回以降、ここに載ったスキルだけが削除対象になります）"
        fi
    fi

    # 見送りの警告は標準エラー出力に出るため、標準出力だけを見る呼び出し側には件数しか残らない。
    # どこを見れば理由が分かるかを標準出力側にも1行だけ添える。
    if [[ "$SKILLS_DEFERRED_COUNT" -gt 0 ]]; then
        echo "  ※ 見送り ${SKILLS_DEFERRED_COUNT} 件の詳細は上の ⚠ 行（標準エラー出力）を確認してください"
    fi
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
        # .claude/ 配下は vk-agents の管理ルートなので symlink 検査を通す。
        # .cursor/ ・ .codex/ は管理ルートの規約外のため従来どおり作成する。
        if [[ "$tool_dir" == "$target/.claude/"* ]]; then
            prepare_distribution_directory "$tool_dir" "$target/.claude" || continue
        else
            mkdir -p "$tool_dir"
        fi
        for item in "$wp_skills_dir"/*/; do
            # skills/ が空だと glob が展開されずリテラルのままになるためスキップ
            [[ -d "$item" ]] || continue
            cp -r "$item" "$tool_dir/"
        done
        echo "  → ${tool_dir#"$target"/}/ に WordPress スキルを展開しました"
    done
}

# プロジェクトへの展開
sync_to_project() {
    local target="$1"
    # この配布処理でスキップが起きたかを完了行に出すため、開始時点の件数を控える。
    # 利用者が最初に読む行が「完了しました」と断定のままでは、終了コード 2 を見ない限り
    # 一部が配られていないことに気づけない。
    local skips_before=${#SKIPPED_ITEMS[@]}

    if [[ ! -d "$target" ]]; then
        echo "エラー: ディレクトリが存在しません: $target"
        exit 1
    fi

    local start_marker="<!-- agent-skills:start -->"
    local end_marker="<!-- agent-skills:end -->"

    echo "展開先: $target"

    # WordPress公式スキルを先に展開（自社ルールが後から上書きして優先される）
    if [[ "$WORDPRESS" == true ]]; then
        install_wordpress_skills "$target"
    fi

    # .claude/ 配下は vk-agents の管理ルート。ルール集の展開先も symlink 検査を通す
    # （ここが素通りだと .claude/skills 自体を symlink にされたとき、sync_skills の
    # 検査より先にリンク先へ書き込んでしまい保護が成立しない）。
    if prepare_distribution_directory "$target/.claude/skills/agent-skills" "$target/.claude"; then
        copy_rules "$target/.claude/skills/agent-skills"
        echo "  → .claude/skills/agent-skills/ にルール集を展開しました"
    fi

    copy_rules "$target/.cursor/rules/agent-skills"
    echo "  → .cursor/rules/agent-skills/ にルール集を展開しました"

    copy_rules "$target/.codex/skills/agent-skills"
    echo "  → .codex/skills/agent-skills/ にルール集を展開しました"

    # スキルをプロジェクトに展開（Claude Code のみ）。
    # 配布したスキル名は .claude/skills/.agent-skills-manifest に記録し、次回以降は
    # そこに載っていて今回のソースに無いものだけを削除する。
    sync_skills "$target/.claude/skills" "target" "$target/.claude"

    # 人格ファイルとエージェント定義をプロジェクトに展開（Claude Code のみ）。
    # エージェント定義は人格ファイルの配布先を指すため、人格ファイルを先に配布する。
    cleanup_legacy_personas "$target/.claude/vk-agents/personas"
    sync_personas "$target/.claude/vk-agents-personas" "target" "$target/.claude"
    sync_agents "$target/.claude/agents" "target" "$target/.claude"

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
        echo "  → .github/copilot-instructions.md を作成しました"
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
        echo "  → .github/copilot-instructions.md のマーカーセクションを更新しました"
    else
        # ファイルはあるがマーカーがない → 末尾に追記
        {
            echo ""
            echo "$start_marker"
            echo "$content"
            echo "$end_marker"
        } >> "$copilot_md"
        echo "  → .github/copilot-instructions.md にマーカーセクションを追記しました"
    fi

    if [[ ${#SKIPPED_ITEMS[@]} -gt "$skips_before" ]]; then
        echo "完了（一部スキップあり）: $target への展開のうち一部をスキップしました（スキル: インストール ${SKILLS_INSTALLED_COUNT} / 削除 ${SKILLS_REMOVED_COUNT} / 見送り ${SKILLS_DEFERRED_COUNT}）"
    else
        echo "完了: $target への展開が完了しました（スキル: インストール ${SKILLS_INSTALLED_COUNT} / 削除 ${SKILLS_REMOVED_COUNT} / 見送り ${SKILLS_DEFERRED_COUNT}）"
    fi
}

# グローバルClaude設定の更新
sync_claude_global() {
    local claude_md="$HOME/.claude/CLAUDE.md"
    local start_marker="<!-- agent-skills:start -->"
    local end_marker="<!-- agent-skills:end -->"
    # sync_to_project と同じく、この配布処理でスキップが起きたかを完了行に出す。
    local skips_before=${#SKIPPED_ITEMS[@]}

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

    # 書き込む前に、配布先が symlink か通常ファイル以外かを判定する。
    # 壊れた symlink（リンク先が無いリンク）は -f が false になるため、判定より先に
    # 「新規作成」で書き込むとリンクを辿って ~/.claude の外へファイルを作ってしまう。
    local update_claude_md=true
    local claude_md_is_symlink=false
    if [[ -L "$claude_md" ]]; then
        if [[ ! -f "$claude_md" ]]; then
            echo "  ⚠ $claude_md は通常ファイルではないため変更しませんでした" >&2
            record_skip "$claude_md" "通常ファイルではない"
            update_claude_md=false
        else
            claude_md_is_symlink=true
        fi
    elif [[ -e "$claude_md" ]] && [[ ! -f "$claude_md" ]]; then
        echo "  ⚠ $claude_md は通常ファイルではないため変更しませんでした" >&2
        record_skip "$claude_md" "通常ファイルではない"
        update_claude_md=false
    fi

    if [[ "$update_claude_md" != true ]]; then
        : # 上で警告済み。CLAUDE.md への書き込みは行わない。

    elif [[ ! -f "$claude_md" ]]; then
        # ファイル新規作成（ここへ来るのは symlink でもなく実体も無い場合だけ）
        # 書き込みの成否を見ずに成功メッセージを出すと、1バイトも書けていないのに
        # 「ルール節が入った」と利用者に信じさせてしまうため、必ず分岐する。
        if {
            echo "$start_marker"
            echo ""
            echo "$content"
            echo ""
            echo "$end_marker"
        } > "$claude_md"; then
            echo "  → $claude_md を新規作成しました"
        else
            echo "  ⚠ $claude_md を作成できませんでした（上記のエラー内容を確認してください）" >&2
            record_skip "$claude_md" "新規作成に失敗"
        fi

    elif grep -qF "$start_marker" "$claude_md"; then
        # 既存セクションを更新
        local tmp
        tmp=$(mktemp)
        if CONTENT="$content" \
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
        then
            if [[ "$claude_md_is_symlink" == true ]]; then
                # mv だとリンクが通常ファイルに置き換わり、以降 dotfiles 等のリンク先へ
                # 反映されなくなる。リンクは保持したままリンク先の実体を更新する。
                if cat "$tmp" > "$claude_md"; then
                    rm -f "$tmp"
                    echo "  → 既存セクションを更新しました"
                else
                    # リンク先へ書き込む形のため、書き込み途中で失敗するとリンク先が
                    # 空または途中までの内容になりうる。「元の内容を保持」とは言えない。
                    rm -f "$tmp"
                    echo "  ⚠ $claude_md のリンク先を更新できませんでした。内容が壊れている可能性があるため中身を確認してください（上記のエラー内容も確認してください）" >&2
                    record_skip "$claude_md" "リンク先の書き込みに失敗"
                fi
            else
                # mv も失敗しうる（読み取り専用ディレクトリ等）。無ガードだと set -e で
                # 即中断し、それまでに積んだスキップ一覧が出ないまま exit 1 になるため分岐する。
                if mv "$tmp" "$claude_md"; then
                    echo "  → 既存セクションを更新しました"
                else
                    rm -f "$tmp"
                    echo "  ⚠ $claude_md を更新できませんでした。元の内容を保持して続行します（上記のエラー内容を確認してください）" >&2
                    record_skip "$claude_md" "更新に失敗"
                fi
            fi
        else
            # python3 が無い（127）、CLAUDE.md が読めない、非 UTF-8 で読み込めない、
            # 想定外の内部エラー — いずれもルール節を配れていないため終了コードに出す。
            rm -f "$tmp"
            echo "  ⚠ $claude_md を更新できませんでした。元の内容を保持して続行します（上記のエラー内容を確認してください）" >&2
            record_skip "$claude_md" "更新に失敗"
        fi

    else
        # ファイル末尾に追記（symlink の場合もリンクを保持したままリンク先へ追記される）
        # 新規作成と同じく、書き込めなかった回に成功メッセージを出さない。
        if {
            echo ""
            echo "$start_marker"
            echo ""
            echo "$content"
            echo ""
            echo "$end_marker"
        } >> "$claude_md"; then
            echo "  → セクションを追記しました"
        else
            echo "  ⚠ $claude_md に追記できませんでした（上記のエラー内容を確認してください）" >&2
            record_skip "$claude_md" "追記に失敗"
        fi
    fi

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
            # 書き込む前に展開先の種類を判定する。壊れた symlink は -f が false になるため、
            # 判定せず cp するとリンクを辿って ~/.claude の外へファイルを作ってしまう。
            # 通常ファイル以外（ディレクトリ等）も cp が中へ書き込むため触らない。
            if { [[ -L "$vk_settings_dest" ]] || [[ -e "$vk_settings_dest" ]]; } && [[ ! -f "$vk_settings_dest" ]]; then
                echo "  ⚠ ${vk_settings_dest} は通常ファイルではないため更新しませんでした" >&2
                record_skip "$vk_settings_dest" "通常ファイルではない"
            elif cp "$vk_settings_personal" "$vk_settings_dest"; then
                # 正常な symlink は cp がリンクを辿るため、リンクは保持されリンク先の実体が更新される。
                echo "  → ${vk_settings_dest} を更新しました（元: ${vk_settings_personal}）"
            else
                echo "  ⚠ ${vk_settings_dest} を更新できませんでした（上記のエラー内容を確認してください）" >&2
                record_skip "$vk_settings_dest" "書き込みに失敗"
            fi
        else
            echo "  ⚠ ${vk_settings_personal} が不正な JSON のため ${vk_settings_dest} は更新しませんでした" >&2
        fi
    else
        # 個人設定が無い → 展開しない。古い展開先が残っていると意図しない既定になるため掃除する。
        # symlink（壊れたものを含む）は rm がリンク自体を消すだけでリンク先は消えないため掃除して良い。
        if [[ -L "$vk_settings_dest" ]] || [[ -f "$vk_settings_dest" ]]; then
            rm -f "$vk_settings_dest"
            echo "  → ${vk_settings_personal} が無いため ${vk_settings_dest} を削除しました（各スキルの既定にフォールバック）"
        elif [[ -e "$vk_settings_dest" ]]; then
            # ディレクトリ等は利用者が置いたものの可能性があるため消さない。
            # 正本ありの経路（上）と同じディスク状態が同じ終了コードになるよう記録する。
            echo "  ⚠ ${vk_settings_dest} は通常ファイルではないため削除しませんでした" >&2
            record_skip "$vk_settings_dest" "通常ファイルではない"
        else
            echo "  → ${vk_settings_personal} が無いため vk-agents-settings.json は展開しません（各スキルの既定にフォールバック）"
        fi
    fi

    # ~/.claude/skills/ にスキルをインストール（--target と共通の処理を使う）
    local skills_src="$SCRIPT_DIR/../skills"
    sync_skills "$HOME/.claude/skills" "global-skill" "$HOME/.claude"
    if [[ -d "$skills_src" ]]; then
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
        local update_user_settings=true
        local user_settings_is_symlink=false
        if [[ -L "$user_settings" ]]; then
            if [[ ! -f "$user_settings" ]]; then
                echo "  ⚠ $user_settings は通常ファイルではないため変更しませんでした" >&2
                record_skip "$user_settings" "通常ファイルではない"
                update_user_settings=false
            else
                user_settings_is_symlink=true
            fi
        elif [[ -e "$user_settings" ]] && [[ ! -f "$user_settings" ]]; then
            echo "  ⚠ $user_settings は通常ファイルではないため変更しませんでした" >&2
            record_skip "$user_settings" "通常ファイルではない"
            update_user_settings=false
        elif [[ ! -f "$user_settings" ]]; then
            # settings.json が存在しない場合は最小構成で新規作成
            echo '{"permissions": {"allow": []}}' > "$user_settings"
        fi
        if [[ "$update_user_settings" == true ]]; then
            local tmp
            tmp=$(mktemp)
            if python3 - "$user_settings" "$tmp" <<'PYEOF'
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
            then
                if [[ "$user_settings_is_symlink" == true ]]; then
                    if cat "$tmp" > "$user_settings"; then
                        rm -f "$tmp"
                        echo "  → ~/.claude/settings.json に必要なスキル用パーミッションを追加しました"
                    else
                        # リンク先へ書き込む形のため、書き込み途中で失敗するとリンク先が
                        # 空または途中までの内容になりうる。「元の内容を保持」とは言えない。
                        rm -f "$tmp"
                        echo "  ⚠ $user_settings のリンク先を更新できませんでした。内容が壊れている可能性があるため中身を確認してください（上記のエラー内容も確認してください）" >&2
                        record_skip "$user_settings" "リンク先の書き込みに失敗"
                    fi
                else
                    # CLAUDE.md 側と同じく、mv の失敗で set -e 中断させずスキップとして数える。
                    if mv "$tmp" "$user_settings"; then
                        echo "  → ~/.claude/settings.json に必要なスキル用パーミッションを追加しました"
                    else
                        rm -f "$tmp"
                        echo "  ⚠ $user_settings を更新できませんでした。元の内容を保持して続行します（上記のエラー内容を確認してください）" >&2
                        record_skip "$user_settings" "更新に失敗"
                    fi
                fi
            else
                # ここへ来るのは主に利用者の settings.json が不正な JSON のときで、元の内容は
                # そのまま残る。利用者側の内容の問題であり配布の見送りとは扱わないため、
                # 意図的に record_skip せず終了コードは 0 のままにする（他ブランチの
                # 書き込み失敗は record_skip する）。
                # 環境要因（python3 が無い・読み取り不能・非 UTF-8）でもここへ来るが、
                # それらは同じ実行で CLAUDE.md 側の record_skip が拾うため exit 2 になる。
                rm -f "$tmp"
                echo "  ⚠ $user_settings を更新できませんでした。元の内容を保持して続行します（上記のエラー内容を確認してください）" >&2
            fi
        fi
    fi

    # エージェント定義は配布済みの人格ファイルを参照するため、人格ファイルを先に配布する。
    cleanup_legacy_personas "$HOME/.claude/vk-agents/personas"
    sync_personas "$HOME/.claude/vk-agents-personas" "global-skill" "$HOME/.claude"
    sync_agents "$HOME/.claude/agents" "global-agent" "$HOME/.claude"

    if [[ ${#SKIPPED_ITEMS[@]} -gt "$skips_before" ]]; then
        echo "完了（一部スキップあり）: グローバルClaude設定を更新し、一部の配布をスキップしました（スキル: インストール ${SKILLS_INSTALLED_COUNT} / 削除 ${SKILLS_REMOVED_COUNT} / 見送り ${SKILLS_DEFERRED_COUNT}）"
    else
        echo "完了: グローバルClaude設定を更新しました（スキル: インストール ${SKILLS_INSTALLED_COUNT} / 削除 ${SKILLS_REMOVED_COUNT} / 見送り ${SKILLS_DEFERRED_COUNT}）"
    fi
}

# 実行
migrate_config
load_disabled_skills
if [[ -n "$TARGET" ]]; then sync_to_project "$TARGET"; fi
if [[ "$CLAUDE_GLOBAL" == true ]]; then sync_claude_global; fi
report_skips_and_exit
