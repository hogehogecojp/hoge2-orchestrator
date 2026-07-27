---
name: vk-orchestrator-release
description: "vk-orchestrator をリリースする。同梱する vk-terminals / vk-agents を最新にそろえてから、バージョン付与・CHANGELOG 確定・タグ push まで一気通貫で行う。「orchestrator をリリース」「vk-orchestrator-release」で起動。"
compatibility: "git、node、bash が必要。vk-agents の実体 clone（VK_AGENTS_DIR）が必要"
---

# vk-orchestrator リリースワークフロー

vk-orchestrator のリリースは **「同梱依存（vk-terminals / vk-agents）を最新にそろえる」→「バージョン付与・CHANGELOG 確定」→「コミット・タグ・push」** の 3 フェーズ。
このスキルはその順序と抜け漏れ防止を担う。**Phase 1 で同梱を最新化してからでないとリリースに進まない**のが肝心。

vk-orchestrator は npm registry へ publish せず、利用側は git タグ（`git+https://…#vX.Y.Z`）で取り込む。CI リリースワークフローは無い。したがってリリース＝**リリースコミット + lightweight タグ `vX.Y.Z` を main に push** すること。

## いつ使うか

このリポジトリ（vk-orchestrator）で次を言われたとき：
- 「リリースする」「orchestrator をリリース」「vk-orchestrator をリリース」
- 「vk-orchestrator-release」

## 前提の確認（Phase に入る前）

1. **カレントが vk-orchestrator リポジトリのルート**であること（`package.json` の `name` が `vk-orchestrator`）。違えば移動を促す。
2. **main ブランチかつ最新**：
   ```
   git checkout main && git pull --ff-only origin main
   ```
   未コミット変更があるなら先にコミット／stash する（Phase 1 は package.json / vendor を書き換えるため、無関係な差分が混ざらないようにする）。
3. **vk-agents の実体 clone が解決できる**こと。`VK_AGENTS_DIR`（未設定なら既知の兄弟配置）で解決する。同梱 `vendor/vk-agents-public` は export 生成物であり元リポジトリではない点に注意（Phase 1 のスクリプトが取り違えを検出してエラーにする）。

## フェーズ間の進行ルール

**Phase 1 → 2 → 3 は原則止まらず一気通貫で進める。** ただしリリースは破壊的（push・タグ）なので、次の 1 点だけは確定前に必ずユーザーへ提示・確認する：

- **付与するバージョン番号**（Phase 2）。推奨値を算出して提示し、合意を得てから確定する。

これ以外はフェーズごとの逐一確認をしない。以下のときのみ止まる：Phase 1 がエラー（exit 2）／前提条件が欠けている／実行中にエラーで続行不可。

---

## Phase 1: 同梱依存を最新にそろえる

```
npm run release:preflight
```

`scripts/release-preflight.mjs` が次を行う（詳細はスクリプト冒頭コメント参照。ロジックはここに再実装しない）：

- **vk-terminals** … `optionalDependencies` のピンをリモート最新 semver タグへ追従（`bump-vk-terminals.mjs latest` を再利用。package.json / package-lock.json を書き換え）。
- **vk-agents** … 実体リポの最新タグの一時 worktree から `export-public.sh` を実行し、`vendor/vk-agents-public` を再生成（元リポの作業ツリーは汚さない）。

**終了コードで分岐する**：

| exit | 意味 | 対応 |
|---|---|---|
| 0 | どちらも既に最新。差分なし | そのまま Phase 2 へ。CHANGELOG に依存更新行は不要 |
| 1 | 古かったので最新化した。未コミット差分あり（**正常系**） | 出力に出た新バージョン（vk-terminals タグ / vk-agents タグ）を控えて Phase 2 へ。差分はリリースコミットに含める |
| 2 | エラー（vk-agents リポ未解決・bump/export 失敗） | **止まる**。出力を添えてユーザーへエスカレーション。推測で先へ進まない |

