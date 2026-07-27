> **注意:** このファイルは vk-agents-public（vk-agents からの複製）です。直接編集しないでください。改善要望は https://github.com/vektor-inc/vk-orchestrator/issues へお願いします。

# e2e テスト

## 内容はコメントで多めに記載

処理内容が日本語でわかるコメントを記載してください。

## ポート変更は .wp-env.override.json で

`wp-env.json` にポート番号を直接指定してはいけません。変更は `.wp-env.override.json` を使ってください。詳細は [wp-env.md](../wp-env.md) を参照。

## ベースURLのルール

- `page.goto()` には**相対パス**（`/?s=test` など）を使用すること
- `http://localhost:8889` や `http://localhost:2855` などの**絶対URLをハードコードしてはいけない**
- ベースURLは `playwright.config.js` の `baseURL` 設定（または `WP_BASE_URL` 環境変数）で管理する。CI 環境とローカル環境でポートが異なるため、ハードコードするとCI で失敗する

## ブラウザは headless（非表示）で実行する

Playwright によるテスト実行・スクリーンショット撮影・録画は、すべて **headless モード（ブラウザウィンドウを画面に表示しない）** で実行する。撮影のたびに可視ブラウザが前面に出ると、ユーザーの作業を中断するため。

- `npx playwright test` / `npx wp-scripts test-playwright` は既定で headless。**`--headed` を付けない**こと。
- スクリプトで `chromium.launch()` 等を直接呼ぶ場合は `headless: true`（既定値）のままにし、`headless: false` にしないこと。
- Playwright MCP など、既定で可視ブラウザを開くツールを使う場合は、可視ウィンドウを開かないよう headless で動作させること。
- 録画（video / GIF 化用）も headless モードで取得できる。動き確認の録画のために headed にする必要はない。
- デバッグ目的で一時的に headed（`--headed` / `headless: false`）を使うのは可。ただし、スクリーンショット・録画の**本番撮影・成果物生成は必ず headless で行う**。

## テストの観点

| 観点 | 内容 |
|------|------|
| 正常系 | PR の変更内容が期待通りブラウザ上で動作するか |
| UI表示 | レイアウト崩れ・文字切れ・スタイルの適用漏れがないか |
| 操作性 | クリック・入力・遷移が正しく機能するか |
| レスポンシブ | モバイル幅での表示・操作に問題がないか（UI変更の場合） |
| 回帰 | 既存機能が壊れていないか |

## テストコード例

**WordPress Scripts 統合型:**
```typescript
import { test, expect } from '@wordpress/e2e-test-utils-playwright';

test.describe('PR #123 の確認', () => {
    test('変更された機能が期待通り動作する', async ({ admin, editor, page }) => {
        await admin.createNewPost();
        // PR の変更内容に応じた操作
    });
});
```

**Pure Playwright:**
```typescript
import { test, expect } from '@playwright/test';

test.describe('PR #123 の確認', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/wp-login.php');
        await page.getByLabel('Username or Email Address').fill('admin');
        await page.getByLabel('Password', { exact: true }).fill('password');
        await page.getByRole('button', { name: 'Log In' }).click();
    });

    test('変更された機能が期待通り動作する', async ({ page }) => {
        // PR の変更内容に応じた操作
    });
});
```

## スクリーンショットの保存先

画像は `~/.vk-agents/config.json`（または `VK_AGENTS_CONFIG`）の `org.review_assets_repo`（`<owner>/<repo>` 形式）で設定されたレビュー用アセットリポジトリにコミット・プッシュする。

```bash
REVIEW_ASSETS=$(jq -r '.org.review_assets_repo // empty' "${VK_AGENTS_CONFIG:-$HOME/.vk-agents/config.json}" 2>/dev/null)
```

`org.review_assets_repo` が未設定・空の場合は、画像のコミット・プッシュ・埋め込みをスキップし、テスト報告にはテキストで要点（何をどう確認し、表示がどうなったか）を書く。

**設定されたレビュー用アセットリポジトリへのコミット・プッシュのみテスト担当に許可されている。**

ディレクトリ構成:
```
review-assets/
├── <リポジトリ名>/
│   └── pr-<番号>/
│       ├── before-<ページ名>.png
│       ├── after-<ページ名>.png
│       ├── before-<ページ名>.gif
│       └── after-<ページ名>.gif
```

UI/表示に関わらない変更（ロジックのみの修正等）ではスクリーンショットは不要。

### 動きのある変更は GIF で

アニメーション・開閉・ホバー・スクロール連動など、動きの確認が必要な変更は静止画ではなく録画を GIF に変換して保存する。mp4 等の動画ファイルは PR コメントでインライン再生されず、GitHub への直接添付には手動の Web UI 操作が必要なため使用しない。

