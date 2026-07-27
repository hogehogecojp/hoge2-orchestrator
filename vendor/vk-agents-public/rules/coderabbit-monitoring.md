> **注意:** このファイルは vk-agents-public（vk-agents からの複製）です。直接編集しないでください。改善要望は https://github.com/vektor-inc/vk-orchestrator/issues へお願いします。

# CodeRabbit 監視・PR 作成後の対応

## 前提条件（`features.coderabbit` / `features.coderabbit_ignore` フラグ）

CodeRabbit 未導入環境（社外・個人リポジトリ等）では新規投稿を検知できず空振りし続けるため、**`features.coderabbit: false` の環境ではこのファイルのルール全体をスキップする。**

CodeRabbit 導入済みでも通常レビューを走らせたくない環境では、PR 本文に `@coderabbitai ignore` を記載してレビューを抑止する。**`features.coderabbit` が有効（`false` でない）かつ `features.coderabbit_ignore: true` の環境でも、この監視フローは待機なしでスキップする。**

フラグの読み取り方（**このファイルを唯一の正とし、他のルール・スキルはここを参照する**）:

- 設定ファイル: `~/.vk-agents/config.json`（環境変数 `VK_AGENTS_CONFIG` でパスを上書き可）。スキル・ルール・スクリプトはこの正本を読む
- 参照キー: `features.coderabbit`（boolean）と `features.coderabbit_ignore`（boolean）
- **判定は既存動作維持を基本とする**: ファイルなし・`features` / 各キーなし・JSON パース失敗はすべて `features.coderabbit: true` / `features.coderabbit_ignore: false` とみなす。`features.coderabbit: false` が明示された場合のみ CodeRabbit 未導入として扱い、`features.coderabbit_ignore` より優先する
- `features.coderabbit` が有効（`false` でない）かつ `features.coderabbit_ignore: true` の場合、`/vk-pr` は PR 本文に `@coderabbitai ignore` を記載し、このファイルの監視フローは待機なしでスキップする
- 実装は `scripts/check-coderabbit.sh` を正とする（`features.coderabbit: false` なら「CodeRabbit 連携は無効化されています（features.coderabbit: false）」、ignore スキップなら「CodeRabbit レビューは ignore 指定のためスキップします（features.coderabbit_ignore: true）」を出力して即 exit 0）

前提条件でスキップする場合、CodeRabbit 監視を含む各スキル（`vk-pr` / `vk-pr-review` / `vk-kore` / `vk-multi-repo-task` 等）は監視ステップを待機なしで飛ばす。`features.coderabbit: false` なら Claude Code の `/code-review` 等でのレビューを案内し、`features.coderabbit_ignore: true` なら PR 本文の `@coderabbitai ignore` によりレビュー抑止済みと伝える。

## 責任の所在

PR 作成側・監視側の責務は **このファイルを唯一の正** とします。他のルール・スキルは責務規定を複製せず、ここを参照してください。

CodeRabbit の監視は **PR 作成者（実装担当のサブエージェント）ではなく、呼び出し元のエージェント / ディレクター（司）** が直接行います。サブエージェントは長時間ループや3エンドポイント取得仕様を守りきれず、指摘を見落とすことがあるためです。

- PR 作成者（例: 和田）の責務は **PR を作成し、PR URL を司にハンドオフするまで**（`START` の取得・ハンドオフは行わない。順序競合を避けるため司側で取得する）
- 司の責務は **PR URL 受領後の `START` 取得・監視・指摘トリアージ・修正依頼・承認確認**（CI は自動起動しない。「## CI について」参照）
- 単発で `/vk-pr` だけ呼ばれた（司を経由しない）場合は、PR 作成完了時に「CodeRabbit 監視は別途必要な場合にお伝えください」と渡して終了する
- スキルを経由せず（メインのエージェントが直接 `gh pr create` 等で）PR を作成した場合も、黙って終了せず、同様に「CodeRabbit 監視は別途必要な場合にお伝えください」と告知するか、ユーザーの了解を得て本ファイルの手順で監視を開始する

