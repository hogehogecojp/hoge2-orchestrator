# Changelog

- [ 機能追加 ] Claude Code が未導入の場合に `npm start` と `vk-orchestrator doctor` でインストール手順を案内する機能を追加。ペインで Claude Code が起動できず、何も案内されないまま作業が進まない状態を解消。VK Terminals API の接続先が手元以外のマシンの構成では、ペインが接続先マシンで開くため手元の Claude Code は任意（⚠️）として扱う
- [ 不具合修正 ] `vk-orchestrator doctor` の診断結果で、設定値に改行や制御文字が含まれていると表示が行ごと崩れ、未充足の必須項目が充足しているように読めてしまう不具合を修正

= 0.26.0 =

- [ 機能追加 ] VK Terminals との通信で応答を待つ時間の倍率を設定パネルから変更できる項目を追加。Tailscale 越しなど応答が遅い環境で、ターミナルの状態表示や入力待ち検知が途切れる問題を緩和
- [ 機能追加 ] PR のマージを検知したときに、オーケストレーターによる自動マージか外部でのマージかが分かるメッセージを作業ペインへ投稿する機能を追加。いきなりマージされたように見えて経緯が分からない状態を解消
- [ 機能追加 ] 新しい版があるかを確認して自動でアップデートする機能を追加（切り替えは起動時のみ・常駐中は設定画面とサイドバーで通知。`vk-orchestrator update --check` で確認でき、設定パネルの「起動時に自動でアップデートする」で OFF にできます）
- [ 機能追加 ] 同梱エージェント定義が展開済みのものより新しいとき、`up` 起動時に `~/.claude` へ自動で展開し直す機能を追加（同梱のほうが古い場合は展開せず、`vk-orchestrator doctor` に展開済みの版を表示）
- [ 仕様変更 ] vk-terminals を 1.48.0 から 1.49.0 にアップデート
- [ 不具合修正 ] Orchestrator から起動すると設定画面に VK Terminals の「外出先から確認」タブが表示されず、スマートフォンから確認する手順を参照できない不具合を修正
- [ 不具合修正 ] `npm run setup:agents` が vk-agents の一部ファイルのみ書き込みを見送った場合も失敗と判定して中断し、展開元の記録が残らない不具合を修正
- [ 不具合修正 ] リポジトリの版確認で認証を求められると起動処理がパスワード入力待ちのまま止まり、アプリが起動しなくなる不具合を修正（待ち時間の上限と認証プロンプトの抑止を追加）
- [ その他 ] リリース手順（`vk-orchestrator-release`）に、同梱 vendor の更新に連動する README の条件付き注記が残っていないか確認する項目を追加
- [ その他 ] `npm run setup:agents` でエージェント定義と人格ファイルが実際には展開されるのに、README が「書き込みは発生しません」と説明していた注記を削除
- [ その他 ] 同梱 vk-agents-public を vk-agents v0.17.0 に同期

= 0.25.0 =

- [ 機能追加 ] 自動マージ対象の PR がコンフリクトしたとき、担当エージェントへ解消と再レビューを依頼し、上限到達時はタスクへ通知する差し戻し機能を追加
- [ 機能追加 ] 人手でのコンフリクト解消が必要なタスクに要対応バッジと点滅を表示する機能を追加
- [ 仕様変更 ] 設定パネルの実行エンジン項目を「和田（WordPress 実装担当）」「麗美（UI・e2e テスト担当）」に改称し、両者に一括で効く「メンバー共通の既定実行エンジン」を追加（旧設定は次回の `up` / `apply` 実行時に自動で引き継がれるため手作業は不要）
- [ 不具合修正 ] 作業完了後も対象 issue に作業中ラベルが残り続ける不具合を修正
- [ 不具合修正 ] tmux モードで tmux コマンドが応答しないと打ち切られず、タスクの状態監視や起動が止まったまま復帰しない不具合を修正
- [ 不具合修正 ] 返信が作業ペインに届いていなくても転送済みとして記録され、再転送されずタスクが指示を受け取れない不具合を修正
- [ その他 ] `npm run setup:agents` が操作するパスの一覧を README の実挙動に合わせて更新
- [ その他 ] 同梱 vk-agents-public を vk-agents v0.14.0 に同期

= 0.24.0 =

