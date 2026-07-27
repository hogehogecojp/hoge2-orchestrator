> **注意:** このファイルは vk-agents-public（vk-agents からの複製）です。直接編集しないでください。改善要望は https://github.com/vektor-inc/vk-orchestrator/issues へお願いします。

> **スキル連携:** このファイルは `skills/vk-pr/SKILL.md` から参照されています。Claude Code（.claude）環境では `/vk-pr` コマンドで本ルールに従った PR 作成を実行できます。CodeRabbit 監視・CI 起動は呼び出し元エージェント（通常は司 = `/vk-kore`）の責務です（手順は [coderabbit-monitoring.md](coderabbit-monitoring.md) を参照）。

# プルリクエストのルール

判断基準・手順のみをまとめます。確認手順テンプレート・記載例は [pull-request-examples.md](pull-request-examples.md) を参照してください。

## PR 作成前の確認

### ブランチの確認

`git branch --show-current` で現在のブランチを確認してください。

- **main / master ブランチにいる場合**: 変更内容に応じた適切なブランチ名で新しいブランチを作成する（`git checkout -b <ブランチ名>`）
- **すでに作業ブランチにいる場合**: そのまま次の手順に進む

### コーディングルールの確認

PHP・JS などプログラムファイルを変更した場合、`coding-rules.md` を Read で読み、変更内容がルールに沿うか確認してください。問題があれば PR 作成前に修正します。

特に **コメントの記載言語**（`coding-rules.md` の「コメント言語」）は必ず確認してください。対象プロジェクトの `readme.txt` の有無・言語から記載言語を判定し（判定基準は `coding-rules.md` を唯一の正とする）、追加・変更したコメントで **日本語のみと判定されるプロジェクトに英語を併記していないか**（逆に英日併記プロジェクトで片方を欠いていないか）を照合します。違反があれば PR 作成前に修正します。

### デザインルールの確認

CSS・SCSS などデザイン関連ファイルを変更した場合、`design-rules.md` および `css.md` を Read で読み、変更内容がルールに沿うか確認してください。問題があれば PR 作成前に修正します。

### PHPUnit テストの確認

PR に PHP の関数・メソッド追加が含まれる場合、対応する PHPUnit テストの有無を確認する。

- テストが存在しない場合、ユーザーに追加を促してください。
- ただし、以下のケースではテストを書かないことも許容されます。
  - WordPress のフック・フィルターのみを扱う処理など、単体テストになじまない実装
  - テスト環境の制約でテスト不可能な処理
- テストを書かない場合は、理由をユーザーに確認した上で PR 作成に進んでください。

## タイトルと概要

- PR の概要（description）は日本語で記載してください。
- **概要・確認手順など本文の説明は「実際にどう動くか」で書いてください。** メソッド名や専門用語を出す場合は、それが何をするものかを添えます。書き方の原則・NG/OK 例は [description-rules.md](description-rules.md) を参照してください。
- **PR タイトルの記載ルール（分類・ブロック名・体言止め・原因→結果・記載言語など）は [change-title.md](change-title.md) を参照してください。** changelog の各行と PR タイトルは同じ書式で記載します。

## 元 issue の参照

PR 本文には、対応する元 issue を閉じるクローズキーワード＋issue 番号（`Closes #N` / `Fixes #N` / `Resolves #N` のいずれか）を **1 行含めてください**。PR がデフォルトブランチへマージされると GitHub が元 issue を自動クローズします。

- 例: `Closes #203`
- 裸の `#N`（キーワードなし）や本文中のリンクだけでは issue は閉じません。必ずクローズキーワードを添えます。
- PR と issue が **別リポジトリ** の場合は `Closes owner/repo#N` の形式を使います（例: `Closes vektor-inc/vk-agents#203`）。
- 「参照はするが閉じたくない」場合に限り、クローズキーワードを使わず issue の完全 URL（`関連 issue: <完全 URL>` の 1 行）を記載します。