## 補助スクリプト

監視には `scripts/check-coderabbit.sh` を使います。

```bash
./scripts/check-coderabbit.sh <REPO> <PR_NUMBER> <SINCE_ISO8601>
```

- 3 エンドポイント（issues/comments・pulls/comments・pulls/reviews）を一括取得し、`coderabbitai[bot]` の投稿から `SINCE` より後のものを抽出する
- 新規投稿があれば標準出力に `issuecomments=N inline=N reviews=N` のカウント行と、各投稿の `--- [<created_at>] <html_url>` ヘッダ + body 本文（2000文字で切り詰め、超過分は `...(truncated)`）を出し **exit 0**
- 新規投稿がなければ標準エラーに `no new coderabbitai posts since SINCE` を出して **exit 1**
- 引数不足・API エラー時は **exit 2**（標準エラーにメッセージ）

vk-agents リポジトリ内のパスは `$VK_AGENTS_DIR/scripts/check-coderabbit.sh` です（`$VK_AGENTS_DIR` は `~/.claude/CLAUDE.md` で各人の vk-agents clone 先絶対パスに展開され、展開は `./scripts/sync.sh --claude-global` で行われます）。各案件のワーキングディレクトリから絶対パスで呼び出せます。

## PR コメントの総浚い（既存議論の全取得）

PR の **既存議論を最初からすべて読む** 必要があるとき（サマリー前の照合、指摘トリアージで既出・解決済みかの確認など）は、次の3経路をすべて取得する。`gh pr view <PR> --json comments` だけでは CodeRabbit の指摘の大半が載る **インラインコメントを取りこぼす**。

- `gh pr view <PR> -R <REPO> --json comments` … 会話タブの通常コメント
- `gh pr view <PR> -R <REPO> --json reviews` … レビュー本文（Approve / 変更要求の本文）
- `gh api --paginate repos/<owner>/<repo>/pulls/<PR>/comments` … インラインレビューコメント。**CodeRabbit の指摘の本体はここに載る。** `--paginate` を必ず付ける（デフォルトは30件/ページで、インラインの多い PR では付けないと取りこぼす）

> **`check-coderabbit.sh`（上記「補助スクリプト」）との使い分け:** スクリプトも同じ3エンドポイントを叩くが、用途は「`SINCE` 以降の CodeRabbit **新規投稿の検知**」（本文は2000字で切り詰め）。この「総浚い」は **人・CR を問わず PR の既存議論を最初から全文読む** ためのもの。新規検知はスクリプト、全文照合はこの3経路で行う。

## 監視フロー（司が実施）

### 1. ハンドオフ受領と START の取得

PR 作成者から `<REPO>` / `<PR番号>` を受け取る。`START`（監視開始時刻 / ISO8601 UTC, 例: `2026-05-14T12:34:56Z`）は **PR の `createdAt` 起点**。

```bash
START=$(gh pr view <PR> -R <REPO> --json createdAt --jq '.createdAt')
```

> **重要:** `date -u +%Y-%m-%dT%H:%M:%SZ` をハンドオフ後に司側で取得すると、PR 作成 → CodeRabbit が即応答 → 司が `date` を打つ順になった場合、CodeRabbit の投稿時刻が `START` より前になって取り逃すことがある（ドッグフードで確認済み）。**`gh pr view --json createdAt` を使い、PR 作成時刻そのものを起点にすること。**
>
> やむを得ず `date -u` を使う場合は、**PR 作成「前」に取得した時刻** のみ採用可。PR 作成「後」に取った `date -u` は使わない。

#### push / 返信後の START リセット

CodeRabbit 対応後の再監視時は、**push と返信のみで `START` の取得タイミングが異なる**ので注意。