- [ 機能追加 ] 実行面として tmux を選べる tmux モードを追加（`terminals.mode=tmux`。Electron/GUI 不要でコンテナ環境でも動作し、各タスクを tmux ペインに並べて表示）
- [ 仕様変更 ] vk-terminals を 1.46.0 から 1.47.0 にアップデート
- [ 不具合修正 ] VK Terminals が無応答（Tailscale IP 未接続・GUI ハング等）になると状態取得やペイン操作の通信が打ち切られず、タスクの状態監視・入力待ち検知・自動マージ判定や `npm start` の起動が止まったまま復帰しない不具合を修正
- [ 不具合修正 ] 設定パネルで CodeRabbit 監視を OFF にしても自動マージの 30 分待機が省略されない不具合を修正（OFF 運用の環境は、CI 通過などの条件が揃った時点で即時マージに挙動変更）
- [ 不具合修正 ] CodeRabbit のレビュー抑止設定（features.coderabbit_ignore）が自動マージの判定に反映されず、レビューが来ない PR でも 30 分待たされてからマージされる不具合を修正

= 0.23.2 =

- [ 仕様変更 ] vk-terminals を 1.44.0 から 1.46.0 にアップデート
- [ 不具合修正 ] automerge ラベルを PR 作成後に付与すると waiting-input で滞留した issue がマージ判定に乗らず永久に自動マージされない不具合を修正
- [ 不具合修正 ] automerge ラベル付きで waiting-input に滞留した issue の PR を GitHub UI 等で外部から手動マージしても close されず waiting-input のまま残る不具合を修正
- [ 不具合修正 ] ペインの入力欄に残留文字があるとタスク本文がその後ろに連結され、スラッシュコマンドが発火せずタスクが起動しない不具合を修正
- [ 不具合修正 ] Draft PR やレビュー完了マーカー未付与の automerge タスクでも CI 通過直後にマージ待ちへ遷移し、作業が完了していないのにタスクカードが「マージ待ち」表示になる不具合を修正

= 0.23.1 =

- [ 開発環境 ] リリースタグ push をトリガーに、解凍して npm start で動く zip を生成し vk-blocks-pro と同じ VWS サーバーへ自動デプロイするワークフローを新設

= 0.23.0 =

- [ 機能追加 ] タスク編集フォームに自動マージ（する／しない）の選択コントロールを追加し、GitHub モードでは対象 issue の automerge ラベル、ローカルモードではローカルタスク値へ反映
- [ 仕様変更 ] vk-terminals を 1.43.0 から 1.44.0 にアップデート
- [ 不具合修正 ] automerge ラベル判定が設定でのラベル名変更を反映せず綴り直書きになっていた不整合を解消

= 0.22.1 =

- [ 仕様変更 ] vk-terminals を 1.40.0 から 1.43.0 にアップデート
- [ 開発環境 ] リリース時に同梱 vk-terminals / vk-agents を最新へそろえる release スキルと preflight スクリプトを新設

= 0.22.0 =

- [ 機能追加 ] タスク一覧ウィジェット宣言の各タスクに対象 issue の URL を rel:"target" リンクとして出力（ローカルモードでのタイトルリンク先に利用可能）
- [ 仕様変更 ] CodeRabbit 監視が無効（features.coderabbit=false）なリポジトリで automerge の CodeRabbit 静観 30 分待機を撤廃し、CI 全通過・mergeable・レビューマーカーが揃った時点で即時マージするよう変更

= 0.21.0 =