exit 1 のときにスクリプトが報告した版数（例: `vk-terminals ピン → 1.43.0`、`vk-agents 同梱 → v0.13.0`）と、**更新前の版数**を控える。更新前の vk-terminals ピンは次で取れる：
```
git show HEAD:package.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).optionalDependencies['vk-terminals'].match(/#(.+)$/)[1]))"
```

## Phase 2: バージョン付与・CHANGELOG 確定

### 2-1. 次バージョンを決める（semver）

CHANGELOG.md 冒頭の**未リリース領域**（`= x.y.z =` 見出しより上）のエントリ分類から推奨値を算出する：

- `[ 機能追加 ]` を含む → **minor** を上げる（例: 0.22.0 → 0.23.0）
- `[ 不具合修正 ]` / `[ 仕様変更 ]` のみ → **patch**（例: 0.22.0 → 0.22.1）
- 破壊的変更が明記されている → **major**

現行バージョンは `package.json` の `version`。推奨値を提示し、ユーザーの合意を得る（唯一の確認ポイント）。

### 2-2. CHANGELOG.md を確定する

`$VK_AGENTS_DIR/rules/changelog.md` と `change-title.md` に従う（**必ず読んでから**）。

- Phase 1 が exit 1（依存が更新された）だった場合、未リリース領域に依存更新エントリを追記する：
  - vk-terminals: `[ 仕様変更 ] vk-terminals を <旧> から <新> にアップデート`（既存の 0.21.0 の記法に合わせる）
  - vk-agents: 同梱更新は履歴上コミットメッセージで記録する運用（Phase 3 のコミット本文に含める）。CHANGELOG に載せる場合は `[ その他 ] 同梱 vk-agents-public を vk-agents <新> に同期`
- 未リリース領域のエントリ全体を **change-title.md の分類順に並べ替える**。
- 未リリースエントリ群の**上**に見出し `= X.Y.Z =` を追加する（既存の確定済みセクションには手を入れない）。

### 2-3. package.json / package-lock.json のバージョンを上げる

```
npm version X.Y.Z --no-git-tag-version
```

（package.json と package-lock.json の root version を同時更新。タグ・コミットはこの時点では作らない。Phase 1 で書き換えた vk-terminals ピンはそのまま残る。）

## Phase 3: コミット・タグ・push

リリースコミットに含めるもの：`CHANGELOG.md` / `package.json` / `package-lock.json`、および Phase 1 で差分が出ていれば `vendor/vk-agents-public`。

```
git add CHANGELOG.md package.json package-lock.json vendor/vk-agents-public
git commit   # メッセージは下記
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

コミットメッセージ（既存の慣例に合わせる。依存を更新した場合は要約に併記）：

```
[ その他 ] リリース X.Y.Z として CHANGELOG に = X.Y.Z = 見出しを付与

- 同梱 vk-terminals を <旧> から <新> にアップデート    # Phase 1 で更新があった場合のみ
- 同梱 vk-agents-public を vk-agents <新> に同期        # Phase 1 で更新があった場合のみ
```

push 後、タグ `vX.Y.Z` が origin に載ったことを確認して完了報告する：
```
git ls-remote --tags origin vX.Y.Z
```

## 注意

- **同梱の最新化（Phase 1）を飛ばしてリリースしない。** これがこのスキルの存在理由。手動でバージョンだけ上げたい場合でも Phase 1 は通す。
- リリースは破壊的（push・タグは巻き戻しづらい）。バージョン番号の確定だけは必ずユーザー合意を取る。
- CHANGELOG の記法・分類・並び順は `rules/changelog.md` / `change-title.md` が単一ソース。このスキルに再実装せず、必ず参照する。
- vk-terminals は日次同期ワークフロー（`.github/workflows/sync-vk-terminals.yml`）と `up` 起動時追従でも最新化されるが、**リリース時点での最新保証は Phase 1 が担う**（同期ワークフローの取りこぼしをここで吸収する）。
