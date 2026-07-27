---
name: vk-bot-pr
description: "bot（Dependabot 等）が自動作成したプルリクエストを一覧化し、patch は自動マージ提案、minor/major は確認の上でマージする"
---

# /vk-bot-pr スキル

> **前提条件（硬ゲート）:** このスキルは、対象リポジトリの owner が許可リスト `org.allowed_owners`（`~/.vk-agents/config.json`）に含まれる場合のみ使用できます。判定手順は `rules/repository-access.md` を参照（許可リスト未設定時は確認のうえ続行可）。

Dependabot などの bot が自動作成したプルリクエスト（`build(deps)` / `build(deps-dev)` / `chore(deps)` など）を一覧化し、安全な patch アップデートは自動マージを提案、minor / major はユーザー確認のうえマージする。

## トリガー

以下の表現を含む場合に使う:

- 「bot の PR を見て」
- 「Dependabot の PR をマージして」
- 「`build(deps-dev)` の PR を処理して」
- 「依存関係更新の PR をまとめて確認したい」

## 引数

- `$ARGUMENTS` にリポジトリの PR 一覧 URL（例: `https://github.com/vektor-inc/lightning/pulls`）を 1 つ指定する
- 引数が無ければユーザーに URL を尋ねる

## 手順

### 1. 引数の解析

1. `$ARGUMENTS` から URL を取得する
2. URL からリポジトリの `owner/name` を抽出する（例: `vektor-inc/lightning`）
   - 受け付ける形式: `https://github.com/<owner>/<name>/pulls` または `https://github.com/<owner>/<name>`
   - 形式が一致しない場合はユーザーに正しい URL を尋ねる
3. リポジトリの owner を `rules/repository-access.md` のゲート判定にかける（硬ゲート）。許可リストに含まれない owner なら処理を中断する（許可リスト未設定時は確認のうえ続行可）

### 2. bot 作成 PR の一覧取得

`gh` コマンドで open 状態の bot 作成 PR を取得する:

```bash
gh pr list \
  --repo <owner>/<name> \
  --state open \
  --json number,title,author,headRefName,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,url \
  --limit 50
```

取得後、以下で bot PR をフィルタする:

- `author.login` が以下のいずれかと一致する:
  - `dependabot[bot]`
  - `renovate[bot]`
  - `github-actions[bot]`
- または、`title` が `build(deps)` / `build(deps-dev)` / `chore(deps)` / `chore(deps-dev)` のいずれかで始まる

bot PR が 0 件ならその旨を報告して終了する。

### 3. semver レベルの判定

各 PR のタイトルからバージョン更新レベルを判定する。Dependabot のタイトル形式:

```
build(deps): bump <package> from <old> to <new>
build(deps-dev): bump <package> from <old> to <new>
```

`<old>` と `<new>` を semver として比較する:

- **patch**: `1.2.3` → `1.2.4`（パッチ番号のみ変化）
- **minor**: `1.2.3` → `1.3.0`（マイナー番号が変化）
- **major**: `1.2.3` → `2.0.0`（メジャー番号が変化）
- **unknown**: 上記いずれにも該当しない（プレリリース表記、コミットハッシュなど）

複数パッケージをまとめた PR は、含まれる更新の最大レベルを採用する（一つでも major があれば major）。

### 4. PR 一覧の表示

取得した PR を以下の形式で表示する:

```
#<番号> [<レベル>] <タイトル>
  CI: <成功/失敗/進行中>  Mergeable: <yes/no/conflict>
  URL: <PR URL>
```

ソート順: patch を先頭、次に minor、最後に major / unknown。

### 5. 自動マージ提案（patch のみ）

patch レベルの PR のうち、以下を全て満たすものを「自動マージ候補」としてユーザーに提示する:

- `mergeable` が `MERGEABLE`
- `statusCheckRollup` の全チェックが `SUCCESS`（CI がグリーン）
- `mergeStateStatus` が `CLEAN`

提示形式:

```
以下の patch アップデート PR は CI もグリーンで安全にマージできます。マージしてよいですか？
- #123 build(deps-dev): bump eslint from 8.50.0 to 8.50.1
- #124 build(deps): bump axios from 1.6.2 to 1.6.3
```

**ユーザーが承認した場合のみ** 以下を実行する:

```bash
gh pr merge <番号> --repo <owner>/<name> --squash --delete-branch
```

マージ方式（`--squash` / `--merge` / `--rebase`）はリポジトリのデフォルトに合わせる。判断できなければ `--squash` を使う。

### 6. CI 失敗・コンフリクトの原因調査と調整（監視ループ）

