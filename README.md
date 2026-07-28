# VK Orchestrator

GitHub issues をタスクキューとして使い、[VK Terminals](https://github.com/vektor-inc/vk-terminals) 上の Claude に自動実行させる**再利用可能なオーケストレーター**です。

これまで [task-queue](https://github.com/vektor-inc/task-queue) リポジトリに同居していたオーケストレーター部分を切り出したものです。task-queue は「実行する issue の管理（キューの実体）」に専念し、実行ロジックはこの VK Orchestrator が担います。

> 実装は task-queue/orchestrator から移設済みです（ユニットテスト 295 件パス）。設計・移行の背景は [`docs/MIGRATION-PLAN.md`](docs/MIGRATION-PLAN.md) を参照してください。移設に伴う汎用化として、作業対象リポジトリの取り込みラベルを `QUEUE_LABEL` env で差し替え可能にしています。

## 役割分担

```
タスク登録リポジトリ (GitHub issues)  … 何を実行するか（キューの実体・ラベル運用）
        ▼
VK Orchestrator                  … いつ・どのペインに投げ、状態遷移を管理するか
        ▼  HTTP API (127.0.0.1:13847)
VK Terminals                     … 実際に Claude を動かす実行面
```

オーケストレーター経由のタスクに Claude エージェント（vk-kore の司 等）がどう振る舞うべきか（automerge での停止禁止・エージェントレビュー完了マーカー（`agent-review-passed`）の付与責務・メタ issue クローズの責務など）は [`docs/agent-rules.md`](docs/agent-rules.md) を参照してください。orchestrator は各 tick で、このファイルの絶対パスを `~/.vk-agents/runtime/orchestrator-rules.path` に書き出し、エージェントへ handoff します。

## 前提

このツールを動かすには次が必要です。

- **macOS**、または **Windows の WSL2（WSLg）上の Ubuntu**（VK Terminals が node-pty のネイティブビルドを伴う Electron アプリのため。GUI 表示に WSLg が必要）
- **Node.js 20 以上**
- **タスク登録リポジトリ（task-queue）**と、そこに設定されたステータスラベル群（`status:ready` ほか。`config.example.json` の owner/repo で指定）
- **GitHub CLI (`gh`)** と `gh auth login` 済みの認証
- 各ペインで動作する **Claude Code**

VK Terminals は `npm install` 時に依存として自動導入されます（`optionalDependencies`）。

> **WSL Ubuntu で動かす場合** — システム依存ライブラリの導入・GPU 設定・トラブルシューティングを含む、まっさらな環境からの手順を [`docs/WSL-UBUNTU-SETUP.md`](docs/WSL-UBUNTU-SETUP.md) にまとめています。

### 対応 PR の紐付け規約（必須）

orchestrator は「issue に対応する PR」を、**PR 本文に含まれる GitHub 標準のクローズキーワード＋issue 番号（`Closes #N` / `Fixes #N` / `Resolves #N` など）、または対象 issue の URL** で特定します。対応 PR を作成する際は **PR 本文に必ず `Closes #N` を記載してください**。記載のない PR は対応 PR として認識されず、完了判定（CodeRabbit / CI 監視）や automerge が進みません。ラベルやブランチ名規約による紐付けには対応していません（既定の vk-kore スキル経由で作成される PR はこの規約を満たします）。

### 対象 issue のクローズ責務（多層）

対応 PR がマージされたとき、**作業対象リポジトリ側の issue（対象 issue）** は次の多層（defense in depth）で閉じられます。いずれも「対象 issue を closed にする」方向に働くため、複数が発火しても二重クローズは冪等で無害です。

1. **GitHub ネイティブ** — PR 本文の `Closes #N`（上記「対応 PR の紐付け規約」）により、デフォルトブランチへのマージ時に GitHub が対象 issue を自動クローズします（一次）。
2. **オーケストレーター** — マージを検知すると、メタ issue を `status:done` に遷移させる**直前に対象 issue を close** します（`src/engine/source-close.js`）。`Closes #N` が不発だったケース（キーワード無しの完全 URL 参照・非デフォルトブランチへのマージ・クロスリポ）のバックストップです。
3. **Agent（vk-kore）** — 手動マージ時に、対象 issue を冪等に close します（state を確認し OPEN のときだけ close する最終バックストップ）。

さらにオーケストレーターは、メタ issue を `status:done` に遷移させる条件として **対象 issue が closed になっていること** を確認します（`src/engine/done-gate.js`）。対象 issue が open の間（部分対応 PR のみマージ等）はメタ issue を done 化せず、次ループで再評価します。これは `Closes #N` による即時クローズと競合しません（done-gate は対象 issue が closed であることを前提とするため、むしろ整合します）。

### automerge 完了マーカー規約（必須）

automerge の完了ゲートはエージェント非依存の公開契約として固定されています。対象 PR に **`agent-review-passed` ラベル** と **`agent-review-passed-sha: <head SHA>` コメント** が揃い、コメント投稿者の `author_association` が信頼境界内（OWNER / MEMBER / COLLABORATOR）のときだけ、orchestrator はレビュー完了済みとみなします。

SHA は現在の head に固定して照合するため、マーカー付与後に push が入ると TOCTOU 対策として自動マージは保留に戻ります。orchestrator のゲートは常時 ON で、マーカーが揃った場合のみ automerge します。CI 全通過・CodeRabbit 静穏・mergeable 等の従来条件も引き続き前提です。旧マーカー規約との後方互換はありません。

このマーカーは **`status:in-progress` から `status:waiting-merge` への自動遷移にも効きます**。automerge タスクではマーカーが現 head SHA に対して揃うまでメタ issue は `status:in-progress` のままで、タスクカードは「マージ待ち」になりません（マージしないと分かっている段階で「マージ待ち」と表示しないため、遷移条件を automerge のマージゲートと揃えています）。automerge ラベルの無いタスクにはマーカーが付かないため、従来どおり完了条件の充足だけで `status:waiting-merge` へ進みます。あわせて **Draft PR も（automerge かどうかに関わらず）この自動遷移では `status:waiting-merge` になりません**。保留された場合は理由が orchestrator のログに毎ループ出力されます。

#### コンフリクト時の自動差し戻し

automerge 対象 PR のコンフリクト差し戻しは、次のように動作します。

- 通常時は、メタ issue を `status:in-progress` へ戻し、既存の担当ペイン（消失済みなら新規ペイン）へコンフリクト解消・push・CI 確認・再レビューを依頼します。
- 同じ head SHA に対しては、依頼本文がペインに届いたことを確認できていれば再送しません。
- 送信に失敗した場合は通算差し戻し回数を消費せず再試行します。同一 head SHA で 3 回（固定値）失敗すると、メタ issue へ通知して自動差し戻しを打ち切り、`blocked:conflict` ラベルを付けます。タスクカードには赤い「要対応: コンフリクト」バッジと点滅が出て、手動対応が必要だと分かります。
- 通算上限はタスク 1 件の生涯を通して数え、一度コンフリクトが解消してもリセットしません。`orchestrator.conflictHandbackMax` / `CONFLICT_HANDBACK_MAX`（既定 `2`）で変更でき、`0` を指定すると自動差し戻しを行わず、すべて手動対応になります。上限到達時も `blocked:conflict` を付けて自動差し戻しを打ち切ります。`waiting-merge` の automerge 対象外コンフリクトも同じ表示になります。
- 解消後は CI が通過し、エージェントが現 head SHA（PR ブランチの最新コミット ID）を再レビューして `agent-review-passed-sha:` コメント（レビュー完了マーカー）を付け直すと、自動マージが再開します。
- `blocked:conflict` は PR の状態から毎ループ再同期されるため、手で外してもコンフリクトが解消するまで戻ります。
- PR のコンフリクト解消、マージ、close を確認すると `blocked:conflict` は自動で外れます。ステータスが `waiting-merge` 以外へ移った際の取り残しも毎ループ掃除し、表示側でも `waiting-merge` 以外にはブロック表示を出しません。

なお上記は in-progress からの自動遷移のスコープです。`status:failed` からの事後復旧（`recheckFailedIssues()`：対象 issue に open PR が見つかったケース）や、CLI / `commands.jsonl` 経由の手動ステータス変更は、Draft・マーカーの有無を見ずに `status:waiting-merge` を付けます。

## クイックスタート（対話セットアップ）

初めて使う場合は、**Claude Code を起動して `/vk-orchestrator-setup` を実行する**のが最短です。対話に答えるだけで、モード選択（ローカル / GitHub）から 3 ファイル（orchestrator / VK Terminals / vk-agents）への保存までまとめて埋められます。

```bash
git clone https://github.com/vektor-inc/vk-orchestrator.git
cd vk-orchestrator
npm install                          # VK Terminals も一緒に導入される（optionalDependencies）
claude                               # このリポジトリのディレクトリで Claude Code を起動
# プロンプトに /vk-orchestrator-setup と入力すると対話セットアップが始まる
```

`/vk-orchestrator-setup` はこのリポジトリ内に同梱された**プロジェクトスキル**（`.claude/skills/vk-orchestrator-setup/`）なので、`npm run setup:agents`（vk-agents スキル展開）が未実施でも入口として使えます。充足判定はコード側の `vk-orchestrator doctor` が単一ソースで行い、スキルはその結果を読んで会話と保存に徹します。

CLI だけで「自分の環境で何が足りないか」を確認したい場合は `vk-orchestrator doctor` を使います（✅/❌ の一覧と、次にやるコピペ可能なコマンドを表示。`--json` で要件配列を出力）。必須項目は**選択中のモード（`queue.backend`）から毎回計算**され、GitHub モードでだけ `gh` 認証・`github.owner`/`github.repo`・担当者フィルタ・運用ラベルが必須になります。

```bash
npx vk-orchestrator doctor           # 充足状況の診断（✅/❌ と次にやるコマンド）
npx vk-orchestrator doctor --json    # 機械可読（{ id, group, label, required, ok, current, hint, target } の配列＋要約）
```

## セットアップ（手動）

対話セットアップを使わず手で設定する場合は次のとおりです。

```bash
git clone https://github.com/vektor-inc/vk-orchestrator.git
cd vk-orchestrator
brew install gh                      # gh 未導入の場合のみ（GitHub モードで必要）
gh auth login                        # ブラウザで GitHub 認証（GitHub モードで必要）
npm install                          # VK Terminals も一緒に導入される（optionalDependencies）
cp config.example.json config.json   # 下記の必須項目を編集
npm run setup:agents                 # 同梱 vk-agents-public から skills/rules を ~/.claude へ展開
npm run doctor                       # 充足状況を診断（不足があれば次にやるコマンドが出る）
npm run up                           # 設定を反映して VK Terminals(GUI) と orchestrator を起動
```

> **VK Terminals が「見つからない」と言われる場合** — `vk-terminals` は `optionalDependencies` かつ postinstall で node-pty / electron のネイティブビルドを行うため、ビルドに失敗すると **`npm install` は成功したまま vk-terminals だけ黙って除外**され、`up` 実行時に「VK Terminals が見つかりません」となります。次のコマンドで**ビルドログを表示しながら導入し直し、結果を検証**できます。
>
> ```bash
> npm run setup:terminals
> ```
>
> よくある失敗原因: **macOS で Xcode Command Line Tools 未導入**（→ `xcode-select --install`）、**macOS 以外**（GUI は macOS 専用。別マシンの VK Terminals API を使う構成なら `up` ではなく `start` を使い `~/.vk-terminals/config.json` の `apiHost` または `VK_TERMINALS_HOST` を対象マシンに向ける）、C/C++ ビルドツール不足やネットワークエラー。

**最低限、`github.owner` / `github.repo` の 2 つを自分の値に書き換えれば動きます。** GitHub トークンは `gh auth login` 済みなら `gh auth token` から自動取得します。その後に `npm run setup:agents` を実行すると、このリポジトリに同梱された `vendor/vk-agents-public/` から skills/rules が `~/.claude/` へ展開されます。private な vk-agents リポジトリを別途 clone する必要はありません。

`npm run setup:agents` は同梱 `vendor/vk-agents-public/scripts/sync.sh --claude-global` を実行し、Claude Code のグローバル設定（`~/.claude/`）を更新します。実行時に生成・変更・削除されるパスは次のとおりです。

| パス | 操作 | 内容 |
|---|---|---|
| `~/.claude/CLAUDE.md` | 生成・変更 | `<!-- agent-skills:start -->` から `<!-- agent-skills:end -->` までの vk-agents 管理セクションを新規作成・更新・追記します。 |
| `~/.claude/settings.json` | 生成・変更 | ファイルが無ければ最小構成で作成し、`gh` / `git` / `date` / `sleep` / `cd` などスキル実行に必要な `permissions.allow` を追記します。 |
| `~/.claude/skills/<skill名>/` | 生成・変更・削除 | 同梱 `vendor/vk-agents-public/skills/` の各スキルを展開します。`skills.disabled` で無効化されたスキルや、前回 manifest にあり今回ソースに無い廃止スキルのディレクトリは削除されます。 |
| `~/.claude/skills/.agent-skills-manifest` | 生成・変更 | 今回展開したスキル名一覧で上書きします。 |
| `~/.claude/skills/.agent-skills-manifest-source` | 生成・変更 | orchestrator が、同梱 `vendor/vk-agents-public/` を展開元として記録します。 |
| `~/.claude/agents/<定義名>.md` | 生成・変更・削除 | Claude Code から直接指名して起動できるエージェント定義を展開します。対応するスキルが無効化された定義や、前回の管理台帳にあり今回ソースに無い廃止定義は削除されます。 |
| `~/.claude/agents/.agent-skills-manifest` | 生成・変更 | 今回展開したエージェント定義のファイル名一覧で上書きします。 |
| `~/.claude/vk-agents/personas/<人格ファイル名>.md` | 生成・変更・削除 | 各エージェントの役割や口調を記した人格ファイルを展開します。前回の管理台帳にあり今回ソースに無い廃止人格ファイルは削除されます。 |
| `~/.claude/vk-agents/personas/.agent-skills-manifest` | 生成・変更 | 今回展開した人格ファイル名一覧で上書きします。 |
| `~/.vk-agents/config.json` | 生成・変更 | orchestrator の設定（`features.*` / `org.*` / `skills.disabled` など）を vk-agents 側の正本へ投影します。ディレクトリが無ければ作成します。既存ファイルがある場合は投影対象のキーだけを更新し、それ以外の設定は保持します。 |
| `~/.claude/vk-agents-settings.json` | 生成・変更・削除 | `~/.vk-agents/config.json` と同じ内容を vk-agents 用の派生設定として書き出します。`sync.sh --claude-global` 単体では、vk-agents 側 `config.json` が無い場合に既存ファイルを削除します。 |
| `~/.claude/commands/<skill名>.md` | 削除 | 旧コマンドファイルが残っている場合、同名スキルへ移行済みとして削除します。`~/.claude/commands/` が無い場合は何もしません。 |

<!-- vendor 更新時に削除: 同梱 vendor/vk-agents-public が agents/ の配布に対応したら、直後の注記を外すこと（issue #230） -->
> エージェント定義（`~/.claude/agents/<定義名>.md` とその管理台帳）と人格ファイル（`~/.claude/vk-agents/personas/<人格ファイル名>.md` とその管理台帳）の4行は、同梱 `vendor/vk-agents-public/` がこれらの配布に対応したバージョンに更新されて以降に有効になります。現時点の同梱版では、これらのパスへの書き込みは発生しません。

`rules/` は `--claude-global` では `~/.claude/rules/` などへコピーされません。`~/.claude/CLAUDE.md` と展開済みスキル内の参照は、同梱 `vendor/vk-agents-public/rules/` の絶対パスを指す形に更新されます。

エージェント定義と人格ファイルは、配布先ディレクトリ自体を削除せず、各ディレクトリの管理台帳（`.agent-skills-manifest`）に載っているファイルだけを上書き・削除の対象にします。そのため、利用者が自前で置いたエージェント定義や人格ファイルはそのまま保持されます。逆に、管理台帳に載っている配布済みのファイルを直接編集した場合、その変更は次回の `npm run setup:agents` で上書きされます。独自に手を入れたいときは、別のファイル名で置いてください。

その他の項目（`orchestrator.*` や `vkTerminals.*`、VK Terminals 本体設定）はすべて既定値が用意されているので、通常はそのままで構いません。とくに VK Terminals API の `port`（既定 `13847`）と `apiHost`（既定 `127.0.0.1`）は**自分で値を決める必要はなく**、ポート衝突など特別な事情があるときだけ `~/.vk-terminals/config.json` で変更してください（設定を省略しても既定値で動作します）。

orchestrator 自身の設定は `~/.vk-orchestrator/config.json` に置くとユーザー固有設定として優先的に読まれます（`VK_ORCHESTRATOR_CONFIG` で明示指定も可）。VK Terminals 本体が読む設定は `~/.vk-terminals/config.json` に保存します。GitHub トークンは通常 `config.json` に保存せず、`gh auth login` に任せます。優先順位は `GITHUB_TOKEN` 環境変数 / `.env` > `config.json`（既存互換の `github.token`） > `gh auth token` > 既定値です。

### キューの保存先（GitHub モード / ローカルモード）

タスクキューの保存先は `queue.backend`（環境変数 `QUEUE_BACKEND`）で 2 モードから選べます。既定はローカルモードです。設定パネル（⚙）の「オーケストレーター」グループ先頭の「キューの保存先」プルダウン、または `config.json` の `queue.backend` で切り替えます。

| モード | `queue.backend` | キューの実体 | task-queue リポジトリ | 主な用途 |
|---|---|---|---|---|
| ローカル（既定） | `local` | ローカル JSON（`~/.task-queue/queue.json`） | 不要 | 手元だけでタスクを管理する。task-queue リポジトリを用意しない |
| GitHub | `github` | task-queue リポジトリの Issue | 必要 | 複数人・複数リポジトリで Issue ベースに運用する |

> **既存ユーザーへの注意:** 既定がローカルに変わったため、`queue.backend` を明記していない環境はアップグレード後にローカルモードで起動します。GitHub モードを継続する場合は `config.json` に `queue.backend: github`（または環境変数 `QUEUE_BACKEND=github`）を明示してください。

- **GitHub モード**では `github.owner` / `github.repo`（タスク登録リポジトリ）と「ラベルの登録」（下記）が必要です。
- **ローカルモード**では task-queue リポジトリは不要です。設定パネルではローカルモードを選ぶと「タスク登録リポジトリ名」（`github.repo`）が自動的に非表示になり、未設定のまま起動できます。純ローカルタスクは `vk-orchestrator task` コマンド（下記「純ローカルタスク CLI」）で登録・確認します。`github.owner` は、作業対象リポジトリを組織横断検索して取り込む際のオーナーとして**両モードで使用**するため、ローカルモードでも設定してください。
- 補助スクリプト（`check-status` / `unblock` / `ensure-task-queue-label`）は GitHub 上の Issue を前提とするため **GitHub モード専用**です。ローカルモードでは使えません（MVP では相当スクリプトを提供しません）。

#### トークンレス起動（純ローカルタスク専用運用）

ローカルモードは **`GITHUB_TOKEN` を解決できなくても起動**します（GitHub モードは従来どおりトークン必須で、未解決なら起動を中止します）。トークンが無いローカルモードでは GitHub API アクセスを伴う機能が自動的に無効化され、GitHub に一切触れない「純ローカルタスク専用」で動作します。無効になるのは次の機能です。

- **source import**（作業対象リポジトリからの `task-queue` ラベル付き Issue の取り込み）
- **PR 監視**（PR 検索・CI 判定・完了条件判定による `waiting-merge` への自動遷移）
- **automerge**（マージ検知・自動 squash マージ）
- **対象 issue 操作**（source issue の close・完了コメント投稿など GitHub への書き込み）

無効化された内容は起動時のログ（起動サマリと警告行）に明示されます。純ローカルタスク（issue URL を含まないタスク）の登録 → 実行 → `waiting-merge` → 手動 `done` の一巡は、この状態でも GitHub に触れず動作します（`waiting-merge` への移行と `done` は `vk-orchestrator task set-status` などの手動操作で行います）。トークンを解決できるローカルモードでは、上記の GitHub 連携機能は従来どおりフル稼働します。

以下の「GitHub 認証」「ラベルの登録」は GitHub モードのセットアップ手順です。ローカルモードだけを使う場合、ラベル登録は不要です（GitHub 認証は、issue URL を含むタスクの取り込みや作業対象リポジトリの操作を行う場合に引き続き必要になることがあります）。

### GitHub 認証

orchestrator は issue/PR の読み書き・ラベル操作・組織横断検索を行うため、GitHub API 認証が必要です。通常は GitHub CLI の認証を使います。

```bash
brew install gh        # gh 未導入の場合のみ
gh auth login          # ブラウザで承認
gh auth status         # 認証状態と scope の確認
```

`GITHUB_TOKEN` が未設定の場合、orchestrator は起動時に `gh auth token` を実行してトークンを取得します。トークンは GitHub CLI 側（macOS では Keychain）で管理されるため、`config.json` に平文保存する必要はありません。失効・切り替えが必要な場合は `gh auth logout` または `gh auth login` を使ってください。

対象組織が **SAML SSO** を有効にしている場合は、`gh auth login` 後にブラウザで組織への認可（**Configure SSO → Authorize**）が必要です。

既存環境との互換のため、`GITHUB_TOKEN` 環境変数 / `.env` / `config.json` の `github.token` も引き続き読みます。ただし新規設定では `gh auth login` を推奨し、GUI 設定パネルにもトークン入力欄は表示しません。

`config.json` は手編集のほか、**`up` で起動した VK Terminals(GUI) のタイトルバー右端 ⚙ ボタンから GUI 上で編集・保存**できます（`up` が設定ディスクリプタを書き出し、環境変数 `VK_TERMINALS_SETTINGS` で GUI に渡します）。保存すると `config.json` がそのまま書き換わります。反映タイミングは orchestrator を再起動したとき（`vkTerminals` セクションの項目は次回 `up`/`apply` 時）です。

### ラベルの登録

> **GitHub モード専用**: 以下のラベル登録は `queue.backend` が `github` のときだけ必要です。ローカルモード（`queue.backend = local`、既定）では GitHub の Issue ラベルを使わないため実行不要です。

運用に使うラベルは 2 系統あり、それぞれ一括登録コマンドを用意しています。`gh auth login` 済みの状態で実行してください。

**1. 作業対象リポジトリの取り込みラベル（`task-queue`）を org 各リポへ** — orchestrator は作業対象リポジトリのオーナー（組織）を横断検索し、`task-queue` ラベルの付いた issue を探します。このラベルは依頼者が手で付けるため、各リポジトリに事前作成しておかないと候補に出ず取り込みが始まりません。新規リポジトリを作業対象に加えるときに流してください。

```bash
npm run setup:labels                     # org の全リポジトリに task-queue ラベルを ensure
node src/engine/ensure-task-queue-label.mjs repo1 repo2   # 指定リポジトリのみ
node src/engine/ensure-task-queue-label.mjs --list        # 対象リポジトリ一覧の表示だけ
```

**2. 運用ラベル一式（`status:*` / `priority:*` / `blocked:*` / `sequential` / `parallel` / `automerge`）をタスク登録リポジトリへ** — orchestrator が自動付与する `status:*` / `blocked:*` は未作成でも API 側で自動生成されますが、色がランダムになります。また `status:ready`（承認）・`priority:*`・`sequential`・`automerge` は**人間が手で付ける**ため、真っさらなタスク登録リポジトリでは事前登録しておかないと候補に出ません。タスク登録リポジトリのセットアップ時に流してください（色・説明は既定運用の定義に揃えて作成、既存はスキップ）。

```bash
npm run setup:queue-labels               # タスク登録リポジトリに status:* / priority:* / blocked:* など一式を ensure
node src/engine/ensure-task-queue-label.mjs --status --list   # 登録するラベル一覧の表示だけ
```

private リポジトリにアクセスするには `gh auth login` の認証を使います。ラベル登録だけ別トークンで実行したい場合は `SETUP_TOKEN` 環境変数を指定できます。ラベル名・ラベル登録先 org / タスク登録リポジトリは `config.json`（`github.queueLabel` / `owner` / `repo`）または環境変数（`QUEUE_LABEL` / `GITHUB_OWNER` / `GITHUB_REPO`）に従います（`queueLabel` を既定の `task-queue` から変えている場合、作業対象リポジトリの取り込みラベルはそのラベル名で作成されます）。

## 起動

`up` 一発で、設定反映 → VK Terminals(GUI) 起動 → orchestrator 起動までまとめて行います。

```bash
npx vk-orchestrator up       # config.json を反映 → GUI 起動 → API 疎通を待って orchestrator を起動
# npm start でも同じ（start スクリプトは up に割り当て済み）
```

`up` 起動時は `vk-orchestrator doctor` と同じ充足判定を実行し、**選択中のモードで必須（`required`）なのに未充足（`!ok`）な項目が 1 つでもあれば**、初回セットアップとして `/vk-orchestrator-setup`（および `npm run setup:agents` などの不足コマンド）の実行を案内します。この案内は非致命（警告のみ）で、既存環境の `up` を止めません。全必須項目が充足していれば、統合 config（`~/.vk-orchestrator/config.json`）に `setup.completedAt` を記録して次回以降の案内を省きます（判定の真実はあくまで毎回の doctor で、このフラグは案内スキップ用のヒントに過ぎません）。

`up` は VK Terminals API の起動を待ってから、**GUI の中に orchestrator 専用ペイン（Claude を起動しない素のシェル）を開いて `vk-orchestrator start` を自動実行**します。ペイン上部には「オーケストレーター」というタイトルが立つので他ペインと一目で区別でき、GUI を閉じればペインごと orchestrator も終了します。これで **「ペインを開いて Claude を止めて `vk-orchestrator start` を打つ」手動手順は不要**です。

> VK Terminals API に疎通できない場合（`apiHost` が到達不能な Tailscale IP のとき等）は orchestrator ペインを作らず警告を出します。その場合は `~/.vk-terminals/config.json` の `apiHost` または `VK_TERMINALS_HOST` を見直すか、GUI 内のペインで手動起動してください。

GUI だけ起動したい（orchestrator は別途手動で回す）場合は `--no-orchestrator` を付けます。

```bash
npx vk-orchestrator up --no-orchestrator   # GUI のみ起動
```

orchestrator を単体で動かしたい場合（別マシンから API を叩く・1 周だけ回す等）は `start` を直接使います。

```bash
npx vk-orchestrator start          # タスク登録リポジトリのキューを確認して実行
npx vk-orchestrator start --once   # 1 周だけ実行
npx vk-orchestrator check-status   # 現在の状態を表示（GitHub モード専用）
npx vk-orchestrator doctor         # 初回セットアップの充足状況を診断（--json で要件配列）
```

> **補助スクリプトは GitHub モード専用**: `check-status`（`src/engine/check-status.mjs`）・`src/engine/unblock.mjs`・`src/engine/ensure-task-queue-label.mjs` は GitHub 上の Issue を前提とするため、`queue.backend = github` のときだけ使えます。ローカルモードでは対象がなく、キューの確認・状態変更は下記「純ローカルタスク CLI」の `vk-orchestrator task list` / `task set-status` を使ってください（MVP ではローカルモード向けの相当スクリプトは提供しません）。

### 純ローカルタスク CLI

`queue.backend` を `local` にしている環境では、GitHub issue に紐づかない純ローカルタスクを CLI から登録・確認できます。GitHub backend では実行できません。

```bash
npx vk-orchestrator task add "README の更新" --body "ローカルだけで管理する作業" --priority high --sequential
npx vk-orchestrator task list
npx vk-orchestrator task list --status ready --json
npx vk-orchestrator task set-status 1 done
```

`task add` の `--status` は既定 `ready`、`--priority` は未指定なら `none` です。保存先はローカルキュー（既定 `~/.task-queue/queue.json`）で、純ローカルタスクには元 issue URL は自動追記されません。

`apply` を使えば VK Terminals を起動せず設定反映だけ行うこともできます。

```bash
npx vk-orchestrator apply
```

## VK Terminals との結合

VK Terminals は `optionalDependencies` として同梱（git 依存）しつつ、実行時の連携は HTTP API 契約だけで行います。その API クライアントは `src/terminals/` に閉じており、コードとしては import していません（＝疎結合のまま、導入と起動だけまとめている）。macOS 以外や native ビルド失敗時でも `npm install` 自体は成功し、`up` 実行時に未導入なら分かりやすくエラーを出します。

> **なぜ `@electron/rebuild` が optionalDependencies にあるか**: VK Terminals の `postinstall` は `electron-rebuild`（`@electron/rebuild` が提供）で node-pty を Electron 向けに再ビルドします。ところが `@electron/rebuild` は VK Terminals 側では **devDependencies** にあり、依存として導入する側（この VK Orchestrator）ではインストールされません。その結果 `electron-rebuild: command not found` で postinstall が失敗し、optional 依存の VK Terminals ごと破棄され「見つかりません」となります。これを避けるため VK Orchestrator 自身の依存に `@electron/rebuild` を持たせ、npm が nested postinstall 実行時に親の `node_modules/.bin` を PATH へ加える挙動を使って解決させています。

## 設定項目

`config.json`（config.example.json 参照。同名の環境変数があればそちらが優先）:

| セクション.キー | 対応 env | 意味 | 既定 |
|---|---|---|---|
| `github.token` | `GITHUB_TOKEN` | GitHub トークン。通常は `gh auth login` を使うため設定不要（既存互換） | `gh auth token` |
| `github.owner` / `github.repo` | `GITHUB_OWNER` / `GITHUB_REPO` | タスク登録リポジトリ（task-queue） | `your-org` / `task-queue` |
| `github.sourceOrg` | `SOURCE_ORG` | 作業対象リポジトリのオーナー（組織） | タスク登録リポジトリのオーナーと同じ |
| `github.queueLabel` | `QUEUE_LABEL` | 作業対象リポジトリの取り込みラベル名 | `task-queue` |
| `queue.backend` | `QUEUE_BACKEND` | キューの保存先。`github` は GitHub issues、`local` はローカル JSON（`~/.task-queue/queue.json`） | `local` |
| `orchestrator.pollIntervalMs` | `POLL_INTERVAL_MS` | ポーリング間隔 | `60000` |
| `orchestrator.watchdogIdleMs` | `WATCHDOG_IDLE_MS` | ウォッチドッグ閾値 | `10800000` |
| `orchestrator.paneResumeMax` | `PANE_RESUME_MAX` | ペイン消失時・本文未達時（PR 未生成）の自動再開上限回数（両者で合算） | `3` |
| `orchestrator.conflictHandbackMax` | `CONFLICT_HANDBACK_MAX` | コンフリクト差し戻しの通算上限（詳細は上記「コンフリクト時の自動差し戻し」） | `2` |
| `orchestrator.replyForwardRetryMax` | `REPLY_FORWARD_RETRY_MAX` | issue の返信が作業ペインへ届かなかった場合の再送上限回数（初回送信を除く） | `2` |
| なし | `CLAUDE_READY_TIMEOUT_MS` | Claude Code の起動完了（入力待ち）を待つ readiness ゲートの全体タイムアウト。コールドスタートの起動バナー churn を跨げるよう設定 | `45000` |
| なし | `CLAUDE_SUBMIT_DELAY_MS` | 本文送信後の基準待機時間（linear backoff の 1 単位）。再送のたびに待機が伸びる | `1000` |
| なし | `CLAUDE_SUBMIT_MAX_RETRIES` | 本文・Enter それぞれの最大再送回数（初回と合わせて最大 +1 回まで送信） | `3` |
| `orchestrator.assigneeFilter` | `ASSIGNEE_FILTER` | 担当者フィルタ。空/未設定は一切取り込まず、全件対象は `all` を明示 | `null`（拾わない） |
| `workspace.search_paths`（vk-agents config） | なし | 作業対象リポジトリのローカルクローン探索起点。タスク用ペインの起点決定にも使用 | 未設定時は `~/vk-orchestrator-tasks`（無ければ自動作成） |
| なし | `TASK_CWD` | タスク用ペインの Claude Code 起点ディレクトリの緊急上書き | 未設定 |
| `~/.vk-terminals/config.json` の `port` / `apiHost` | `VK_TERMINALS_PORT` / `VK_TERMINALS_HOST` | VK Terminals API | `13847` / `127.0.0.1` |
| `~/.vk-terminals/config.json` の `gpu` | `VK_TERMINALS_GPU` | GUI の GPU 起動モード（下記）。設定パネルの「VK Terminals（本体設定）」から編集可 | 空=自動 |
| `~/.vk-terminals/config.json` の `initialCommand` / `additionalPanes` 等 | 設定パネルから保存 | VK Terminals のペイン構成等 | — |

タスク用ペイン（Claude Code）の起点ディレクトリは、issue に含まれる対象リポジトリ URL と vk-agents config の `workspace.search_paths` から決まります。上から順に走査し、origin が対象リポジトリと一致する既存クローンを最大 4 階層まで自動検出して、そのディレクトリでペインを開きます。

対象リポジトリを特定できないとき、`workspace.search_paths` が未設定のとき、または検出できないときは、専用ディレクトリ `~/vk-orchestrator-tasks`（無ければ自動作成）で起動します。`$HOME`（ホームディレクトリ）や特定リポジトリ、`config.json` / `.env` のある機密ディレクトリを起点にしないための安全側の既定です。

`TASK_CWD` 環境変数を設定した場合は緊急上書きとして最優先され、ローカルクローン検出は行いません。config の `orchestrator.taskCwd` は廃止され、読み取りません。

注意: 起点（cwd）は「起点」であって「隔離」ではありません。絶対パス指定でのファイル読み取りは起点に関わらず可能なので、`GITHUB_TOKEN` 等の機密保護は起点設定だけでは達成できません。秘密管理・権限分離は別途行ってください。`TASK_CWD` に相対パスを指定した場合はオーケストレーター起動時の作業ディレクトリ基準で解決されます。

> **`gpu`（GUI の GPU 起動モード）** — VK Terminals(GUI) は Electron アプリで、macOS 以外（WSLg 等の Linux）では Chromium の GPU 初期化が失敗し `up` 起動時に `Exiting GPU process` / `kTransientFailure` 等のエラーログが大量に出ます。値で挙動を選べます。
>
> 設定は VK Terminals 本体 config（`~/.vk-terminals/config.json` の `gpu`）に保存します。設定パネルでは「VK Terminals（本体設定）」から編集できます。解決順は `VK_TERMINALS_GPU` 環境変数 > `~/.vk-terminals/config.json` の `gpu` > プラットフォーム既定です。
>
> - **空（既定・自動）** — macOS は通常起動、それ以外は `off` 相当。通常はこのままで OK。
> - **`off`** — GPU を無効化してエラーログを抑制（描画はソフトウェア。ターミナル用途で実害なし）。
> - **`default`** — フラグを足さず Chromium 任せ（元の挙動。macOS 以外では GPU 初期化エラーが出る場合あり）。
>
> 反映は次回 `up` 時。ターミナル用途では GPU アクセラの体感差はほぼ無いため、既定（`off` 相当）で十分です。
>
> ※ WSLg での HW アクセラ（HW OpenGL / Vulkan）は対応しません。Vulkan は HW ICD（dzn 等）が WSLg に無く、OpenGL も体感差が無いうえ Mesa/Dawn 由来の警告が出るためです。

### タスク・vk-agents 連携の設定

上表のオーケストレーター／VK Terminals ランタイム設定に加え、`config.json` には**タスク着手時のコマンド**と**各ペインで動く Claude エージェント（vk-agents）向けの共通設定**を持たせられます。GUI 設定パネルにも同じ項目が並びます（`config.example.json` 参照）。

| セクション.キー | 対応 env | 意味 | 既定 |
|---|---|---|---|
| `task.commandTemplate` | `TASK_COMMAND_TEMPLATE` | タスク着手時に各ペインへ投入するコマンド。`{issueUrl}` / `{wpPort}` は自動置換 | `/vk-kore {issueUrl} wp-env-port={wpPort} headless=1` |
| `features.coderabbit` | — | エージェント側の CodeRabbit 監視を有効化（vk-agents 設定へ投影）。OFF で `/code-review` 等での確認に切替。OFF のときは自動マージの CodeRabbit 待機（下記）も省略 | `true` |
| `features.coderabbit_ignore` | — | `features.coderabbit` が ON のとき、`/vk-pr` の PR 本文に `@coderabbitai ignore` を記載して CodeRabbit レビューをスキップ。レビューが来ないため自動マージの CodeRabbit 待機（下記）も省略 | `false` |
| `org.review_assets_repo` | — | PR・テスト報告用の画像/GIF を保存するレビュー用アセットリポジトリ（`<owner>/<repo>`、例: `vektor-inc/review-assets`。形式が正しくない値は反映されません） | 空＝画像アップロードをスキップしてテキスト記述 |
| `agents.default_engine` | — | メンバー共通の既定実行エンジン（`claude` / `codex`）。設定パネルの「メンバー共通の既定実行エンジン」。実行エンジンを切り替えられるメンバー（現在は和田・麗美）の個別指定が未設定のときに使われ、`multi_repo_task.default_engine` には効かない | 空＝`claude` |
| `agents.engine.vk-wp-developer` | — | 和田（WordPress 実装担当）の実行エンジン（`claude` / `codex`） | 空＝`agents.default_engine`、それも空＝`claude` |
| `agents.engine.vk-ui-tester` | — | 麗美（UI・e2e テスト担当）の実行エンジン（`claude` / `codex`） | 空＝`agents.default_engine`、それも空＝`claude` |
| `multi_repo_task.default_engine` | — | vk-multi-repo-task を新規作成するときの既定エンジン（`claude` / `codex`）。`agents.default_engine` の影響は受けない | 空＝`claude` |
| `vkAgents.repoPath` | `VK_AGENTS_DIR` / `VK_AGENTS_REPO_PATH` | vk-agents リポジトリのパス。未指定は既知の private clone を優先探索し、無ければ同梱 `vendor/vk-agents-public` を使用 | 自動探索 |
| `vkAgents.disabledSkills` | — | `npm run setup:agents` で展開しないスキル名（vk-agents config の `skills.disabled` へ投影） | `[]` |
| `vkAgents.allowedOwners` | — | スキル実行を許可する GitHub owner（vk-agents config の `org.allowed_owners` へ投影） | `["vektor-inc"]` |

`task.commandTemplate` は orchestrator 自身が消費します（`{issueUrl}` / `{wpPort}` を置換してペインへ投入）。`features.*` / `org.review_assets_repo` / `agents.*` / `multi_repo_task.*` は既存の vk-agents 投影ロジックが読むトップレベル設定を正とし、`vkAgents.*` は vk-agents の場所と setup 用の不足項目（無効化スキル・許可 owner）だけを持ちます。これらは `setup:agents`/`up`/`apply` 時に vk-agents の `config.json` と `~/.claude/vk-agents-settings.json` へ**投影**され、各ペインの Claude エージェントが読み取ります。連携ルールの在り処は設定ではなく、runtime handoff file（`~/.vk-agents/runtime/orchestrator-rules.path`）で渡されます。

`features.coderabbit` / `features.coderabbit_ignore` は、各ペインの Claude エージェントだけでなく orchestrator 自身の自動マージ判定も参照します。自動マージは通常「CodeRabbit の最終コメントから 30 分（コメントが 1 件も無ければ PR 作成から 30 分）新しいコメントが来ないこと」を待ちますが、上の 2 つのいずれかの設定でレビューが来ないと分かっている場合はこの待機を省略し、CI 通過などの条件が揃った時点でマージします。この 2 つは設定パネルが直接編集する vk-agents 正本（`~/.vk-agents/config.json`）を優先して読み、そこに無い場合だけ orchestrator の `config.json` へフォールバックします。
