> **注意:** このファイルは vk-agents-public（vk-agents からの複製）です。直接編集しないでください。改善要望は https://github.com/vektor-inc/vk-orchestrator/issues へお願いします。

# メンバー起動のルール

チームメンバー（サブエージェント）を起動するときの決め事を、このファイルを唯一の正としてまとめる。

**このファイルはルールのみを扱う。** `codex exec` の具体的な起動手順（プロンプトの組み立て・出力スキーマ・実行コマンド）は、各メンバースキルの SKILL.md とそこから参照される共通手順（`skills/_shared/codex-launch.md`）に置いている。

## チームメンバー

`name` 列をチームメンバーごとの `name` 値とエージェント定義名の唯一の正とする。スキル名・エージェント定義名・`agents.engine` の設定キーはすべて同じ値に揃えている。

| 名前 | name（定義名・スキル名） | 役割 | 人格ファイル | エージェント定義ファイル |
|------|--------------------------|------|--------------|--------------------------|
| 司 | `vk-director`（スキルのみ） | ディレクター | `agents/personas/tsukasa.md` | なし（メイン Claude が演じる） |
| 植草 | `vk-ux-designer` | UXデザイナー | `agents/personas/uekusa.md` | `agents/vk-ux-designer.md` |
| 和田 | `vk-wp-developer` | WordPressエンジニア | `agents/personas/wada.md` | `agents/vk-wp-developer.md` |
| 安藤 | `vk-code-reviewer` | リードエンジニア | `agents/personas/ando.md` | `agents/vk-code-reviewer.md` |
| 麗美 | `vk-ui-tester` | UIテスト / e2eテスト担当 | `agents/personas/remi.md` | `agents/vk-ui-tester.md` |

「人格ファイル」列は vk-agents リポジトリ内での置き場所を示す。**Read するときは各メンバースキルの SKILL.md に書かれたパスを使う**こと。人格ファイルは配布時にパスを書き換えたコピーが作られ、SKILL.md 側の記載だけがその配布先を指すため。

司はメイン Claude が演じるため、エージェント定義ファイルを持たない。司の役割を引き継ぐ場合は、呼び出し側のエージェントが `skills/vk-director/SKILL.md` に書かれた人格ファイルを Read して直接振る舞う（サブエージェントのネストを避けるため）。

### 植草と麗美の境界

`vk-ux-designer`（植草）と `vk-ui-tester`（麗美）は語が隣接するため、依頼先は実装の前後で切り分ける。

- **植草（`vk-ux-designer`）… 実装前** — 画面設計の提案、ユーザビリティ・アクセシビリティのレビュー
- **麗美（`vk-ui-tester`）… 実装後** — ブラウザでの動作確認、UI・デザインの実物照合、Playwright テストの作成・実行

## メンバーを呼ぶ方法

```
1. Agent ツールを subagent_type: <定義名> で起動する
   定義名は上記「チームメンバー」表の name 列を参照
2. name パラメータにも同じ値を指定する
   結果を合否判定に使う起動は「サブエージェント起動の待機ルール」に従い、
   出力本文を受け取るまで判定・次工程へ進まない
3. prompt は依頼内容のみ（persona の Read・連結は定義ファイル側が行う）
```

## エージェント定義が未配布の環境でのフォールバック

`subagent_type: <定義名>` での起動が失敗する環境（エージェント定義ファイルが未配布）では、そのメンバーのスキル（`skills/<定義名>/SKILL.md`）に記載された人格ファイルのパスを `Read` し、その内容を prompt に連結して `subagent_type: general-purpose` で起動する。

この経路は定義ファイルが読めない環境のための代替であり、定義が配布されている場合は使わない。

## name の付け方

- `name` を付けて起動すると、そのメンバーはチームメンバーとして登録され、`SendMessage` で作業内容を覚えたまま追加指示・差し戻しを送れる。`name` を付けずに起動すると名指しで呼び戻せず、エージェント ID に依存して宛先が不安定になる。そのため、レビュー・差し戻しが発生しうる依頼では `name` を必ず付ける
- `name` は英数字とハイフンにする。日本語名では受信箱ファイル名が衝突し、`SendMessage` が誤配送されるため。詳細は [worktree.md](worktree.md) を参照する
- 同じメンバーを並列で複数起動する場合は、定義名をベースに `vk-wp-developer2` / `vk-wp-developer-<リポジトリ名>` のような一意な `name` にする（`subagent_type` は定義名のまま）。同名で複数起動すると受信箱を共有し、`SendMessage` が誤配送される

## サブエージェント起動の待機ルール

この節をサブエージェント起動の待機原則の唯一の正とする。