**複数リポにまたがるタスク（サブ issue 分割時）**

親 issue をサブ issue に分割している場合、各 PR は自分のサブ issue のみを `Closes #N` で閉じます。同一リポジトリのサブ issue なので、原則は裸番号です。

- 親 issue にはクローズキーワードを付けない。早期クローズにより 2 本目以降のサブ issue / PR が孤児化するのを防ぐためです。
- 親 issue を参照する必要がある場合は、`親 issue: <完全URL>` の 1 行のみを記載し、`Closes` / `Fixes` / `Resolves` は使わない。
- PR とサブ issue が別リポジトリになる例外時のみ、既存ルールどおり `Closes owner/repo#N` の形式を使う。

## CodeRabbit ignore 指定

`rules/coderabbit-monitoring.md` の前提条件で `features.coderabbit` が有効（`false` でない）かつ `features.coderabbit_ignore: true` と判定される場合、PR 本文に `@coderabbitai ignore` を 1 行含めてください。`features.coderabbit: false` の場合は CodeRabbit 未導入扱いを優先し、`@coderabbitai ignore` は記載しません。判定詳細は [coderabbit-monitoring.md](coderabbit-monitoring.md) の前提条件を唯一の正とします。

## changelog の確認と記載

PR作成前に、以下の手順で changelog を確認・更新してください。詳細は [changelog.md](changelog.md) を参照してください。

### 1. changelog ファイルの特定

[changelog.md](changelog.md) の「記載対象ファイル」に従って対象ファイルを特定する。

### 2. 既存 changelog の言語確認

changelog ファイルを `Read` で読み込み、[changelog.md](changelog.md) の「記載言語」に従って記載言語を決める。

### 3. changelog の記載有無を確認

変更内容が changelog に記載されているか確認してください。

- **記載されている場合**: [changelog.md](changelog.md) と [change-title.md](change-title.md) のルールに従っているか確認。従っていない場合は修正。
- **記載されていない場合**: [changelog.md](changelog.md) と [change-title.md](change-title.md) のルールに従って changelog を追記してから PR 作成に進む

エントリ追記時は、先頭に積まず [change-title.md](change-title.md) の「分類の並び順」に従い、未リリースのエントリ群内の分類グループへ挿入します（判定基準は change-title.md / changelog.md を唯一の正とする）。

### 4. 記載内容のセルフチェック・自動補正（commit 前）

changelog を書き終えたら、**commit する前に必ず** 以下を実行し、追加・修正したエントリが [changelog.md](changelog.md) のルールに沿うか確認してください。違反があればその場で書き直します。長すぎるエントリを取りこぼさないためです。

1. このブランチで追加・修正した changelog エントリを抽出する:

   ```bash
   git diff main...HEAD -- <changelog ファイルパス> 2>/dev/null \
     || git diff origin/main...HEAD -- <changelog ファイルパス> 2>/dev/null \
     || git diff --cached -- <changelog ファイルパス>
   ```

   （まだ stage していない場合は `git diff -- <changelog ファイルパス>` でも可）

2. [changelog.md](changelog.md) と [change-title.md](change-title.md) を **改めて Read で読み込み**、抽出したエントリが以下を満たしているか照合する。**判定基準はルールファイルを唯一の正としてここでは複製しないこと**（ここへ直書きすると二元管理になり、ルール更新が反映されなくなるため）。

   - 特に [changelog.md](changelog.md) の「## 記載量」で定義された **1エントリにつき長くとも2行以内** に収まっているか
   - 分類・体言止め・原因→結果などタイトル本体のルール（[change-title.md](change-title.md)）

3. ルール違反と判定した場合は、エントリ本体を短縮し、**実装詳細・経緯・検証内容は PR 本文（description）へ移管**する。書き直し後はもう一度 1〜2 を実行し、ルールに収まっていることを確認してから commit に進む。

