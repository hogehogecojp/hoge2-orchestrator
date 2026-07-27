> **注意:** このファイルは vk-agents-public（vk-agents からの複製）です。直接編集しないでください。改善要望は https://github.com/vektor-inc/vk-orchestrator/issues へお願いします。

# PHPUnit　テストの書き方について

## ポート変更は .wp-env.override.json で

`wp-env.json` にポート番号を直接指定してはいけません。変更は `.wp-env.override.json` を使ってください。詳細は [wp-env.md](../wp-env.md) を参照。

## テスト関数名は基本的に、test_テスト対象関数・メソッド名 とする

どの関数またはメソッドのテストか分かりやすくするために、
test_テスト対象関数・メソッド名 としてください。

例）

関数 aaa() のテストの場合は test_aaa()
NameClass::aaa() のテストの場合も test_aaa()
※クラスのメソッドの場合、クラス単位でテストファイル・テストクラスが分かれるため、違うクラスに同じメソッド名があっても関係ない

NG例）

test_aaa_cases()

aaa() という関数のテストなのか aaa_cases() という関数のテストなのかわかりにくいためNG。
いろんなケースの配列でテストする事をデフォルトとするので、"cases" は不要

## 条件と期待値をセットで配列に入れてループしながら処理する

条件毎にテストメソッドをわけると一覧性が低く、どの条件までテスト済みか把握しにくい。
そのため、テスト条件と期待結果を配列で登録し、その配列をループして実行してください。
配列だけで条件と結果の仕様を把握でき、組み合わせも後から増やせます。

例）

function_name() という関数またはメソッドをテストするケース

```
function test_function_name(){

	// テスト用の投稿（id=1）を作成 or 作成するメソッドを読み込み

	// テストの配列
	$test_cases = array(
		array(
			'test_condition_name'     => 'トップページ で option が apple で 個別指定が pen の場合 => pen',
			'conditions'    => array(
				'options' => array(
					'test_option_name1' => 'apple',
				),
				'post_id' => 1,
				'post_meta' => array(
					'test_post_meta_name' => 'pen',
				),
			),
			'target_url' => home_url( '/' ) . '?p=1',
			'expected' => 'pen',
		),
		array(
			'test_condition_name'     => 'トップページ で option が apple で個別指定なしの場合 => apple',
			'conditions'    => array(
				'options' => array(
					'test_option_name1' => 'apple',
				),
				'post_id' => 1,
				'post_meta' => array(
					'test_post_meta_name' => '',
				),
			),
			'target_url' => home_url( '/' ) . '?p=1',
			'expected' => 'apple',
		),
	);

	foreach ( $test_cases as $case ) {
		// オプション値を設定
		if ( isset( $case['conditions']['options'] ) && is_array( $case['conditions']['options'] ) ) {
			foreach($case['conditions']['options'] as $option_name => $option_value){
				update_option( $option_name, $option_value );
			}
		}
		// カスタムフィールドを設定
		if ( ! empty( $case['conditions']['post_id'] ) && $case['conditions']['post_id'] ){
			if ( isset( $case['conditions']['post_meta'] ) && is_array( $case['conditions']['post_meta'] ) ){
				foreach( $case['conditions']['post_meta'] as $meta_name => $meta_value ){
					update_post_meta( $case['conditions']['post_id'], $meta_name,$meta_value );
				}
			}
		}

		// テストURLに移動
		$this->go_to( $case['target_url'] );

		// テスト関数実行
		$actual = function_name();

		// 期待値テスト
		$this->assertEquals( $case['expected'], $actual, $case['test_condition_name'] );

		// オプション値を削除
		if ( isset( $case['conditions']['options'] ) && is_array( $case['conditions']['options'] ) ) {
			foreach($case['conditions']['options'] as $option_name => $option_value){
				delete_option( $option_name );
			}
		}

		// カスタムフィールドを削除
		if ( ! empty( $case['conditions']['post_id'] ) && $case['conditions']['post_id'] ){
			if ( isset( $case['conditions']['post_meta'] ) && is_array( $case['conditions']['post_meta'] ) ){
				foreach( $case['conditions']['post_meta'] as $meta_name => $meta_value ){
					delete_post_meta( $case['conditions']['post_id'], $meta_name );
				}
			}
		}
	}
}
```

## test_condition_name は日本語で記載する

`test_condition_name` キーには、どの条件でどの結果を期待するテストかを日本語で記載してください。
テスト失敗時のメッセージとして出力されるため、読んですぐ状況を把握できる表現にしてください。

例）`'test_condition_name' => 'オプションが apple で個別指定が pen の場合 => pen'`

## WordPress の場合は WP_UnitTestCase を継承する

WordPress プロジェクトのテストクラスは `WP_UnitTestCase` を継承し、必要に応じて以下を使用してください。

- `$this->go_to( $url )` — テスト対象の URL に移動する
- `update_option()` / `delete_option()` — オプション値のセット・クリーンアップ
- `update_post_meta()` / `delete_post_meta()` — 投稿メタのセット・クリーンアップ

## テストケースの最小要件

1つのテストメソッドには以下のケースを最低限含めてください:

- **正常系**: 2パターン以上
- **異常系または境界値**: 1パターン以上

## テスト作成後の検証

テストを書いた後、上記の最小要件を満たしているか確認してください。
不足している場合は、完了前にケースを追加してください。

## その他のルール

### expected にはメソッド（callable）を割り当てない

各条件と返り値の期待値を一覧できるよう配列で登録しているため、
`expected` をメソッドにすると期待値がわかりにくくなります。
`'expected' =>` の値は callable を使わず、リテラルや変数（条件に渡した変数の値を期待値に含む場合など）で直書きしてください。

```php
// NG
'expected' => array( $this, 'get_expected_value' ),

// OK（リテラル）
'expected' => true,
'expected' => 'published',
'expected' => 123,
'expected' => array( 'key' => 'value' ),
'expected' => null,

// OK（条件に渡した変数をそのまま期待値に使う場合）
'conditions' => array( 'post_title' => $item['title'] ),
'expected'   => 'タイトル : ' . $item['title'],
```