**原則（ツールの挙動に依存しない）**: 結果を合否判定に使うメンバーについては、**起動側がそのメンバーの出力本文を自分で受け取るまで**、合否を判定せず、次工程（PR 作成・テスト依頼・サマリー投稿・マージ判断）へ進まない。

- **`run_in_background: false` は待機の保証ではない。** `name` パラメータ付き（チームメンバーとして登録される起動）では同期実行にならず、起動直後に制御が戻る。本リポジトリは `name` 指定を必須としているため、**実運用では常にバックグラウンド起動になる**前提で行動する。指定自体は害がないので付けてよいが、「`false` を付けたから待てている」と考えてはならない
- **起動直後の応答（`Spawned successfully` / `now running` 等）は「起動成功」であって「完了」ではない。** これをレビュー結果として扱わない
- 結果受領とみなせるのは、完了通知（`Teammate @xxx finished` 等）を受け、**かつ**そのメンバーの出力本文を読めた場合に限る。通知だけで本文が無い場合は未着として扱い、`SendMessage` で本文の再送を依頼する
- **未着は PASS ではない**。出力を受け取れていない段階で「PASS の記載が見当たらない」「特に指摘なし」と解釈して合否を判定せず、次工程へ進まない
- 未着のメンバーがいる状態でターンを終える場合は、「◯◯のレビュー結果待ち」と明示して締める。合否・次工程の出力は行わない
- 複数メンバーを同時に走らせる場合も同じ。全員分の出力が揃うまで判定しない
- Codex（`codex exec`）を Bash のフォアグラウンド（`run_in_background` を指定しない）で実行する場合は、完了まで制御が戻らない同期実行のためこのルールの対象外。`run_in_background: true` で並走させる場合（`vk-multi-repo-task` 等）は上記と同じ扱いとする

## SendMessage ツールのルール

SendMessage で文字列メッセージを送る場合は、必ず `summary` パラメータ（5〜10語の要約）を含めること。summary がないとエラー。

```
SendMessage({ to: "vk-wp-developer", message: "...", summary: "実装依頼の送信" })
```

宛先 `to` は起動時に指定した `name` と完全一致させること。日本語名は受信箱（inbox）が衝突して誤配送になるため使用しない。`name` 値は上記「チームメンバー」表の `name` 列を正とする。

Claude の `Agent` ツールで起動したメンバーへの追加指示・差し戻し・再レビュー依頼は、persona を再連結して新しいメンバーを起動せず、起動時に指定した `name` を宛先として `SendMessage` で送る。

## 起動エンジンの解決

メンバーは Claude サブエージェント（`claude`）でも Codex（`codex exec`）でも起動できる。**起動ごとに以下の優先順位で決める**:

1. その場の明示指示（「Codex で和田を起動して」「Claude で麗美を動かして」等）
2. `~/.vk-agents/config.json` の `agents.engine.<定義名>`（`claude` / `codex`）
3. `~/.vk-agents/config.json` の `agents.default_engine`
4. どちらも無ければ `claude`

```json
{
  "agents": {
    "default_engine": "claude",
    "engine": {
      "vk-wp-developer": "codex",
      "vk-ui-tester": "claude"
    }
  }
}
```

`~/.vk-agents/config.json` が無い・キー未設定・JSON パース失敗時は `claude` にフォールバックする（安全側）。設定変更は、正本 `~/.vk-agents/config.json`（`VK_AGENTS_CONFIG` で上書き可。初期化用テンプレは vk-agents リポ直下の `config.json.example`）を編集する。

### Codex は単独作業のみ

上記で `codex` に解決されても、依頼が次のいずれかを要する場合は **`claude` にフォールバック**する:

- 実行中に他メンバーと連携する（`SendMessage` を使う）
- そのメンバー自身に `Skill`（`/vk-pr` 等）を実行させる
- そのメンバー自身に PR / issue へコメントを投稿させる

**理由**: `codex exec` はステートレスで、`SendMessage`（メンバー連携）も `Skill` も呼べないため、連携を自分で完結できない。Codex で起動したメンバーの責務は**単独で完結する作業まで**とし、push・`/vk-pr`・CodeRabbit 監視・他メンバー連携・PR コメント投稿は司（呼び出し元の Claude）が担う。判断は起動側が行う。

Codex（`codex exec`）で起動したメンバーは `SendMessage` の宛先にならず、報告を返した時点で終了する。差し戻しが必要な場合は、それまでの経緯と指摘をプロンプトに含めて司が再度 `codex exec` する。連携ループが頻発しそうな依頼は、最初から `claude` にフォールバックする方が効率的。