- **返信のみの場合**（スコープ外として別 issue 化を依頼 / 指摘を却下するなど、コードを push しないケース）: **返信の「直後」** に `date -u` を取って `START` を更新する。

  ```bash
  gh api repos/<REPO>/pulls/<PR>/comments/<COMMENT_ID>/replies -f body="@coderabbitai ..." # など返信
  START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # その後、新しい START で再監視ループを起動
  ```

- **push する場合**（修正をコミットして push するケース）: **push の「直前」** に `date -u` を取って `START` を更新する。push 直後に取ると、CodeRabbit が push を検知して即レビューを投稿し、その時刻が `START` より前になって取り逃す可能性があるため。

  ```bash
  # push 前にリセット
  START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  git push
  # 返信は push の後に出してよい
  gh api repos/<REPO>/pulls/<PR>/comments/<COMMENT_ID>/replies -f body="@coderabbitai 修正しました。確認をお願いします。"
  # その後、新しい START で再監視ループを起動
  ```

  push 直前の `date -u` を取り損ねた場合のフォールバック: push したコミットの committer 時刻を採用する。

  ```bash
  START=$(gh api repos/<REPO>/commits/HEAD --jq '.commit.committer.date')
  ```

  ブランチ名を指定して HEAD を引く場合は `gh api repos/<REPO>/commits/<BRANCH> --jq '.commit.committer.date'`。運用上は **push 前の `date -u` を取る方式を推奨**（committer 時刻はローカル時計依存）。

### 2. 監視ループの起動

`Bash` ツールを **`run_in_background: true`** で起動し、補助スクリプトを until-loop で叩く。**`Monitor` ツールは使わないこと**（再開導線が弱く、push 後の再監視ループに乗せづらいため、必ず `Bash` の `run_in_background` を使う）。

```bash
START="<SINCE_ISO8601>"
TIMEOUT_SEC=600
END=$(($(date +%s) + TIMEOUT_SEC))
if [ -z "${VK_AGENTS_DIR:-}" ] || [ ! -x "$VK_AGENTS_DIR/scripts/check-coderabbit.sh" ]; then
  echo "VK_AGENTS_DIR が未設定、または check-coderabbit.sh が実行できません" >&2
  exit 2
fi
while [ $(date +%s) -lt $END ]; do
  if OUT=$("$VK_AGENTS_DIR/scripts/check-coderabbit.sh" <REPO> <PR> "$START"); then
    echo "$OUT"
    exit 0
  fi
  sleep 30
done
exit 1
```

- exit 0 → 新規指摘あり。出力を捕まえて終了
- exit 1 → タイムアウト（10分間 何も来なかった）

### 3. 完了通知後の判定

バックグラウンド Bash の完了通知が届いたら出力を読み、内容で分岐する。指摘が既出・解決済みか確認する場合は、上記「PR コメントの総浚い（既存議論の全取得）」で照合する。

- **`🤖 Prompt for AI Agents` を含む新規指摘がある場合**: スコープ判定して対応する
  - スコープ内 → 実装担当（和田 等）に修正依頼。push 後は `@coderabbitai 修正しました。確認をお願いします。` を該当箇所に返信
  - スコープ外だが正当 → 該当コメントに `@coderabbitai この指摘はこのPRのスコープ外のため、別issueとして登録をお願いします。` を返信
  - 不適切・誤り → 該当コメントに `@coderabbitai この指摘は〇〇のため対応しません。` と理由を返信
  - **`START` リセットしてステップ 2 から再監視**（同一コメントの重複拾い上げ防止）。タイミングはアクション種別で分かれる:
    - **返信のみの場合**: 返信「直後」の `date -u` で `START` を更新
    - **push する場合**: push の「直前」に取得した `date -u` で `START` を更新（push 直後の `date -u` は CodeRabbit の即時応答を取り逃す可能性があるため）。取り損ねた場合は `gh api repos/<REPO>/commits/HEAD --jq '.commit.committer.date'` でフォールバック
    - 詳細は上記「#### push / 返信後の START リセット」を参照
