# まっさらな WSL Ubuntu で動かす手順

Windows の WSL2（WSLg）上の Ubuntu で VK Orchestrator + VK Terminals(GUI) を
ゼロから動かすための手順です。macOS 前提の README を WSL 向けに補足します。

> **要点（先に結論）**
> - GUI(Electron) を表示するには **WSLg**（Windows 11、または WSLg 対応済みの Windows 10）が必要。
> - `vk-terminals` は **node-pty / Electron のネイティブビルド**を伴うため、**build-essential / python3** と **Electron 実行用の共有ライブラリ**が要る。
> - GPU: WSLg では **HW OpenGL は d3d12 ドライバ経由で一応使える**が、**Electron 経由では不安定（Mesa/Dawn 由来の警告）**で、**Vulkan は HW ドライバ（dzn 等）が無く使えない**。ターミナル用途で体感差も無いため **VK Terminals 本体 config（`~/.vk-terminals/config.json`）の `gpu` は空（自動）または `off`（非 macOS の既定）**のままにする（詳細は末尾「補足」および README の GPU モード節）。

---

## 0. 前提（Windows 側）

- **Windows 11**、または WSLg 対応済みの Windows 10。
- WSL を最新化して WSLg を有効にする（PowerShell）:

  ```powershell
  wsl --update
  wsl --shutdown
  ```

- GUI が出るかの簡易確認（Ubuntu 側で `echo $WAYLAND_DISPLAY` が `wayland-0` 等を返せば WSLg 有効）。

> WSLg が無い環境では GUI は起動できません。その場合は別マシンの VK Terminals API を使い、
> `up` ではなく `start` を使って `~/.vk-terminals/config.json` の `apiHost` または
> `VK_TERMINALS_HOST` を対象マシンに向けてください（README 参照）。

---

## 1. システム依存パッケージ

Ubuntu 側で、ビルドツールと Electron 実行に必要な共有ライブラリを入れます。
Ubuntu 24.04 (noble) では一部の共有ライブラリが `t64` サフィックスに改名されているため、
バージョンに合わせて**どちらか片方**を実行してください。

**Ubuntu 24.04 (noble)** — そのままコピペで実行できます:

```bash
sudo apt update
sudo apt install -y \
  build-essential python3 git curl ca-certificates \
  libnss3 libnspr4 libgbm1 libdrm2 libxkbcommon0 \
  libgtk-3-0t64 libasound2t64 libcups2t64 libatspi2.0-0t64 \
  libatk1.0-0t64 libatk-bridge2.0-0t64 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2
```

**Ubuntu 22.04 など（t64 改名前）**:

```bash
sudo apt update
sudo apt install -y \
  build-essential python3 git curl ca-certificates \
  libnss3 libnspr4 libgbm1 libdrm2 libxkbcommon0 \
  libgtk-3-0 libasound2 libcups2 libatspi2.0-0 \
  libatk1.0-0 libatk-bridge2.0-0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2
```

> **不足ライブラリの特定方法** — `up` が
> `electron: error while loading shared libraries: libXXX.so.N` で落ちる場合、
> 次で不足を洗い出して該当パッケージを入れます（24.04 で見つからなければ `*t64` を試す）:
>
> ```bash
> ldd node_modules/electron/dist/electron | grep 'not found'
> ```

---

## 2. Node.js 20 以上

このリポジトリは Node.js **20 以上**（`.node-version` は `20.18.2`）を要求します。
nvm での導入例:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# シェルを開き直すか source ~/.bashrc した後:
nvm install 20
nvm use 20
node -v   # v20.x を確認
```

---

## 3. GitHub CLI

ラベル登録や API 操作に `gh` 認証を使います。

```bash
sudo apt install -y gh   # または https://cli.github.com/ の手順
gh auth login            # ブラウザ or トークンで認証
```

`GITHUB_TOKEN` が未設定の場合、orchestrator は `gh auth token` から認証済みトークンを自動取得します。
通常は `config.json` にトークンを書く必要はありません。

---

## 4. クローンと導入

```bash
git clone https://github.com/vektor-inc/vk-orchestrator.git
cd vk-orchestrator