ルールに沿っていれば、修正せず次の commit / PR 作成へ進む。

## テスト（確認手順）

PRの概要（description）には、**ドメイン知識がないレビュワーやAIでも再現・検証できる**確認手順を記載してください。

### 基本方針

- 「何を確認するか」だけでなく「**どうやって確認するか**」を書く
- 手順は番号付きリストで、1ステップ1アクションにする
- 期待結果は各ステップまたはステップ群の直後に `→` で明示する
- 不具合修正の場合は **修正前の再現手順**（Before）と **修正後の確認手順**（After）を分けて書く

### 記載フォーマット

記載フォーマットの雛形は [pull-request-examples.md](pull-request-examples.md) を参照してください。

### 書くべき内容

前提条件・操作対象の場所・具体的な操作・期待結果・デグレ確認の一覧と例は [pull-request-examples.md](pull-request-examples.md) を参照してください。

### スクリーンショット

**表示・UI に関わる変更が含まれる場合は、Before / After のスクリーンショットを PR の概要に必ず添付してください。**

対象例:
- フロント側の見た目（レイアウト・色・余白・フォントなど）の変更
- ブロックエディタや管理画面 UI の変更
- CSS / SCSS の変更
- レスポンシブ表示の変更

記載例は [pull-request-examples.md](pull-request-examples.md) を参照してください。

注意事項:

- 変更箇所が一目でわかるよう、**同じ画面・同じ条件**で撮影した Before / After を並べる
- レスポンシブの変更を含む場合は、影響するブレークポイント（例: PC / タブレット / モバイル）ごとに添付する
- 純粋なロジック修正・内部処理の変更で表示に影響がない場合は省略可
- アニメーション・開閉・ホバーなど動きの確認が必要な変更は、静止画ではなく録画を GIF に変換して添付する
- 画像・GIF を `org.review_assets_repo` で設定されたレビュー用アセットリポジトリに保存して埋め込む場合は `?raw=true` 形式を使う。未設定・空の場合は画像の保存・埋め込みをスキップし、テキストで確認要点を書く（詳細は [testing/e2e.md](testing/e2e.md) の「画像・GIF の埋め込み URL 形式」を参照）
- 録画・GIF に確認不要な機密情報（ログイン画面・顧客の個人情報・API キー／ライセンスキー等の設定画面・URL 内のトークン・別タブ）を含めない。画面そのものが確認対象の場合はダミー／サンプルデータで撮影する（詳細は [testing/e2e.md](testing/e2e.md) の「録画・GIF に機密情報を含めない」を参照）

### 注意事項

- 「動作確認してください」「問題ないことを確認」のような抽象的な記載は不可。**具体的に何をどう操作し、何が起きれば正しいか**を書く
- ブロックエディタの操作は、ブロック名・サイドバーのパネル名・設定項目名を明記する
- レスポンシブの確認が必要な場合は、確認すべきブレークポイント（例: 576px以下）を明記する

## PR 作成後の対応（CodeRabbit 監視）

PR 作成後の CodeRabbit 監視・指摘トリアージは **呼び出し元のエージェント（通常は司）の責務** です。手順と責務は [coderabbit-monitoring.md](coderabbit-monitoring.md) を参照してください（責務の明文化は同ファイルを唯一の正とします）。同ファイルの前提条件でスキップ判定になる場合は CodeRabbit 監視・返信を行いません。CI（`run-ci` ラベル）はスキル・エージェントから付与せず、手動・リリース時のみ実行します（同ファイル「CI について」参照）。

PR 作成者（実装担当のサブエージェント）の責務は **PR を作成し、PR URL を呼び出し元にハンドオフするまで** です。`START`（監視開始時刻）は取得しません。PR 作成 → CodeRabbit 即応答 → ハンドオフ の順序競合で投稿を取り逃すため、呼び出し元が PR の `createdAt` から取得します。
