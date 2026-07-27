---
name: vk-rtc-test
description: "RTC（リアルタイム共同編集）テストを実行する。PRまたはIssueのURLとローカル環境情報を受け取り、Playwrightで2ユーザー同時編集をシミュレートしてチェックリストに沿って検証する。"
---

# /vk-rtc-test スキル

> **前提条件（硬ゲート）:** 対象リポジトリの owner が許可リスト `org.allowed_owners`（`~/.vk-agents/config.json`）に含まれる場合のみ使用できます。判定は `rules/repository-access.md` を参照してください（許可リスト未設定時は確認のうえ続行可）。

WordPress 7.0のRTC（Real-Time Collaboration）対応を、Playwrightで2ユーザー同時編集をシミュレートして検証する。

## 引数

```
/vk-rtc-test <PR_URL or ISSUE_URL> --site <SITE_URL> --users <USER1>:<PASS1> <USER2>:<PASS2>
```

| 引数 | 必須 | 説明 |
|------|------|------|
| `PR_URL or ISSUE_URL` | ○ | GitHub PRまたはIssueのURL |
| `--site` | ○ | テスト対象のローカルWordPressサイトURL |
| `--users` | ○ | テストユーザー（2名以上）。`ユーザー名:パスワード`形式、スペース区切り |

## 手順

### ステップ0: ルールファイルの読み込み

テスト前に以下を **必ず`Read`ツールで読む**:

- `REPO_ROOT/rules/testing/rtc.md`（RTCテストのチェック項目・判定基準）
- `REPO_ROOT/rules/testing/e2e.md`（共通e2eテストルール）

※ `REPO_ROOT` = vk-agentsリポジトリのルート。`vk-sync-skills`でローカル同期済みならそのパスを使う。パスは`Glob`ツールで`**/rules/testing/rtc.md`を検索して特定する。

### ステップ1: テスト対象を把握する

#### PRのURLが指定された場合

1. `gh pr view <PR番号> --repo <owner/repo> --json title,body,files`でPR概要・変更ファイルを確認する
2. `gh pr diff <PR番号> --repo <owner/repo>`で差分を確認する
3. 変更内容から**テスト対象を特定**する:
   - どのメタボックス・パネル・ブロックが影響を受けるか
   - どの投稿タイプで確認が必要か
   - dispatchパターンに変更があるか（`dispatch`/`useDispatch`/`editPost`の差分を確認）

#### IssueのURLが指定された場合

1. `gh issue view <Issue番号> --repo <owner/repo> --json title,body`でIssue内容を確認する
2. Issue本文からテスト対象（リスク一覧・影響ブロック・ファイルパス等）を読み取る
3. 関連するPRがある場合は`gh pr list --repo <owner/repo> --search "issue:<Issue番号>"`で特定する
4. Issueの記載内容に基づいてチェック項目を絞り、テストを実行する

### ステップ2: テスト環境の確認

1. `--site`指定のサイトへアクセスできることを確認する
2. WordPressのバージョンが7.0以上であることを確認する:
   ```bash
   # wp-cliで確認（推奨）
   wp core version --path=<WP_ROOT>
   # またはREST APIで確認（認証不要だがバージョン番号の直接取得はできない）
   curl -s <SITE_URL>/wp-json/
   ```
3. Playwrightのインストールを確認する:
   ```bash
   npx playwright --version
   ```
   未インストールなら案内する:
   ```bash
   npm install -D @playwright/test && npx playwright install chromium
   ```

### ステップ3: テスト用データの準備

1. `--users`指定の各ユーザーでログインできることを確認する
2. テスト用の投稿を作成する（wp-cliまたはREST API + nonce認証）:
   - 投稿（post）1件
   - 固定ページ（page）1件
   - カスタム投稿タイプ（PRの変更対象に該当するものがあれば）1件
3. PRの変更内容に応じて、テスト用ブロックコンテンツを投稿に挿入する

### ステップ4: Playwrightテストの生成と実行

`rules/testing/rtc.md`のチェック項目に沿って、Playwrightテストスクリプトを生成・実行する。

**テストファイルの生成先:**

テストファイルは一時ディレクトリに生成する（テスト対象リポジトリには含めない）:

```bash
TEST_DIR="/tmp/rtc-test-$(date +%Y%m%d%H%M%S)"
mkdir -p "${TEST_DIR}"
```

```
${TEST_DIR}/
├── helpers.ts          # ログイン・投稿作成などの共通処理
├── basic.spec.ts       # 1. 基本動作テスト
├── data-persist.spec.ts # 2. データ保持テスト
├── concurrent.spec.ts  # 3. 同時編集テスト
├── backward.spec.ts    # 5. 後方互換テスト
└── playwright.config.ts # テスト設定（baseURLに--siteの値を使用）
```

**テスト実行:**

```bash
npx playwright test "${TEST_DIR}/" --reporter=list
```

### ステップ5: 投稿タイプごとの確認

ステップ4のテストを以下の投稿タイプで実行する:

1. 投稿（post）
2. 固定ページ（page）
3. カスタム投稿タイプ（対象がある場合）

`rtc.md`のチェック項目4-1〜4-3に対応。

### ステップ6: 後方互換の確認

1. **RTCオフ**: Collaboration機能を無効化した状態で基本動作テスト（1-1〜1-4）を実行する
2. **WP 6.x**: WP 6.x環境が利用可能な場合、基本動作テストを実行する（利用不可の場合はSKIP）

### ステップ7: 結果のレポート

`rtc.md`の「レポートテンプレート」に従って結果をまとめる。

**PASSの場合:**
- PRコメントにテスト結果を投稿する（`e2e.md`のテスト報告テンプレートを併用）

**FAILの場合:**
- 問題の詳細（スクリーンショット・エラーログ）をレポートに含める
- ユーザーに報告し、対応方針を確認する

## 他スキルとの連携

### staff-reviewから呼ぶ場合

staff-review（麗美）がRTC関連PRをレビューする際は、このスキルのチェック項目を追加で実施できる:

```
1. Readで REPO_ROOT/rules/testing/rtc.md を読む
2. rtc.md のチェック項目1〜3を通常のe2eテストに追加する
```

### staff-directorから呼ぶ場合

ディレクター（司）がRTC対応PRを検出した場合は、このスキルをAgentで起動できる:

```
Agentツール（subagent_type: general-purpose）を起動
prompt = このSKILL.mdの全内容 + PR URL + サイト情報 + ユーザー情報
```
