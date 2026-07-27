# Claude エージェント側の対応ルール

VK Orchestrator（オーケストレーター）経由で実行されるタスク（個別リポの issue に `task-queue` ラベル付き、[task-queue](https://github.com/vektor-inc/task-queue) リポジトリにメタ issue が存在する）に、Claude エージェント（vk-kore の司 等）が対応する際のルール。

オーケストレーターの動作仕様は [README.md](../README.md) を、ラベルの一覧は [task-queue リポジトリ](https://github.com/vektor-inc/task-queue) を参照。このファイルは「エージェントがどう振る舞うべきか」だけを扱う。

> **表記について:** 以下のコマンド例に出てくる `<task-queue>` は、メタ issue が置かれるタスク登録リポジトリの `owner/repo` を表すプレースホルダ（issue 番号 `<N>` と同じ扱い）です。**既定は `vektor-inc/task-queue`** ですが、フォークや別 org では変わります（orchestrator の `github.owner` / `github.repo`、env なら `GITHUB_OWNER` / `GITHUB_REPO` で設定。README 参照）。エージェントは値を決め打ちせず、対象 issue の「🤖 …取り込みました → &lt;URL&gt;」コメントの URL（`github.com/<owner>/<repo>/issues/<番号>`）から実際の `owner/repo` を解決して使ってください。

## オーケストレーター経由かどうかの判定

- 対象 issue に「🤖 オーケストレーターが取り込みました → task-queue#NNN」コメントがある
- または `gh issue list -R <task-queue> --state open --json number,title,labels` で `[<対象リポ名>] <元 issue タイトル>` のメタ issue がヒットする
- 全文検索（`--search "<repo> <issue番号>"`）は本文 URL にヒットせず取りこぼすことがあるため、タイトルでの突き合わせを使う

## automerge ラベル付きタスクではマージ判断で停止しない

メタ issue に `automerge` ラベルが付いている場合、オーケストレーターは PR の完了条件（CI 通過・CodeRabbit 静観・mergeable・非 Draft）を満たし、**かつレビュー完了マーカーが現 head SHA に対して存在する** ときに限り squash merge する。

- **`automerge` ラベルはメタ issue（タスク登録リポジトリ側）にのみ付く。** 対象リポ側の issue ラベルを見て「automerge なし」と結論しないこと
- automerge 対象なら、「マージ判断をお願いします」とユーザー応答待ちで **停止してはいけない**。停止するとオーケストレーターがメタ issue を `status:waiting-input` に倒し、自動マージプロセスが止まる
- CI 完了を確認して即マージ（リポの慣習に合わせる）するか、オーケストレーターの自動マージに任せる
- メタ issue が無い、または `automerge` ラベルが無い場合は通常運用（マージ判断はユーザーに委ねる）

## automerge はレビュー完了マーカーがある時のみ発火する

automerge は「CI + CodeRabbit green」で発火するため、エージェント側の最終レビューより前に走りうる。レビューで見つかるバグが入ったまま main にマージされる事故を防ぐため、オーケストレーターは **レビュー完了マーカーが現在の PR head SHA に対して存在するときだけ** 自動マージする。マーカーが無い間は失敗ではなく「保留」（次ループで再判定）であり、マーカーが付けば次ループでマージされる。

これは vk-kore 固有ではなく、**automerge を使うタスクコマンドがレビュー完了時に付けるエージェント非依存の公開規約**。マーカーは **対象 PR** に付与する（メタ issue ではなく実 PR）。vk-kore の司は **4-8 完了（最終レビュー・e2e ゲート通過＝e2e 実施 PASS または正当なスキップ）時点で、現 head SHA に対して** 次の 2 つを付与する責務を負う:

1. PR に **`agent-review-passed` ラベル** を付ける
2. PR に **`agent-review-passed-sha: <現 head SHA>`** を含むコメントを投稿する（短縮 SHA でも可。head SHA への前方一致で照合される）

```bash
SHA=$(gh pr view <PR番号> -R <owner>/<repo> --json headRefOid --jq '.headRefOid')
gh pr edit <PR番号> -R <owner>/<repo> --add-label agent-review-passed
gh pr comment <PR番号> -R <owner>/<repo> --body "agent-review-passed-sha: $SHA"
```

- オーケストレーターはマーカーの意味を解釈せず、**`agent-review-passed` ラベルと SHA 一致コメントの両方** が揃っているかだけを見る。両方が揃わない限り自動マージしない（安全側）。
- **マーカー付与後に修正 push が割り込むと head SHA が変わり、コメントの SHA と一致しなくなる** ため、自動マージは再び保留される。push したらレビューを再確認のうえ、**新しい head SHA でマーカー（ラベルは付いたままなので `agent-review-passed-sha:` コメントだけでよい）を再付与** すること。

## automerge 後のクリーンアップはオーケストレーターが行う

automerge では司（vk-kore）ではなくオーケストレーターが PR をマージするため、司の手動マージ時に走る vk-kore の「マージ後の cleanup」（`vk-clean-repo` 相当の worktree・ブランチ掃除）が走らない。代わりに **オーケストレーターがマージ検知後に自動でクリーンアップする**:

- wp-env コンテナ群（コンテナ・ボリューム・ネットワーク）の destroy
- worktree ディレクトリの削除
- マージ済みローカルブランチ（PR head ブランチ）の削除

これは automerge だけでなく、GitHub UI 等による外部マージをオーケストレーターが検知した場合も同様に実行される。実行結果は対象 issue にコメントで残る。**司は automerge タスクで自分から cleanup を試みる必要はない**（手動マージしたときだけ従来どおり vk-kore 側の cleanup を実施する）。

## automerge は進行中の修正 push と競合する

オーケストレーターは CI / CodeRabbit のステータスしか見ておらず、エージェントチーム内で進行中の対応（レビュー FAIL → 修正 push 等）を知らない。チェックが green になった時点で（かつレビュー完了マーカーが現 head SHA に存在すれば）いつでもマージされうる。逆に言えば、**レビュー完了マーカーを付けない限りは green でも止まる** ので、上記のレビュー完了ゲートが進行中の修正 push に対する第一の安全網になる。それでも次の運用は併せて守ること:

- 修正対応が残っている間は PR を **draft にしておく**（draft の PR はメタ issue が `status:waiting-merge` にならないため、タスクカードも作業中のまま＝実態と表示が一致する）
- push 後は `gh pr view --json state` で **マージ済みでないか確認** する
- マージと入れ違いになった場合は、修正コミットをデフォルトブランチ起点のブランチに cherry-pick してフォローアップ PR を作成する

## 対象 issue（作業対象リポ側）は誰が閉じるか

対象 issue（作業対象リポジトリ側の元 issue）のクローズは、次の多層で担保される。エージェント（vk-kore の司）が明示的に担うのは 3 のバックストップのみで、通常は 1・2 で閉じる。

1. **GitHub ネイティブ**（PR 本文の `Closes #N`）— 一次。PR 作成時は `rules/pull-request.md` に従い `Closes #N` を本文に含める（vk-agents#228 で標準化）。
2. **オーケストレーター**（`src/engine/source-close.js`）— done 遷移直前に対象 issue を close するバックストップ。
3. **Agent（vk-kore 手順6）**— 手動マージ時に対象 issue を冪等 close する最終バックストップ（state を確認し OPEN のときだけ close）。

また、オーケストレーターは対象 issue が **closed** になるまでメタ issue を `status:done` に遷移させない（`src/engine/done-gate.js`）。したがって手動マージ時も、対象 issue を閉じないままだとメタ issue が done 化されず waiting-merge に留まる。手順6で対象 issue の冪等 close まで行うこと。

（オーケストレーター内部の動作仕様は [README.md](../README.md)「対象 issue のクローズ責務（多層）」を参照。この節はエージェント側の振る舞いを扱う。）

## メタ issue のクローズまで責任を持つ

本来はオーケストレーターが PR マージを検出してメタ issue をクローズするが、Claude がユーザー確認待ちで止まった際に `status:waiting-input` のまま放置される経路がある。オーケストレーター経由のタスクと認識したら、マージ後の cleanup で下記のクローズ手順まで実施すること。

**前提チェック（手動マージ時のレース対策）**: automerge ラベル付きタスクをユーザーの明示指示で司が手動マージした場合、オーケストレーターも同じマージを検知してクローズ処理・cleanup を実行するため、司の後追い処理と競合してメタ issue に重複（本文の PR ブロック・完了コメントの2重投稿）が生じる。これを防ぐため、クローズ手順は必ず冪等に行う:

- **手順に入る前にメタ issue の state / `status:*` ラベルを確認し、既に closed または `status:done` なら以降の処理（1〜4）をすべてスキップする**（オーケストレーターが処理済みと判断）。

  ```bash
  META=$(gh issue view <N> -R <task-queue> --json state,labels --jq '.state + " " + ([.labels[].name] | join(","))')
  # META に "CLOSED" または "status:done" が含まれていれば、以降の 1〜4 をスキップ
  ```

- スキップしない場合も、各ステップは投稿・変更前に既存の同一内容の有無を確認し、既にあれば再実行しない（下記各ステップの注記を参照）。
- cleanup（worktree・ブランチ削除）もオーケストレーターが実施しうるため、司側の cleanup は「既に無ければスキップ」の冪等前提で行う。

1. メタ issue 本文に PR URL を追記（オーケストレーターの標準形式）。**本文に既に同じ `**PR:** <PR_URL>` ブロックがあれば追記しない**（下記スニペットは既存確認込み）

   ```bash
   CURRENT=$(gh issue view <N> -R <task-queue> --json body --jq '.body')
   if ! printf '%s' "$CURRENT" | grep -qF "**PR:** <PR_URL>"; then
     gh issue edit <N> -R <task-queue> --body "$CURRENT

   ---

   **PR:** <PR_URL>"
   fi
   ```

2. ラベルを `status:done` に変更（remove 対象は現在付いている `status:*` ラベルを動的に取得する）。**既に `status:done` なら何もしない。`CURRENT_STATUS` が空（orchestrator が先に変更済み）なら `--remove-label` を付けない**

   ```bash
   CURRENT_STATUS=$(gh issue view <N> -R <task-queue> --json labels --jq '.labels[].name | select(startswith("status:"))')
   if [ "$CURRENT_STATUS" = "status:done" ]; then
     :  # 既に done のため何もしない
   elif [ -n "$CURRENT_STATUS" ]; then
     gh issue edit <N> -R <task-queue> --remove-label "$CURRENT_STATUS" --add-label "status:done"
   else
     gh issue edit <N> -R <task-queue> --add-label "status:done"
   fi
   ```

3. 完了コメントを投稿（オーケストレーターと同じ文言）。**URL の有無を問わず、同一コメント内に既存の「✅ 完了」かつ「マージされました」があれば投稿しない**（下記スニペットは既存確認込み）

   ```bash
   FOUND=$(gh issue view <N> -R <task-queue> --json comments \
     --jq '[.comments[].body | select(contains("✅ 完了") and contains("マージされました"))] | length')
   if [ "$FOUND" -eq 0 ]; then
     gh issue comment <N> -R <task-queue> --body "✅ 完了

   PR: <PR_URL> がマージされました。"
   fi
   ```

4. `gh issue close <N> -R <task-queue>`
