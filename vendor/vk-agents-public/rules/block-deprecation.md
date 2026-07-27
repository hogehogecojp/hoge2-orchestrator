> **注意:** このファイルは vk-agents-public（vk-agents からの複製）です。直接編集しないでください。改善要望は https://github.com/vektor-inc/vk-orchestrator/issues へお願いします。

# ブロックの deprecated 対応ルール

> **注記:** 本文中の `vektor-inc/dev-docs` へのリンクおよび `vektor-inc/vk-blocks-pro` の事例 PR は vektor-inc のプライベートリポジトリのため社外からは閲覧できません。本ルールは本文だけで読めるように記載しています。

独自 Gutenberg ブロック（`save` 関数を持ち `deprecated` を登録しているブロック）の `block.json` や `save.js` 変更時に、後方互換の `deprecated` 対応が必要か判定する基準。コード作成時もレビュー時も、このルールで判定・指摘すること。

## 正典（詳細手順・命名例）

人間向け完全版: [VK Blocks deprecated ハンドブック(新)](https://github.com/vektor-inc/dev-docs/blob/main/20_%E3%83%97%E3%83%AD%E3%83%80%E3%82%AF%E3%83%88%E5%88%A5/VK%20Blocks/VK%20Blocks%20deprecated%20%E3%83%8F%E3%83%B3%E3%83%89%E3%83%96%E3%83%83%E3%82%AF(%E6%96%B0).md)

本ファイルはエージェント向け判定チェックリスト。fixture の採取手順・命名例の詳細は上記 handbook を参照すること。矛盾時は**手順・命名は handbook 優先**、**2025 方針・`isValid` チェック・アンチパターンは本ファイル優先**。

## なぜ必要か

WordPress のブロック検証は、**保存済み投稿の HTML（save 出力）と、現在の `save` 関数が生成する HTML を文字列レベルで突き合わせて**一致を確認する。1 文字でも違うと、既存投稿を開いたときに「このブロックには予期しないか無効なコンテンツが含まれています」というブロック無効化エラーが発生し、エディタに**「ブロックのリカバリーを試行」ボタン（リカバリーボタン）**が表示される。

そのため、save 出力を変える変更には、変更前の出力を再現する `deprecated` エントリを添え、既存投稿を守る必要がある。逆に、save 出力が変わらない変更に `deprecated` を足すと不要な負債（スナップショットコードと fixture が永久に保守対象になる）になる。

### 2025 年以降の方針（deprecated を増やしすぎない）

過去は「save を変えたらとりあえず deprecated スナップショットを追加」を繰り返し、1 ブロックで十数世代の deprecated が積み上がる保守負債になった（例: button・slider・outer）。防止のため、**2025 年以降は次の方針に切り替えている**:

- **リカバリーボタンが出る場合のみ** deprecated スナップショット一式を追加する
- **リカバリーボタンが出ない場合は、deprecated スナップショットを追加せず、`deprecated/index.js` に attributes のコメントを足すにとどめる**（＝後述の予約コメント）

安易にスナップショットを増やさない。「save.js を触ったから deprecated を足す」という機械判断は誤り。

## 適用対象

`save` + `deprecated` を持つ独自ブロックを登録している**すべてのリポジトリ**（vk-blocks-pro が最大だが、独自ブロックを出している他のプラグイン／テーマも対象）。

## 判定の起点

次のいずれかを検知したら、以下を判定すること。

- `block.json` の **attributes の増減**、または**既定値（`default`）の変更**
- `save.js`（save 関数）の変更

## 判定 1: リカバリーボタンが出るか（＝ save 出力が変わるか）

判定軸は **「既存データ（＝新属性が未設定の保存済み HTML）を開いたときに、リカバリーボタンが出るか」**。技術的には「既存データに対して新しい `save` 関数が出す HTML が現行と完全一致するか」と同義だが、**実機で観測できる一次シグナルはリカバリーボタンの有無**。迷ったら既存データで保存した投稿を編集画面で開いて確認する。新属性に値を入れた場合ではなく、**既存ユーザーの保存済みデータ**を基準にすること。

### (A) リカバリーボタンが出る場合（出力が変わる）

既存投稿でリカバリーボタンが出る（＝出力 HTML が変わる）なら、次の 3 点を確認し、無ければ指摘する。

- 変更前の save 出力を再現する**スナップショット save.js**
- 登録エントリ（deprecated 配列への追加）
- e2e fixture: `test/e2e-tests/fixtures/blocks/vk-blocks__<block>__deprecated-<ver>.html` に**変更前の save 出力（＝既存ユーザーの保存済み HTML）**を置く。**著者が用意するのは `.html` 1 枚だけでよい**（同名の `.json`／`.parsed.json`／`.serialized.html` はテスト実行時に自動生成される）。属性パターン違いも検証するなら `...__deprecated-<ver>__<バリアント名>.html` を追加する

> **配置パスは、そのブロックの既存構造に合わせること**（vk-blocks-pro には 2 系統が混在している）:
> - スナップショットを `deprecated/save/<旧ver>/save.js`、登録を `deprecated/save/index.js` に置く型（button・slider・outer・card・animation。`deprecated/hooks/` を併設）
> - スナップショットを `deprecated/<旧ver>/save.js`、登録を `deprecated/index.js` に置く型（その他多数のブロック）
> - **兄弟ブロックでも系統が違うことがある**。例: `slider` 本体は `deprecated/save/` 型だが、`slider-item` は `deprecated/<旧ver>/` 型。ブロック名から推測せず、対象ブロックのディレクトリを実際に見て確認すること。
>
> 新規にどちらかへ寄せる判断はこのルールの範囲外。**既存ブロックの流儀を踏襲する。**

最新 fixture を「新しい出力」に更新するのは、**この (A)（リカバリーボタンが出る＝save 出力が変わった）ケースに限る**。出力が変わらない (B) では新しい出力自体がないため、最新 fixture は変更しない。なお (A) でも、**最新 fixture だけ新出力に書き換え、旧出力を再現する deprecated 一式を用意せずテストだけ緑にするのはアンチパターン**（既存投稿が壊れたまま見過ごされる）。

> **最新 fixture と `deprecated-<ver>.html`（旧）の違い**: 最新（現在の `save` が出す**新出力**）の fixture は、ブロックによって命名が **2 系統に分かれる**。`vk-blocks__<block>__default.html` 型（border-box・button・card・heading・icon・outer・slider・tab など）と、接尾辞なしの bare 型 `vk-blocks__<block>.html`（accordion・alert・animation・faq・staff・table-of-contents-new など）がある。**どちらかは対象ブロックの既存 fixture に合わせる**（deprecated 配置の 2 系統と同じく「既存の流儀を踏襲」）。一方 `deprecated-<ver>.html` はその版時点の**旧出力スナップショット**（＝既存ユーザーの保存済み HTML）。出力が変わったかを fixture の差分で見るときは、**`blockId`／`clientId` などインスタンスごとに変わる UUID はノイズなので無視**し、属性やマークアップ構造の差だけを見ること。
>
> 実例（slider 停止/再生ボタン追加。slider は `__default` 型）: 旧 `vk-blocks__slider__deprecated-1-115-2.html` は `"autoPlayStop":false`（`pauseButton` なし）、最新 `vk-blocks__slider__default.html` は `"autoPlayStop":true,"pauseButton":false`。この保存 HTML の実差分が出るため、リカバリーボタンが出る＝deprecated が必要、と判断できる。

出力が変わるケースの例:

- 新属性の既定値が非空で、既存データにも出力差分が出る
- 既存属性の意味変更、CSS クラス名やマークアップ構造の変更
- 値の整形・単位付与など、保存済み HTML に影響する変更

#### (A) の fixture 更新手順（現行配信が `1.120.0` の例）

最新 fixture は手書きせず、**ブロックエディターの往復で生成する**。

1. **現行の最新 fixture を旧スナップショットに退避**: `vk-blocks__<block>__default.html`（bare 系のブロックは `vk-blocks__<block>.html`）を `vk-blocks__<block>__deprecated-1-120-0.html` にリネームする。退避版数は**新版ではなく現行配信版（ここでは 1.120.0）**＝既存ユーザーが保存している出力。
2. **新しい最新 fixture を作り直す**: 退避した `deprecated-1-120-0.html` の HTML を、ブロックエディターの**コードエディター（「HTML として編集」）に貼る → 一旦ビジュアル（ブロック）表示に戻す**（ここで新しい `save` に移行される）→ **もう一度コードエディターに切り替え**、そこに出力された HTML を新しい `default.html`（または bare）として保存する。
3. **Outer など vk リンク設定を持つブロックの注意**: この往復で、リンク部分のラベル文字列が翻訳の都合で `Outer link` → `Outerリンク` に変換され、**その箇所だけリカバリーエラーになる（i18n 仕様上どうしようもない）**。生成 fixture のその部分は、手で元の `Outer link` に戻すこと。

#### (A) の派生: 変更が「default fixture に無い属性の分岐」に載るとき

subCaption のように **default fixture では値が空で分岐に入らない属性**の save 出力を変える場合、上記 1〜2 の default 退避だけでは**変更点を通らない**（default は全属性が既定値のため、値が入った既存投稿の save 経路を検証できない）。この場合:

- `__default` は**触らない**。退避しても default の出力は変わっていないため同内容の deprecated が増えるだけ。逆に default にその属性値を足すと「未設定時」の回帰テストが失われる
- 代わりに**バリエーション fixture を旧・新 2 枚**新規追加する。中身は手書き・save 関数からの推論で作らず、**実際にブロックエディターで作成・往復して出力された HTML** を使う（上記手順 2 と同じ要領）:
  - 旧（現行配信版の出力）: `vk-blocks__<block>__deprecated-<ver>__<バリエーション名>.html` … 現行配信版（通常 `master`）＋ `npm run build` した環境で採取
  - 新（現行 save の出力）: `vk-blocks__<block>__<バリエーション名>.html` … 修正ブランチ＋ `npm run build` した環境で採取
  - 実例（button subCaption）: `vk-blocks__button__deprecated-1-122-0__subcaption.html` ＋ `vk-blocks__button__subcaption.html`（vektor-inc/vk-blocks-pro#3048）
- 追加後は `npm run test-unit`（または `npm run fixtures:generate`）を実行し、生成された `.json` の **`isValid` が `true`** であることを確認する

**create or justify-skip**: 必須と判断した fixture を PR に含めないときは、サイレントにスキップせず、PR 本文か decision-record に**検証可能な理由**を書く（例: 「リリース版で旧 HTML を貼り付け、リカバリーなしを実機確認済み。恒久ガードは次版で fixture 追加」）。「default があるから不要」「推測で通る」は理由にならない。

### (B) リカバリーボタンが出ない場合（出力は同じ）

既存データでリカバリーボタンが出ない（＝出力 HTML が変わらない）なら、**スナップショット save.js は追加しない**。`deprecated/index.js` に今回追加した attributes をコメントとして残すにとどめる（後述の予約コメント）。2025 年以降はこれが基本ケース。

典型例: 新属性が `undefined` のときは `if ( newAttr )` ガードで出力に書き出さない設計。既存データ（＝新属性未保存）に対しては新旧どちらの save も同じ HTML を出すため、検証は新 save だけで通る。迷ったら、まず「`undefined` ガードで既存データを守れる設計に変更できないか」を検討すること。設計で既存データを守れれば deprecated スナップショットは不要になる。

属性の意味自体を移行したい（リネーム等）場合のみ、スナップショットを増やさずに既存 save を使い回す形で `migrate` を添える。

## 判定 2: 予約 snapshot の昇格サイクル

`deprecated/index.js` には、「次に save 出力を変える変更が来たときにすぐ deprecated 化できるよう、その時点の attributes スナップショットを残しておく予約コメント」を置く。**この予約コメントは save 出力影響の有無と独立して、属性追加時点で必ず残すこと。**

> **「予約コメント」とは `/* … */` でコメントアウトした未昇格の `blockAttributesN` スケルトンを指す**（実物: `_pro/tab/deprecated/index.js`）。`deprecated` 配列から実際に参照されている `blockAttributesN`（実物: `icon`・`slider-item`）は昇格済みの実エントリであり、予約コメントではない。レビュー時に両者を取り違えないこと（「予約コメントがある」と数えてよいのはコメントアウト形のみ）。

> 背景: 属性追加のたびに「既定値で出力不変 → 予約コメントもスキップ」を重ね、後で出力を変える変更が来たときに git log を遡って複数属性を手作業で拾い直す事故が起きた（vk-blocks-pro/button v1.105.1〜v1.121.1）。予約コメントは「今 deprecated が要るか」と独立した、後世への保険。

### 昇格サイクルの確認

save 出力を変える変更（判定 1 の (A)）では、次を確認する。

1. 既存の予約コメント（`blockAttributesN`）を**解除して実 deprecated エントリに昇格**しているか
2. 同時に、次バージョン用の予約コメント（`blockAttributesN+1`）を**新しく残している**か

### 予約コメントの書き方

汎用スケルトンではなく、**今回追加した属性を具体的に書いた例**として残す。

- 変数名は `blockAttributes2`、`blockAttributes3` の**連番**。バージョン番号入りの名前（`blockAttributes1_121_1` 等）は使わない
- スプレッド元は**直近に実在する `blockAttributes`**（実在しないスケルトン変数名を書かない）
- 各属性には**追加の経緯がわかる目印コメント**を添える。「以下のように予約コメントを残しておく」のような汎用文言は使わない
- 既存の予約コメントブロックがあれば、新しいブロックを別に作らず、**その 1 ブロックに継ぎ足す**（属性追加分を 1 箇所に集約して管理する）

> **目印コメントの形式**: 既存ファイルは `// 1.116.1 リリース後に追加` のような**版数ベース**が主流（PR 番号入りの形式を使っているファイルは現時点で存在しない）。既存ブロックに継ぎ足すときは周囲の形式に揃えること。新規に起こすときの**推奨は `[ <ブロック名> ] <変更内容>` ＋ `#<PR番号>`**（誰がいつ何を追加したか追跡しやすい）だが、版数ベースでも可。

```javascript
/*
// 次バージョンで属性を追加する場合は以下を追加
// [ <ブロック名> ] <前回追加分の説明>
#<前回PR番号>
// [ <ブロック名> ] <今回追加分の説明>
#<今回PR番号>
const blockAttributesN = {
	...blockAttributes,
	<前回追加した属性名>: {
		type: '<型>',
	},
	<今回追加した属性名>: {
		type: '<型>',
	},
};
*/
```

実物例（コメントアウト予約）: `_pro/tab/deprecated/index.js`。PR #2876 でスクロールバー関連の属性を `blockAttributes2` スケルトンに予約しているが、snapshot save.js は追加していない（リカバリーボタンが出ないため）。

## 判定の前に: fixture の `isValid` を確認する

deprecated や fixture を根拠に「default が必要なはず」「save 関数で undefined になるはず」と語る前に、必ず fixture の `.json`（block オブジェクト全体）を読んで **`isValid` を確認すること**。`isValid: false` の fixture は deprecated migration が走らず元 HTML が保持されているだけなので、save 関数の挙動を根拠にした結論は成立しない。`.parsed.json` の `attrs` だけ見て save 経路を推測しないこと。

## 正例 / アンチパターン

- **正例 (A・出力が変わる)**: vektor-inc/vk-blocks-pro#2610（スライダー ズーム追加）… 予約解除 → 昇格 → 再予約に加え、snapshot と deprecated fixture が揃っている
- **正例 (B・出力は変わらない)**: vektor-inc/vk-blocks-pro#2876（タブ スクロールバー追加）… 属性を追加したがリカバリーボタンは出ないため snapshot は作らず、`_pro/tab/deprecated/index.js` の予約コメントに属性を追記するにとどめた（2025 年方針の実践例）
- **アンチパターン（初版の事例・現在は修正済み）**: vektor-inc/vk-blocks-pro#3001（スライダー 停止/再生ボタン）… 初版では save 出力が変わるのに deprecated 一式が無く、`default.html` を新出力へ書き換えてテストだけ緑にしていた。その後レビュー指摘を受けて「1.121.1 以前の保存内容を救済する deprecated」一式を追加して修正された。**「事故 → あるべき修正（判定 1 (A) の 3 点を揃える）」の対比として参照する**
- **アンチパターン（初版の事例・現在は修正済み）**: vektor-inc/vk-blocks-pro#3048（button subCaption）… 変更が default に無い属性（subCaption）の分岐に載るケースで、初版ではバリエーション fixture を**エディタ往復で採取せず手書きで生成**し、命名も一時「版のみ（`deprecated-1-122-0`）」に迷走した。正しくは `__subcaption` バリエーション 2 枚を往復で採取する。**「default に無い分岐＝バリエーション fixture 旧・新 2 枚を往復採取」の対比として参照する**

## 関連

- 詳細手順・命名例: 冒頭の「正典」を参照
- e2e fixture の配置・命名・最新/旧の違い: 本ルールの「判定 1 (A)」を参照（汎用の e2e テスト手順は [`rules/testing/e2e.md`](testing/e2e.md)。deprecated fixture 固有の話は本ルール側に集約している）
