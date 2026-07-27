> **注意:** このファイルは vk-agents-public（vk-agents からの複製）です。直接編集しないでください。改善要望は https://github.com/vektor-inc/vk-orchestrator/issues へお願いします。

# wp-env 開発環境のルール

## ポート指定は wp-env.json に書かない

`wp-env.json` にポート番号（`port`, `testsPort`）を**直接指定してはいけません**。

ポート変更は必ず `.wp-env.override.json` で上書きしてください。

### 理由

`wp-env.json` はリポジトリにコミットされ、全開発者で共有されます。ポート番号は開発者のローカル環境に依存するため、ここに書くと競合します。`.wp-env.override.json` は `.gitignore` に含まれ、個人の環境設定を安全に管理できます。

### 例

```jsonc
// .wp-env.override.json（ローカルのみ・コミットしない）
{
  "port": 8890,
  "testsPort": 8891
}
```