- [ 機能追加 ] 設定画面に staff-review（麗美）の実行エンジン（Claude / Codex）を選択するドロップダウンを追加
- [ 機能追加 ] `queue.backend=local` で GitHub issue に紐づかない純ローカルタスクを登録・一覧・ステータス変更できる CLI を追加
- [ 機能追加 ] タスクキューの保存先を `queue.backend=local` でローカル JSON（`~/.task-queue/queue.json`）へ切り替えられる中核機能を追加
- [ 機能追加 ] 設定画面の「オーケストレーター」グループにキューの保存先（ローカル / GitHub）を切り替えるプルダウンを追加（既定はローカル）。ローカル選択時はタスク登録リポジトリ名の入力欄を非表示に
- [ 機能追加 ] ローカルモードで `GITHUB_TOKEN` 未解決でも純ローカルタスク専用で起動できるように対応（source import・PR 監視・automerge・対象 issue 操作は無効化しログに明示）
- [ 機能追加 ] tasks-view.json のトップレベルに自分の GitHub ログイン名（viewer）を書き出すよう対応（担当者フィルタの「自分のみ」既定判定に利用）
- [ 機能追加 ] タスク一覧の表示定義（語彙・色・遷移・操作）を orchestrator に一元化し、宣言的ウィジェット（tasks-widget.json）として書き出して VK Terminals 設定へパスを注入（旧 tasks-view.json とは当面併存）
- [ 機能追加 ] 初回セットアップスキル `/vk-orchestrator-setup` と、モード（queue.backend）別に必須項目を計算する充足判定 `doctor` コマンドを新設し、`up` の未セットアップ案内を doctor ベースに一般化
- [ 機能追加 ] サイドバーのタスク編集で複数項目（ステータス／優先度／実行方式）を 1 回でまとめて確定し、1 つでも現在値と食い違えば全て破棄する一括確定コマンド（apply-batch）を新設
- [ 仕様変更 ] 設定画面 Orchestrator タブを「オーケストレーター」→「GitHub」の 2 グループ構成に整理し、「issue を処理する Claude のコマンド」を独立グループから「オーケストレーター」グループの末尾へ統合
- [ 仕様変更 ] 設定画面で担当者フィルタ（担当者ログイン）を「オーケストレーター」セクションから「GitHub」セクションへ移動
- [ 仕様変更 ] 設定画面（Orchestrator・VK Agents タブ）の説明文言で地の文に流し込んでいた箇条書き・例を改行して読みやすく整形
- [ 仕様変更 ] 設定画面「タスク登録リポジトリ名」の説明文を task-queue 依存の表現からオーケストレーター基準の表現に修正
- [ 仕様変更 ] 設定ディスクリプタの保存後反映タイミング案内をタブごとの note として出力し、誤解を招く全体 note を撤去
- [ 仕様変更 ] VK Terminals サイドバーの「VK Orchestrator」セクションから task-queue 項目を削除（導線はタスク一覧見出しのリンクへ一本化）
- [ 仕様変更 ] vk-terminals を 1.38.0 から 1.40.0 にアップデート（タスク一覧の宣言的ウィジェット描画・設定パネルのタブ別 note・サイドバー／モバイルのステータス表示や PR バッジの共通化などに対応）
- [ 不具合修正 ] コールドスタート時に起動バナーがタスク本文を飲み込み、ラベルだけ in-progress・ペインが空プロンプトのまま放置される不具合を修正（readiness 待ちと本文再送を強化し、本文未達時は status:ready へ戻して自動再ディスパッチ。`CLAUDE_READY_TIMEOUT_MS` / `CLAUDE_SUBMIT_DELAY_MS` / `CLAUDE_SUBMIT_MAX_RETRIES` で調整可）
- [ 不具合修正 ] 自前 PR を持たない親調整 issue が全 sub-issue 完了後も in-progress のまま残る不具合を修正
- [ 不具合修正 ] GitHub API 障害（5xx）で status:in-progress への遷移に失敗した ready タスクが、poll のたびに新規ペインを量産する不具合を修正
- [ 不具合修正 ] VK Terminals のタスクパネル保存後に tasks-view snapshot が即時更新されず反映待ちがタイムアウトする不具合を修正
- [ 不具合修正 ] 同一マシンを非ループバックの IP（Tailscale 等でのリモート／モバイル公開）でバインドしている場合に、タスクペインが対象リポジトリのローカルクローンで開かず ~/vk-orchestrator-tasks にフォールバックする不具合を修正
- [ その他 ] 設定パネルのエンジン選択ドロップダウンの表示ラベルを Codex / Claude 表記に統一
- [ その他 ] タスク一覧 snapshot 生成のタスクキュー全件取得を GitHubClient のインターフェースメソッド（listAllQueueIssues）経由に整理し、キュークライアントの契約テスト雛形を追加

= 0.20.0 =

- [ 機能追加 ] タスク一覧 snapshot に優先度・直列実行情報を追加し、VK Terminals からの優先度変更・直列/並列切り替え・承認待ち差し戻し依頼に対応
- [ 仕様変更 ] vk-terminals を 1.29.0 から 1.31.0 にアップデート（タスク一覧に優先度・直列/並列の表示と編集 UI・差し戻し操作を追加・見出しクリックでの折り畳みに対応・タスク操作の反映待ち表示を反映確認まで維持するように変更）