### 録画・GIF に機密情報を含めない

録画・スクリーンショットには、確認に不要な機密情報を映さない。具体的には次に注意する。

- ログイン URL・認証情報の入力場面
- 顧客の氏名・メールアドレス等の個人情報（ユーザー一覧・コメント・フォーム受信データ・受注情報など）
- API キー・ライセンスキー・パスワード等の秘匿情報を含む設定画面
- URL 内のトークン（nonce・パスワードリセットの `key` 等。アドレスバーが映り込む場合は隠す）
- ブラウザの別タブ・ブックマークバー・通知に映る無関係な業務情報

撮影前に、機密情報が録画・スクリーンショットに映り込まないか確認する。映り込む場合は、対処方法（下記）を先に決めてから撮影する。

録画は事前にログインを済ませ、storageState（ログイン済みセッション情報）を引き継いだ状態で開始する。撮影は可能な限り、ダミーデータを投入したローカル／検証環境で行う。

**その画面・データの表示や変更そのものが確認対象となる場合**（例: ログイン機能の改修、ユーザー一覧 UI の変更、設定画面へのフィールド追加、フォーム受信データの表示変更）は、その画面を映す必要がある。この場合は次の順で対応する。

1. **ダミー／サンプルデータを使って撮影する。** ダミーには本番データベースのコピーを流用しない（氏名・メールアドレス・受注情報などが実データのまま映り込むため）。ログイン機能の改修であっても、入力する ID・パスワード等の認証情報はダミーを使う。
2. やむを得ず実データを含むときは、該当箇所をマスク（黒塗り・サンプル値への置換）してから添付する。マスクは元の情報を復元できない不可逆な方法で行い、ぼかしや半透明オーバーレイなど元画像が残る・拡大で読めてしまう手段に頼らない。

なお動画・GIF は一瞬でも実データが映ると後からの全フレームマスクが難しいため、実データを避けられない場合はダミーデータで撮り直すか、該当画面のみ別添付の静止画にして不可逆マスクを施す。

### 画像・GIF の埋め込み URL 形式

PR コメント・PR 本文に埋め込む際は、blob URL に `?raw=true` を付けた形式を使う。

```
![説明](https://github.com/<review-assets-repo>/blob/main/<リポジトリ名>/pr-<番号>/<ファイル名>?raw=true)
```

- `<review-assets-repo>` には `org.review_assets_repo` で設定したリポジトリ（例: `owner/repo`）を入れる
- この形式は閲覧者自身の GitHub ログインセッションで認証されるため、設定されたレビュー用アセットリポジトリへのアクセス権があるメンバーにはインライン表示される
- `raw.githubusercontent.com` 形式はプライベートリポジトリでは表示できないため使用しない。トークンを URL に埋めて表示させる回避策も、トークンが PR コメントに残るため禁止
- 設定されたレビュー用アセットリポジトリへのアクセス権がない閲覧者には壊れた画像として表示される。社外の閲覧を想定する公開リポジトリの PR では、画像が見えない閲覧者がいる前提でテキストでも要点を書く。レビューを通すためにレビュー用アセットリポジトリを public 化してはならない

## テスト報告テンプレート

テスト完了後、結果を `gh pr comment` で PR に投稿する。
スクリーンショット・テスト結果・総評を **1つのコメントにまとめて** 投稿する。

```
gh pr comment <PR番号> --repo <owner/repo> --body "$(cat <<'EOF'
お疲れ様です。麗美です。テスト結果を報告します 🫡

## テスト結果: [PASS / FAIL]

### e2e テスト結果
| テスト内容 | 結果 | 備考 |
|------------|------|------|
| 既存テスト | PASS/FAIL/N/A | ... |
| [テストシナリオ1] | PASS/FAIL | ... |
| [テストシナリオ2] | PASS/FAIL | ... |
| 回帰確認 | PASS/FAIL | ... |

### スクリーンショット・GIF
（UI変更がある場合のみ。アニメーション・開閉・ホバーなど動きの確認が必要な変更は、静止画ではなく GIF を貼る。レスポンシブで複数端末を貼る場合は、各画像に端末名（PC / モバイル等）を添える。埋め込み URL は `?raw=true` 形式を使う。詳細は「画像・GIF の埋め込み URL 形式」を参照）

#### Before
![before](https://github.com/<review-assets-repo>/blob/main/...?raw=true)

#### After
![after](https://github.com/<review-assets-repo>/blob/main/...?raw=true)

### 総評
[1〜2文でまとめ]

### 指摘事項（FAIL の場合）
1. [具体的な問題と再現手順]
2. ...
EOF
)"
```