CI が失敗している、または `mergeable` が `CONFLICTING` の PR は、ユーザーに丸投げせず **必ず原因を調査し、可能な範囲で調整してから** マージ判断へ進む。

> **重要**: 調整アクション（rebase 指示・rerun・ローカル修正など）を実行したら、必ず CI 完了まで監視し、結果を見て次を判断する。「アクションを投げて報告して終わり」は禁止。
> **CI がグリーンになる**か、**6-5 の打ち切り条件に該当してユーザーへ escalate** のいずれかに到達するまで、このスキルは終わらせない。

#### 6-1. CI 失敗の調査

失敗チェック一覧を取得する:

```bash
gh pr checks <番号> --repo <owner>/<name>
```

失敗ジョブのログを取得し、原因を特定する:

```bash
gh run view <run-id> --repo <owner>/<name> --log-failed
# 出力が長く失敗箇所が埋もれる場合は、ジョブのステップ一覧から失敗ステップを特定する
gh run view --job <job-id> --repo <owner>/<name>
```

原因別の対応方針:

- **lockfile 不整合・base ブランチ更新による陳腐化（BEHIND）** — Dependabot 製 PR ならコメントでリベースを指示する:
  ```bash
  gh pr comment <番号> --repo <owner>/<name> --body "@dependabot rebase"
  ```
- **一時的なネットワークエラー・flaky テスト** — ワークフローを再実行する:
  ```bash
  gh run rerun <run-id> --repo <owner>/<name> --failed
  ```
- **lint / 型エラー / テスト失敗で軽微な修正で済むもの** — ローカルに checkout し、修正コミットを追加する（後述 6-3）
- **新パッケージとの本質的な互換性問題（API 変更・破壊的変更）** — 自動修正は試みず、6-5 の escalate に進む

**いずれの対応を取った場合も、必ず 6-4 (CI 監視ループ) に進む。**

#### 6-2. コンフリクトの解消

`mergeable` が `CONFLICTING` の場合、Dependabot 製 PR は原則コメントでリベースさせる:

```bash
gh pr comment <番号> --repo <owner>/<name> --body "@dependabot rebase"
```

実行後は **6-4 (CI 監視ループ) に進む**。Dependabot 以外、または上記でも解消しないコンフリクトは 6-3 に従ってローカルで解消する。

#### 6-3. ローカル checkout による修正・コンフリクト解消

リポジトリのローカルクローンが手元にある前提で、対象 PR を checkout して調整する:

```bash
gh pr checkout <番号> --repo <owner>/<name>
git fetch origin <base-branch>
git merge origin/<base-branch>   # またはリポジトリ規約に応じて rebase
# コンフリクト解消（lockfile は base 側を採用し、パッケージマネージャで再生成するのが基本）
git push
```

- lockfile（`package-lock.json` / `composer.lock` / `yarn.lock` など）は手で編集せず、`npm install` / `composer update --lock` などで再生成する
- 修正コミットを追加した場合は、lint / test をローカルでも一度走らせてから push する
- ローカルクローンの場所がわからなければユーザーに確認する

push が完了したら **6-4 (CI 監視ループ) に進む**。

#### 6-4. CI 監視ループ（必須）

6-1 〜 6-3 のいずれかのアクションを実行したら、**必ず**このステップを実行する。アクション直後に報告して終わらせない。

1. 再実行される CI run を特定する（rebase や push なら新しい run、rerun なら同じ run-id）。少し待ってから:
   ```bash
   gh pr checks <番号> --repo <owner>/<name>
   gh run list --repo <owner>/<name> --branch <headRefName> --limit 3 \
     --json databaseId,status,conclusion,workflowName,createdAt
   ```
   で新しい run の id を取得する。

2. CI 完了まで監視する。`gh run watch` でも良いし、定期的にポーリングしても良い:
   ```bash
   gh run watch <run-id> --repo <owner>/<name> --exit-status
   ```
   - 長時間のジョブは、Bash の `run_in_background` で監視しつつ他の PR の作業を進めても良い

3. CI 完了後、再評価する:
   ```bash
   gh pr view <番号> --repo <owner>/<name> \
     --json mergeable,mergeStateStatus,statusCheckRollup
   ```

4. 結果に応じて分岐する:
   - **CI グリーン & `MERGEABLE` & `CLEAN`** → 6-6 (マージ判断へ復帰)
   - **CI 失敗** → 6-5 (再試行戦略へ)
   - **CI まだ進行中** → そのまま待機を続ける