= 0.19.0 =

- [ 機能追加 ] tick ごとに task-queue の全タスク表示用 snapshot（`~/.task-queue/tasks-view.json`）を書き出し、`up` 起動時に VK Terminals 設定へパスを注入
- [ 機能追加 ] VK Terminals からのステータス変更依頼を `commands.jsonl` で受け付け、CAS と許可遷移チェックを通して GitHub ラベルへ適用
- [ 仕様変更 ] vk-terminals を 1.25.0 から 1.29.0 にアップデート（設定スキーマ `settings-schema.json` の同梱・設定画面の説明文拡充・入力待ち除外 cwd 設定を config 直編集専用に変更・起動時初回ペインの初期ディレクトリ不具合修正・サイドバー／モバイルのタスク一覧とステータス変更依頼 UI を追加）
- [ 仕様変更 ] 設定パネルの VK Terminals 本体設定を vk-terminals 同梱の設定スキーマから読み込む方式に変更し、本体との説明文ズレや項目漏れを解消
- [ 仕様変更 ] VK Terminals の GPU 起動モード設定を本体 config の `gpu` に一本化し、オーケストレーター側の起動オプション設定欄を撤去
- [ 仕様変更 ] タスクペインの起点ディレクトリを issue 対象リポジトリのローカルクローン（workspace.search_paths から自動検出）に変更し、orchestrator.taskCwd 設定を廃止（未検出時は従来どおり ~/vk-orchestrator-tasks で起動）
- [ 不具合修正 ] エージェントが手動マージ後にメタ issue を先にクローズすると、ペインの PR ラベルがマージ済み表示に切り替わらず state.json のエントリも消し込まれない不具合を修正
- [ その他 ] 旧 orchestrator config の `vkTerminals.port` を VK Terminals 本体 config へ初回移行する過渡的な後方互換処理を撤去 (#104)
- [ その他 ] 同梱 vk-agents-public ドキュメントの Codex 表記を統一

= 0.18.0 =

- [ 仕様変更 ] vk-terminals を 1.24.0 から 1.25.0 にアップデート（ペインの cwd パターン指定でローカル入力待ち判定から除外・実行中／入力待ちペインの誤クローズ防止の確認ダイアログ confirmClose を追加）
- [ 仕様変更 ] 設定パネルの Agents タブ名を「VK Agents」に変更し、設定項目の説明文言を調整
- [ 不具合修正 ] GitHub API エラー時にレスポンス本文や認証ヘッダが端末ログへ大量出力され、秘匿情報露出や入力待ち誤判定を引き起こす不具合を修正
- [ 開発環境 ] 設定項目の説明文言変更（claude → Claude）に追随していなかった設定 descriptor のユニットテスト期待値を修正

= 0.17.0 =

- [ 機能追加 ] 設定パネルの Agents タブに、エージェントの作業ディレクトリ（複数指定・優先順）を設定する欄を追加
- [ 仕様変更 ] vk-terminals を 1.22.0 から 1.24.0 にアップデート（設定 descriptor の配列入力型 lines に対応・モバイル版ターミナル下部の未使用クイック入力コントロールを削除）
- [ 仕様変更 ] `org.orchestrator_repo` 設定を撤去し、連携ルールのパスを handoff file（`~/.vk-agents/runtime/orchestrator-rules.path`）で agent へ渡す方式に変更
- [ 不具合修正 ] メタ issue の PR マージ完了コメントの文言が投稿経路で食い違い、完了コメントが二重投稿される不具合を修正

= 0.16.0 =
- [ 機能追加 ] done-gate を sub-issue 対応にし、親 issue の全 sub-issue が closed になるまでメタ issue を done 化しないことで、複数 PR にまたがるタスクで一部マージ時に起きる早期完了・孤児化を防止
- [ 機能追加 ] up 起動時に作成する orchestrator 用ペインを閉じる保護（ロック）で保護し、誤ってペインを閉じて本体プロセスが停止する事故を防止
- [ 仕様変更 ] vk-terminals を 1.18.1 から 1.22.0 にアップデート（設定パネルのタブ UI 対応・API 待受ポートを本体 config から設定可能に・ペインの閉じる保護 API 対応・`/api/health` に起動インスタンス識別子 `instanceId` を追加）
- [ 仕様変更 ] 設定パネルを Orchestrator / Terminals / Agents の 3 タブ構成に変更
- [ 仕様変更 ] VK Terminals の API ポート設定を本体 config（`~/.vk-terminals/config.json`）へ一本化
- [ 仕様変更 ] 旧 orchestrator config の `vkTerminals.port` を VK Terminals 本体 config へ初回移行する処理を追加
- [ 不具合修正 ] 複数の VK Terminals 起動時に `up` が既存ウィンドウへ orchestrator ペインを作成する不具合を修正
- [ 不具合修正 ] 実働中や別状態への遷移後にペインの「入力待ち」バッジが消えず点きっぱなしになる不具合を修正
- [ 不具合修正 ] GUI で設定した CodeRabbit 監視などの vk-agents 設定が Orchestrator 起動のたびにリセットされる不具合を修正
- [ 開発環境 ] vk-terminals の最新リリースに依存ピン（optionalDependencies）を自動追従する GitHub Actions（repository_dispatch／毎日 schedule／手動）を追加

= 0.15.0 =
- [ 機能追加 ] GUI 起動時にウィンドウタイトルバーとヘッダーの表記を `VK Orchestrator` にする（`VK_TERMINALS_APP_TITLE` を付与）
- [ 仕様変更 ] 設定パネルを各ツールの永続 config へ直接読み書きするマルチターゲット構成に変更
- [ 仕様変更 ] vk-terminals を 1.17.1 から 1.18.1 にアップデート（設定パネルのマルチターゲット対応、ペインタイトルと PR ボタンの余白調整）

= 0.14.0 =
- [ 仕様変更 ] vk-terminals を 1.16.0 から 1.17.1 にアップデート
- [ その他 ] 対象リポ issue のクローズ責務（Closes #N・オーケストレーター・Agent の多層）と、done-gate が対象 issue の closed 状態をメタ issue の done 遷移判定に使う挙動を README・docs/agent-rules.md に明記

= 0.13.0 =
- [ 仕様変更 ] 設定パネルの「タスク」項目を「issue を処理する Claude のコマンド」に名称変更して vk-agents 共通設定の上へ移動し、用途の説明文を追加
- [ 仕様変更 ] 設定パネルのレビュー用アセット／連携ルール取得先リポジトリ欄に owner/repo 形式の入力検証を追加し、不正な形式を保存時に弾いてエラー表示
- [ 仕様変更 ] vk-terminals を 1.15.4 から 1.16.0 にアップデート

= 0.12.0 =
- [ 機能追加 ] npm start 起動時に vk-orchestrator 自身の新しいリリースタグを検出し main を ff 追従・再起動してから起動する自己更新機能を追加
- [ 機能追加 ] オーケストレーターの console 出力をタイムスタンプ付きの永続ログへ保存する機能を追加
- [ 機能追加 ] start の多重起動をロックファイルで検知して state.json の競合を防止する機能を追加
- [ 機能追加 ] setup:agents コマンドで同梱 vk-agents-public から skills/rules を展開し、up 起動時に未セットアップを案内する機能を追加
- [ 機能追加 ] 設定パネルからレビュー用アセットリポジトリとオーケストレーター連携ルール取得先リポジトリを設定できる機能を追加
- [ 機能追加 ] GUI 設定パネルから CodeRabbit レビューを ignore する vk-agents 設定を変更できる機能を追加
- [ 仕様変更 ] vk-terminals を 1.15.0 から 1.15.4 にアップデート
- [ 仕様変更 ] GitHub トークン取得を gh auth login 前提にし、config.json への平文保存導線を撤去
- [ 不具合修正 ] PR マージ検知時に state から termId を取得できず連動ペインのマージ済み表示が更新されない不具合を修正
- [ 不具合修正 ] scan-in-progress 経路でマージ検知した場合に連動ペインの PR ボタンがマージ済み表示にならない不具合を修正
- [ その他 ] README の設定項目表と config.example.json を実態に合わせ、task/features/staff_wp_dev/multi_repo_task/vkAgents の各設定とテスト件数など乖離していた記述を更新

= 0.11.0 =
- [ 機能追加 ] PR のマージ検知時に VK Terminals の連動ペインへ prMerged を送信し、PR ボタンをマージ済み表示（紫）へ切り替える機能を追加
- [ 機能追加 ] タスク用ペインの起点ディレクトリを config（orchestrator.taskCwd / env TASK_CWD）で指定可能にし、未設定時の既定を専用ディレクトリ（~/vk-orchestrator-tasks・自動作成）としてホームディレクトリ／機密ディレクトリを起点にしないように変更
- [ 仕様変更 ] vk-terminals を 1.14.0 から 1.15.0 にアップデート

= 0.10.0 =
- [ 仕様変更 ] vk-terminals を 1.13.0 から 1.14.0 にアップデート
- [ 不具合修正 ] wp-env 無効時に vk-kore 起動コマンドへ未展開の `wp-env-port={wpPort}` が残って送出される不具合の修正
- [ 不具合修正 ] ペインへの本文再送時に入力行をクリアせず起動コマンドが重複連結される不具合の修正
- [ 不具合修正 ] 入力待ちマーカーが set-title 相乗り経路で VK Terminals に届かず「入力待ち」ラベルが点灯しない不具合を修正（正規の /api/set-status 経路へ変更）
- [ 不具合修正 ] wp-env を使わないタスクで automerge 後にマージ済みブランチがリモートを含めて削除されず残る不具合を修正
- [ 不具合修正 ] automerge/マージ後に本体 issue（クロスリポ）が close されず、メタ issue が status:waiting-merge に固着する不具合を修正

= 0.9.0 =
- [ 機能追加 ] status:waiting-input の issue 連動ペインに入力待ちマーカーを push し、定期監視で再点灯／in-progress 復帰時に消灯する機能を追加
- [ 仕様変更 ] automerge 完了ゲートを `agent-review-passed` マーカー規約に一本化し、`requireE2eGate` 設定を廃止
- [ 仕様変更 ] vk-terminals を 1.12.0 から 1.13.0 にアップデート
- [ 不具合修正 ] 設定パネルの「automerge の e2e ゲートを必須化」チェックボックスが、保存値なしの初期状態で実際の既定（ON）と異なり未チェック表示になる不具合を修正

= 0.8.0 =
- [ 機能追加 ] up で起動する orchestrator ペインを、VK Terminals のサイドバーに格納した折りたたみ状態で開くように
- [ 仕様変更 ] vk-terminals を 1.11.1 から 1.12.0 にアップデート

= 0.7.0 =
- [ 機能追加 ] wp-env ポート割り当てに空きポート自動探索を追加し、決定論的な起点から占有中・8888/8889・他タスク使用中のポートを避けて割り当て
- [ 機能追加 ] GUI 設定パネルから vk-agents の CodeRabbit 監視・和田/マルチリポタスクの実行エンジンを設定できる機能を追加
- [ 仕様変更 ] 作業対象リポジトリの issue に投稿する取り込み・完了・失敗の通知コメント文言を「task-queue」から「オーケストレーター」表記に変更
- [ 仕様変更 ] vk-terminals を 1.10.1 から 1.11.1 にアップデート

= 0.6.0 =
- [ 仕様変更 ] wp-env 連携の ON/OFF を、対象リポジトリの `.wp-env.json` 有無から着手時に自動判定するようにし、GUI の手動トグル（wp-env 連携を有効化）を撤去（`task.wpEnv.enabled` の config.json / 環境変数での明示指定は自動判定より優先する脱出ハッチとして存続）
- [ 仕様変更 ] 設定 UI から「エージェントルーム表示」トグルを撤去（config.json の `vkTerminals.agentroom` 直書きでのみ上書き可）
- [ 仕様変更 ] vk-terminals を 1.9.1 から 1.10.1 にアップデート
- [ 仕様変更 ] 設定項目 owner/repo/sourceOrg のラベル・ヘルプを「タスク登録リポジトリ」「作業対象リポジトリ」に統一し、曖昧だった「監視対象」表記を解消
- [ 開発環境 ] bump:terminals（bump-vk-terminals.mjs）から CHANGELOG 自動書き換えを撤去し、依存バージョンの更新のみに変更（changelog 追記はリリース工程で対応）

= 0.5.0 =
- [ 機能追加 ] 起動時・VK Terminals 接続時に、サイドバーメニューへ「VK Orchestrator」セクション（task-queue の issue 一覧を開く項目）を POST /api/menu で冪等に投入するように

= 0.4.0 =
- [ 仕様変更 ] assigneeFilter が null/空のときは issue を一切取り込まず、全件取り込みは "all" の明示指定に変更（新規ユーザーの誤取り込みを防止）
- [ 仕様変更 ] vk-terminals を 1.5.2 から 1.9.1 にアップデート

= 0.3.0 =
- [ 機能追加 ] `up` の GUI(Electron) 起動に GPU モード設定（config `vkTerminals.gpu` / env `VK_TERMINALS_GPU`）を追加。`off`（既定・非 macOS）でエラー抑制、`default` で Chromium 任せを選択可能
- [ 機能追加 ] watch モード常駐中の OS スリープを防止（macOS は caffeinate、Windows は SetThreadExecutionState。orchestrator 終了で自動解除。`VK_ORCHESTRATOR_NO_KEEP_AWAKE=1` で無効化可）
- [ 仕様変更 ] 手動マージ時のメタ issue クローズ手順に前提チェック（closed / status:done ならスキップ・各ステップの冪等化）を追記し、オーケストレーターの自動クローズとのレースによる重複を防止
- [ 仕様変更 ] vk-kore 起動プロンプトの既定テンプレートに headless=1 を追加し、{wpPort} の有無に関わらず無人モードで起動する正式トリガーへ移行（wp-env-port 依存の過渡措置を解消）
- [ 仕様変更 ] 設定 UI からプロトコル（Status 行接頭辞・トークン）/ラベル（status・priority・automerge 等）/wp-env ポート（portBase・portStride）を撤去し、決めうち定数＋config.json 上書きに集約
- [ 不具合修正 ] 非 macOS（WSLg 等）で `up` 実行時に Chromium の GPU 初期化が失敗し、GUI 起動時に `Exiting GPU process` / `kTransientFailure` 等のエラーログが大量に出る不具合を修正（GPU を無効化して抑制。ターミナル用途で描画への影響なし）
- [ 不具合修正 ] GUI 設定パネル保存時に未入力項目が空値（空文字 / 空配列 / null）で書き戻され、`task` / `protocol` / `labels` の既定値を潰してタスク検出・起動が動かなくなる不具合を修正（getter 側で空値を未指定とみなし既定へフォールバック）
- [ セキュリティ修正 ] ペインタイトル送信側（buildPaneTitle 出力）にも制御文字（C0/DEL/C1）除去を追加し、外部由来の issue タイトルを送信前に正規化（多層防御）
- [ その他 ] まっさらな WSL2(WSLg) Ubuntu で動かすためのセットアップ手順（`docs/WSL-UBUNTU-SETUP.md`）を追加し、README 前提に WSL 対応を明記

= 0.2.0 =
- [ 機能追加 ] automerge の e2e 完了ゲートを config でオプション化（`task.requireE2eGate`、既定 true）。false にすると e2e を回さないプロジェクトでもマーカー無しで automerge が進む（CI/CodeRabbit ゲートは維持）
- [ 機能追加 ] 作業ペイン（termId）消失時、対象 issue に PR が未生成なら wp-env 掃除のうえ自動で再実行（`status:ready` へ再キュー）する機能を追加。上限回数（既定 3 回。`orchestrator.paneResumeMax` / `PANE_RESUME_MAX` で上書き可）を超えると従来どおり `status:failed`＋手動確認に
- [ 仕様変更 ] 各ペインのヘッダーに表示する issue 名・リンクを、task-queue の複製 issue ではなく元の作業対象リポジトリの issue のものにするように
- [ 仕様変更 ] 作業対象リポ側の issue に付ける作業中ラベルの既定名を「作業中」から「working」に変更し、GUI 設定項目から撤去（config.json の `labels.workingInProgress` 直書きでのみ上書き可）
- [ その他 ] 未使用だった `labels.e2ePassed` / `e2ePassedShaPrefix` の config・GUI 枠を撤去（マーカー名は `src/github/index.js` の固定定数に集約）
- [ その他 ] 対応 PR の紐付けが PR 本文の `Closes #N` 等の GitHub クローズキーワードを前提とする旨を README の前提に明記
- [ その他 ] エージェント振る舞いルール（automerge での停止禁止・e2e 完了マーカーの付与責務・メタ issue クローズの責務）を `docs/agent-rules.md` として task-queue から移設

= 0.1.0 =
- [ 機能追加 ] タスク着手コマンドを config テンプレート化（`task.commandTemplate` / `portBase` / `portStride`）。`task.wpEnv.enabled: false` で wp-env 連携（ポート割り当て・state 保存・クリーンアップ）を無効化し、vk-kore 以外のスキルや素のプロンプトも起動可能に（既定は現行と同一挙動）
- [ 機能追加 ] 汎用化に向け config.json に task / protocol / labels セクションと既定値・getter・GUI 設定枠を追加（既定値は現行のハードコード値のため単体では挙動不変）
- [ 機能追加 ] 設定パネルの各項目に説明文（help）を追加し、Repo・Queue Label・ウォッチドッグ idle などの意味と入力例を GUI 上で確認できるように
- [ 機能追加 ] `up` 起動時に VK Terminals(GUI) のタイトルバー ⚙ ボタンから統合 `config.json` を編集・保存できる設定パネルを追加。`up` が設定ディスクリプタ（編集対象パス + 項目スキーマ）を書き出し、環境変数 `VK_TERMINALS_SETTINGS` で GUI に渡す。これにより GitHub トークン等を手編集せず GUI 上で設定できる（保存後、orchestrator の再起動で反映）
- [ 機能追加 ] `up`（`npm start`）起動時に vk-terminals のリモート最新タグを自動取得し、node_modules が古ければ入れ直してから GUI を起動するように（vk-terminals 側でタグを打つだけで各環境が最新に追従し、orchestrator の bump/push/pull が不要に。`VK_TERMINALS_TAG` で版固定、`VK_TERMINALS_NO_AUTO_UPDATE=1` で自動追従の無効化も可能）
- [ 機能追加 ] VK Terminals を明示的に導入・検証する `setup-terminals` サブコマンド（`npm run setup:terminals`）を追加。optionalDependencies のビルド失敗で黙って除外されるケースを検知し、ビルドログと原因（Xcode CLT 未導入・非 macOS 等）を表示。`up`／`apply` 時の未導入メッセージも原因と復旧手順を示すよう改善
- [ 機能追加 ] キューリポに運用ラベル一式（`status:*` / `priority:*` / `sequential` / `parallel` / `automerge`）を色・説明つきで一括登録する `--status` モードを `ensure-task-queue-label.mjs` に追加し、`npm run setup:queue-labels` として実行できるよう package.json に登録
- [ 仕様変更 ] assignee 設定時、source issue の取り込みを「自分にアサインされた issue のみ」に限定し、取り込んだ task-queue issue にも取り込んだユーザーを自動アサイン（誰が取り込み・処理するかを明確化。未設定時は従来どおり全件取り込み）
- [ 仕様変更 ] vk-terminals 依存をタグ `1.5.2` に固定し、取得を SSH から https に変更（ブランチ HEAD 追従をやめ、SSH 鍵なしの環境でも導入できるように）
- [ 仕様変更 ] decision-record コメントの判定を識別行マーカー（`Comment by vk-agents`）非依存にし、単独行の `Status:` トークンのみで判断するように（コメント1行目が任意でも動作。`protocol.agentMarker` 設定は撤去）
- [ 仕様変更 ] ドキュメント・UI 表示・ログ・コメントの製品名表記を VK Orchestrator / VK Terminals に統一（コマンド・パス・パッケージ名などのコード上の識別子は従来どおり小文字）
- [ 不具合修正 ] コールドスタート時に Claude Code の起動バナーがプロンプト本文を飲み込み、`/vk-kore` 等の指示が入力欄に届かないまま処理が進んでしまう不具合を修正
- [ 不具合修正 ] org リポの一括ラベル登録が1ページ目（100件）しか処理せず、100件を超えるリポにラベルが登録されない不具合を修正
- [ 開発環境 ] vk-terminals 依存の更新（タグ解決 → package.json / package-lock.json / CHANGELOG 書き換え → 検証）をまとめて行う `npm run bump:terminals <version>` を追加
- [ その他 ] README のセットアップ手順に、初回設定で必須なのは `github.token` / `owner` / `repo` の 3 項目のみで、`vkTerminals.port` / `host` は既定値のままでよい旨を明記
- [ その他 ] 取り込み対象ラベルの一括登録手順を README に追記し、`npm run setup:labels`（`ensure-task-queue-label.mjs`）として実行できるよう package.json に登録。ラベル名は config.json / `QUEUE_LABEL` に追従（既定 `task-queue`）
- [ その他 ] README に GitHub Personal Access Token の発行手順（Classic PAT / `repo` スコープ / SAML SSO 認可）・設定方法（config.json / 環境変数 / GUI）・取り扱い注意を追記
