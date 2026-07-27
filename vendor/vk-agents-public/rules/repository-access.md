> **注意:** このファイルは vk-agents-public（vk-agents からの複製）です。直接編集しないでください。改善要望は https://github.com/vektor-inc/vk-orchestrator/issues へお願いします。

# リポジトリ制限（owner ゲート）のルール

各スキルが「対象リポジトリの owner（GitHub の組織名・ユーザー名）が許可されているか」を判定する共通ルール。owner はハードコードせず、環境ごとの許可リスト `org.allowed_owners` を参照する。

## 設定の場所

- 設定ファイル: `~/.vk-agents/config.json`（`VK_AGENTS_CONFIG` で絶対パスを上書き可。テンプレは vk-agents リポ直下の `config.json.example`）の `org.allowed_owners`（文字列配列）
- 参照するキー: `org.allowed_owners`（例: `["vektor-inc"]`）

許可リストの取得:

```bash
jq -r '.org.allowed_owners[]?' "${VK_AGENTS_CONFIG:-$HOME/.vk-agents/config.json}" 2>/dev/null
```

（ファイル無し・キー無し・空配列・JSON パース失敗はいずれも「空（未設定）」として扱う）

## ゲートの種類

各スキルは自身のゲートを **硬（hard）** か **軟（soft）** のいずれかで宣言する。

- **硬ゲート**: 許可されない owner では処理を中断する
- **軟ゲート**: 許可されない owner ではユーザーに確認し、明示承認された場合のみ続行する

## 判定アルゴリズム

1. 対象リポジトリの owner を抽出する
2. 上記コマンドで許可リストを取得する
3. **許可リストが空（未設定・config 無し・空配列・パース失敗）** → owner に関わらず **全スキル軟ゲート扱い**（硬ゲートのスキルも軟に降格し、確認のうえ続行可）。ハードコードされた既定 owner は持たない。硬ゲートが降格した場合は、確認時に「許可リスト（`org.allowed_owners`）が未設定のため硬ゲートを降格しました」と一言添え、ユーザーが硬ブロックを失っていることに無自覚にならないようにする
4. **許可リストが非空で owner がリストに含まれる** → そのまま続行（owner の照合は**完全一致（大文字小文字を区別しない）**で行う。部分一致は禁止。部分一致にすると `vektor-inc-clone` が `vektor-inc` に誤マッチしてゲートをバイパスできるため）
5. **許可リストが非空で owner がリストに含まれない**:
   - 硬ゲートのスキル → 処理を中断する
   - 軟ゲートのスキル → 「⚠️ 許可リスト外のリポジトリです（オーナー: <owner>）。続行しますか？」と確認し、明示承認された場合のみ続行する

## 各スキルの分類

| スキル | ゲート |
|---|---|
| `vk-bot-pr` | 硬 |
| `vk-rtc-test` | 硬 |
| `staff-review` | 硬 |
| `staff-security` | 硬 |
| `vk-review-guide` | 硬 |
| `vk-kore` | 軟 |
| `vk-pr-review` | 軟 |

社内（vektor-inc）では正本 `~/.vk-agents/config.json` に `"org": { "allowed_owners": ["vektor-inc"] }` を設定すると、従来と同じゲート挙動になる。