- **`✅` などの承認サインで「Prompt for AI Agents」を含まない返信が来た場合**: 対応完了とする（CI は自動起動しない。「## CI について」参照）
- **タイムアウト（exit 1）**: そのまま「指摘なし」と結論づけず、下記「### タイムアウト時の手動確認」を必ず実施してから判定する

### タイムアウト時の手動確認（backstop）

CodeRabbit は最初に「review in progress」プレースホルダーコメントを投稿し、レビュー完了時に **同じコメントを in-place 編集** して結果を書き込むことがある（特に指摘ゼロのクリーンレビュー時）。`check-coderabbit.sh` は issue コメント・inline コメントでは `created_at` または `updated_at` が `START` より新しいものを検出するため、同一コメントの in-place 編集も検知できる。

ただし reviews 側は `submitted_at` のみで判定し in-place 編集を検知できず、クロックずれ・ページネーション等の残リスクもあるため、手動確認は backstop（保険）として残す。

タイムアウトしたら、結論前に要約コメントの現在本文を直接確認する:

```bash
gh api repos/<REPO>/issues/comments/<COMMENT_ID> --jq '{updated_at, body}'
```

- 本文に `No actionable comments were generated` / `## Walkthrough` が含まれていれば、レビュー完了とみなす
- 本文が `review in progress` のままであれば、監視ループを延長するかユーザーに状況を報告する

### 「指摘ゼロ」の判定は2段階で行う

要約コメント（walkthrough）の完成と、inline 指摘・review の投稿は **別タイミング**。要約後に inline 指摘が数分〜10分以上遅れて届いた実例があるため、「要約完了＝指摘ゼロ」と判定してはいけない。

1. 要約コメントが `Currently processing` / `review in progress` を含まなくなるまで待つ
2. その時点で 3 エンドポイント（issues/comments・pulls/comments・pulls/reviews）を **PR の `createdAt` 起点で再取得** し、inline 指摘・review が無いことを確認してから「指摘ゼロ」と判定する

タイムアウトは「指摘が来ない」根拠にならない。判定後、「CodeRabbit のレビューコメントは確認されませんでした」とユーザーに報告して対応完了とする（CI は自動起動しない。「## CI について」参照）。

## auto incremental reviews が無効なリポジトリ

一部のリポジトリは `.coderabbit.yaml` で auto incremental reviews が無効化されており、**push しても CodeRabbit が自動で再レビューしない**（「Review skipped — Auto incremental reviews are disabled on this repository.」のみ返る）。

- PR 作成時の **初回** は自動で本レビューが走る
- その後の **push 後の再監視** は `@coderabbitai full review` を明示投稿する。`@coderabbitai review`（増分指定）は「does not re-review already reviewed commits」と返って実質スキップされる
- 「Actions performed: Full review triggered」の応答コメントは本レビューではないので、完了判定の検出条件は `🤖 Prompt for AI Agents` / `Actionable comments posted` / `No actionable comments` など **本レビュー特有の文言** に限定する
- 連続 full review で `auto_pause_after_reviewed_commits` の閾値に達すると `Reviews paused` 状態になりレビューが止まる。`@coderabbitai resume` で再開、もしくは `@coderabbitai review` で単発トリガーする

## CI について

CI（GitHub Actions）は **手動で `run-ci` ラベルを付けたときとリリース時のみ** 実行する運用のため、**スキル・エージェントの自動フローでは `run-ci` ラベルを付与しない**。CodeRabbit のレビュー対応が完了（または「指摘なしで完了」）したら、CI の起動・監視を待たずに次の工程（完了報告 / レビュー）へ進む。

- ユーザーに「CodeRabbit のレビュー対応が完了しました」と報告する
- CI を回して確認したい場合は、**人が手動で `run-ci` ラベルを付ける**（エージェントからは付与しない）
- **マージはユーザーが判断するため、自動でマージしないこと。**