# VK Terminals(GUI) をビルドログ付きで導入・検証（node-pty / electron を再ビルド）
npm run setup:terminals
```

> `setup:terminals` は非 macOS では警告を出しますが、**ビルド自体は実行されます**。
> 上のシステム依存（build-essential / python3）が入っていれば node-pty のビルドは通ります。
> 最後に `✅ VK Terminals を導入しました → …` が出れば成功です。失敗する場合はビルドログの
> エラー（多くは不足ライブラリ）を確認してください。

---

## 5. 設定ファイル

```bash
cp config.example.json config.json
```

最低限、orchestrator config では以下 2 つを自分の値に:

```jsonc
{
  "github": {
    "owner": "your-org",       // タスク登録リポジトリのオーナー
    "repo":  "task-queue"      // タスク登録リポジトリ名
  }
}
```

> GPU 起動モードは orchestrator config ではなく VK Terminals 本体 config
>（`~/.vk-terminals/config.json` の `gpu`）で設定します。通常は空（自動）のままで、
> WSLg では GPU 無効（`off` 相当）になり Chromium の GPU 初期化エラーが出ません。
> 明示指定する場合は設定パネルの「VK Terminals（本体設定）」から `gpu` を変更します。
> `VK_TERMINALS_GPU` 環境変数が設定されている場合はそちらが最優先です。詳細は README の GPU モード節を参照。

### アサインフィルター（複数人・複数マシンで1つのキューを共有する場合）

1 つのタスク登録リポジトリを複数人（または複数の WSL マシン）で共有するときに、**自分にアサインされた
issue だけ**を取り込み・実行するように絞るのがアサインフィルターです。未設定のまま誤って
他人の issue を拾わないよう、既定では issue を一切取り込みません。

- **挙動**: GitHub ログイン名を指定すると、作業対象リポジトリの Issue を**その人の担当分のみ**に
  限定し、取り込んだ task-queue Issue にも**その人を自動でアサイン**します（誰が処理中かが明確に
  なる）。空/未設定なら**一切取り込みません**。全件を対象にする場合は `all` を明示します。
- **指定方法（優先順位: 高い順）**:
  1. CLI 引数 `--assignee <login>`（`up` / `start` に付与。`up` は内部の orchestrator へ引き継ぎ）
  2. 環境変数 `ASSIGNEE_FILTER=<login>`
  3. `config.json` の `orchestrator.assigneeFilter`（GUI 設定パネルの「担当者フィルタ (login)」でも可）

```jsonc
// config.json に常設する場合
{
  "orchestrator": {
    "assigneeFilter": "your-github-login"   // 空/未設定＝一切取り込まない。全件対象は "all"
  }
}
```

```bash
# その場だけ担当を指定して起動する場合（config より優先）
npm run up -- --assignee your-github-login
# orchestrator 単体なら
npx vk-orchestrator start --assignee your-github-login
```

> 起動時のヘッダーの `assignee :` 行で、現在の挙動（`(なし・拾わない)` / `(全件)` / ログイン名）を確認できます。

---

## 6. ラベルの登録（初回のみ）

`gh auth login` 済みの状態で:

```bash
npm run setup:labels          # 作業対象リポジトリに取り込みラベル（task-queue）を作成
npm run setup:queue-labels    # タスク登録リポジトリに status:* / priority:* など一式を作成
```

---

## 7. 起動

```bash
npm run up
```

- config 反映 → VK Terminals(GUI) 起動 → API 疎通待ち → GUI 内に orchestrator 専用ペインを開いて
  `vk-orchestrator start` を自動実行、まで一気に行います。
- GUI ウィンドウが WSLg 上に表示され、`[vk-terminals] API server listening on http://127.0.0.1:13847`
  と `orchestrator ペインを作成しました` が出れば成功です。

GUI だけ起動したいときは `npm run up -- --no-orchestrator`。

---

## 8. トラブルシューティング

| 症状 | 原因 / 対処 |
|---|---|
| `VK Terminals が見つかりません` | ネイティブビルド失敗で optional 依存が除外。`npm run setup:terminals` でビルドログを確認し、不足ライブラリ（手順1）を導入 |
| `electron: error while loading shared libraries: libXXX.so` | 共有ライブラリ不足。`ldd node_modules/electron/dist/electron \| grep 'not found'` で特定して apt 導入 |
| GUI ウィンドウが出ない | WSLg 未対応/未更新。Windows 側で `wsl --update` → `wsl --shutdown`。`echo $WAYLAND_DISPLAY` を確認 |
| 起動時に `Exiting GPU process` / `kTransientFailure` 等の GPU 警告 | WSLg では Electron の GPU 初期化が失敗するため（Vulkan の HW ドライバ無し等）。VK Terminals 本体 config（`~/.vk-terminals/config.json`）の `gpu` を空（自動）または `off` に（既定で抑制済み）。無害 |
| GUI が即クラッシュ（`Cannot read properties of undefined (reading 'whenReady')`） | 環境変数 `ELECTRON_RUN_AS_NODE=1` が設定されていると Electron が Node として動き落ちる。`unset ELECTRON_RUN_AS_NODE` してから起動 |
| orchestrator が起動するがタスクを拾わない／起動しない | `config.json` の `task` / `protocol` / `labels` に空値（`""` / `[]` / `null`）が入っていないか確認。空値は既定にフォールバックされるが、GUI 設定パネルで意図せず保存した場合は該当セクションを削除すると確実 |
| API (`127.0.0.1:13847`) に疎通できない | GUI が起動しているか、`~/.vk-terminals/config.json` の `apiHost` / `port` 設定を確認 |

---

## 補足: WSLg での GPU について

WSLg では Windows 側 GPU への経路が **HW OpenGL は d3d12 ドライバ経由で一応使える**ものの、
Chromium/Electron 経由では不安定（Mesa/Dawn 由来の警告が出る）で、**Vulkan は HW ドライバ（dzn 等）が
無いため使えません**。ターミナル用途では GPU アクセラの体感差はほぼ無いため、本ツールは
**`off`（GPU 無効・エラー抑制）を既定**としています。詳細と選択肢は README の
「`gpu`（GUI の GPU 起動モード）」を参照してください。