#### 6-5. 再試行戦略と打ち切り

CI が再度失敗した場合、以下を順に試す。同じ戦略を繰り返さない:

1. **flaky テスト疑い**（同じ失敗が再現しない／実行ごとに違う箇所で落ちる） → `gh run rerun <run-id> --failed --repo <owner>/<name>` で再実行 → 6-4 に戻る
2. **依然として BEHIND・lockfile 由来の失敗** → `@dependabot rebase` を再投稿（前回から 24h 以上経っているか、base に新しい変更がある場合のみ意味あり） → 6-4 に戻る
3. **コードの軽微な修正で済むエラー**（lint / 型 / 単一テスト失敗で原因が明確） → 6-3 に従ってローカル修正 → push → 6-4 に戻る
4. **本質的な互換性問題・自力で直せない** → escalate

**打ち切り条件（いずれかに該当したら escalate）**:

- 同一 PR に対して **累計 3 回** 戦略を試行しても CI がグリーンにならない
- 失敗ジョブが **同じステップ・同じエラー** で連続失敗している（flake ではない）
- ローカル修正を試みたが原因を特定できない／影響範囲が広い
- ユーザーが明示的に「止めて」「保留して」と指示した

escalate 時は以下をまとめてユーザーに報告し、指示を仰ぐ:

- PR 番号・タイトル・URL
- 試した戦略の履歴（何を、いつ、結果どうなった）
- 失敗ジョブ・ステップ名と、ログから抜き出したエラー要点（数行）
- 推測される原因と、考えられる次の手

#### 6-6. 調整完了後の再評価

CI グリーン・`MERGEABLE`・`CLEAN` になった PR は:

- **patch** → 5. の自動マージ候補としてユーザーに提示
- **minor / major / unknown** → 7. の手動確認へ

### 7. 一括マージ提案（minor / major / unknown）

CI がグリーンかつ `MERGEABLE` の minor / major / unknown レベル PR は、破壊的変更のリスクがあるため **必ずユーザー承認を経てマージする**。
ただし PR ごとに個別質問せず、**該当する CI グリーン PR をまとめて 1 回の確認で承認を得る**（patch と同じスタイル）。

提示形式:

```
以下の minor / major アップデート PR は CI グリーンです。マージしてよいですか？
- #1325 [minor] build(deps-dev): bump simple-git from 3.33.0 to 3.36.0
  用途: ビルドスクリプト等で使う dev 依存。変更点: <changelog 要約 or リンク>
- #1324 [minor] build(deps-dev): bump @babel/plugin-transform-modules-systemjs from 7.24.1 to 7.29.4
  用途: Babel ビルドプラグイン (devDependency)。変更点: <changelog 要約 or リンク>
```

各 PR に、ユーザー判断に必要な情報を簡潔に添える:
- semver レベル
- 用途・パッケージの役割（prod か dev か）
- 既知の破壊的変更があれば changelog へのリンク

**質問の作法**: 「どれをマージしますか？」と PR を選ばせる multi-select ではなく、**「全部マージしてよいか？」の単一確認**を基本とする。ユーザーが「#X だけ」「#Y は保留」などと部分指示した場合は、その指示通りに動く。

**ユーザーが承認した場合のみ** 各 PR を順次マージする:

```bash
gh pr merge <番号> --repo <owner>/<name> --squash --delete-branch
```

### 8. 結果の報告

最後に以下を報告する:

- マージした PR の一覧
- 調整を行った PR の一覧と対応内容（リベース指示・再実行・修正コミットなど）
- スキップ / 保留した PR の一覧と理由
- エラーが発生した PR があればその内容

## 注意事項

- **CI が失敗している PR は自動マージしない**（patch であっても必ず原因調査と調整を経てから判断する）
- **コンフリクトしている PR も自動マージしない**（必ず解消してから判断する）
- **minor / major は patch に比べて破壊的変更のリスクが高いため、必ずユーザーに確認する**
- マージ前にユーザーの明示的な承認を取る（patch の一括マージ提案でも承認は必須）
- 調整のために push やコメントを行う場合も、対象 PR と対応方針をユーザーに伝えてから実行する
- **調整アクション（rebase 指示・rerun・ローカル修正）を実行したら、必ず CI 完了まで監視し、結果を踏まえて次のアクションを取る**。「コメントを投げて終わり」「rerun を投げて終わり」は禁止。CI グリーン or 6-5 の escalate に到達するまでスキルを終了させない
- `gh` コマンドが利用できない場合は事前にユーザーへインストールを促す
- bot 以外のユーザーが作成した PR には触れない
