import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PANE_OWNERSHIP,
  findPaneByTermId,
  resolvePaneOwnership,
} from '../src/engine/pane-identity.js';
import { buildPaneTitle } from '../src/engine/build-command.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PR_URL = 'https://github.com/vektor-inc/example/pull/79';
const TITLE_URL = 'https://github.com/vektor-inc/example/issues/300';

describe('findPaneByTermId', () => {
  it('termId が一致するペインを返す（数値と文字列の型差は吸収する）', () => {
    const terminals = { 'pane-1': { termId: 1 }, 'pane-2': { termId: 2 } };
    assert.deepEqual(findPaneByTermId(terminals, '2'), { termId: 2 });
  });

  it('一致するペインが無い・terminals が不正なら null を返す', () => {
    assert.equal(findPaneByTermId({ 'pane-1': { termId: 1 } }, 9), null);
    assert.equal(findPaneByTermId(null, 1), null);
    assert.equal(findPaneByTermId('terminals', 1), null);
    assert.equal(findPaneByTermId({ 'pane-1': null }, 1), null);
    assert.equal(findPaneByTermId({ 'pane-1': { termId: 1 } }, null), null);
  });
});

describe('resolvePaneOwnership', () => {
  it('期待どおりの PR URL とヘッダー URL を持つペインは所有者', () => {
    const result = resolvePaneOwnership({
      pane: { apiPrUrl: PR_URL, apiUrl: TITLE_URL },
      expectedPrUrl: PR_URL,
      expectedTitleUrl: TITLE_URL,
    });
    assert.equal(result.ownership, PANE_OWNERSHIP.OWNER);
    assert.equal(result.mismatch, null);
  });

  // 期待値の変更（安藤レビュー）: 以前はこのケースを pr-url 不一致で別タスクと判定していた。
  // しかし apiPrUrl は「こちらが書いたときだけ更新される可変値」で、同じタスクの PR が
  // 張り替わる（PR#1 を閉じて PR#2 を作る）と陳腐化する。ヘッダー URL が一致しているのに
  // 別タスクへ倒すと、以後そのタスクは通知もバッジも永久に届かず、差し戻しでは生きている
  // 作業ペインを捨てて新規ペインを作ってしまう。ヘッダー URL は起動時に一度設定して以後
  // 変化しない identity なので、そちらが一致していれば所有者で確定させる。
  it('PR が張り替わって apiPrUrl が陳腐化していても、ヘッダー URL が一致すれば所有者', () => {
    const result = resolvePaneOwnership({
      pane: { apiPrUrl: 'https://github.com/vektor-inc/example/pull/12', apiUrl: TITLE_URL },
      expectedPrUrl: PR_URL,
      expectedTitleUrl: TITLE_URL,
    });
    assert.equal(result.ownership, PANE_OWNERSHIP.OWNER);
    assert.equal(result.mismatch, null);
  });

  // ヘッダーで判断できないとき（tmux 等・この変更より前に起動した既存タスク）は、
  // 従来どおり担当 PR で判定する。
  it('ヘッダーで判断できない場合は、別の PR を担当しているペインを別タスクと判定する', () => {
    const result = resolvePaneOwnership({
      pane: { apiPrUrl: 'https://github.com/vektor-inc/example/pull/12' },
      expectedPrUrl: PR_URL,
      expectedTitleUrl: null,
    });
    assert.equal(result.ownership, PANE_OWNERSHIP.OTHER_TASK);
    assert.equal(result.mismatch, 'pr-url');
    assert.equal(result.paneValue, 'https://github.com/vektor-inc/example/pull/12');
    assert.equal(result.expectedValue, PR_URL);
  });

  // #263 の主現象。閉じたペインの termId が別タスクの新しいペインへ再採番されると、
  // そのペインは PR 未検知（apiPrUrl 空）なので PR 照合をすり抜ける。
  it('PR URL は空でもヘッダー URL が別 issue を指していれば別タスク（不一致理由は title-url）', () => {
    const result = resolvePaneOwnership({
      pane: { apiPrUrl: '', apiUrl: 'https://github.com/vektor-inc/example/issues/901' },
      expectedPrUrl: PR_URL,
      expectedTitleUrl: TITLE_URL,
    });
    assert.equal(result.ownership, PANE_OWNERSHIP.OTHER_TASK);
    assert.equal(result.mismatch, 'title-url');
  });

  it('識別情報を一切持たないペイン（tmux 等）は照合不能として state を信頼する', () => {
    const result = resolvePaneOwnership({
      pane: { termId: '%1', lastLines: '' },
      expectedPrUrl: PR_URL,
      expectedTitleUrl: TITLE_URL,
    });
    assert.equal(result.ownership, PANE_OWNERSHIP.UNVERIFIABLE);
    assert.equal(result.mismatch, null);
  });

  // この変更より前に起動したタスクのレコードには paneTitleUrl が無い。ここを不一致に
  // 倒すと、実行中の既存タスクが黙って通知・差し戻し先を失う。
  it('state に paneTitleUrl が無ければヘッダー照合は行わない（後方互換）', () => {
    const result = resolvePaneOwnership({
      pane: { apiPrUrl: '', apiUrl: 'https://github.com/vektor-inc/example/issues/901' },
      expectedPrUrl: PR_URL,
      expectedTitleUrl: null,
    });
    assert.equal(result.ownership, PANE_OWNERSHIP.UNVERIFIABLE);
    assert.equal(result.mismatch, null);
  });

  it('PR URL だけ一致していれば（ヘッダー情報が無くても）所有者と判定する', () => {
    const result = resolvePaneOwnership({
      pane: { apiPrUrl: PR_URL },
      expectedPrUrl: PR_URL,
      expectedTitleUrl: TITLE_URL,
    });
    assert.equal(result.ownership, PANE_OWNERSHIP.OWNER);
  });

  it('ヘッダー URL だけ一致していれば（PR 未設定でも）所有者と判定する', () => {
    const result = resolvePaneOwnership({
      pane: { apiPrUrl: '', apiUrl: TITLE_URL },
      expectedPrUrl: PR_URL,
      expectedTitleUrl: TITLE_URL,
    });
    assert.equal(result.ownership, PANE_OWNERSHIP.OWNER);
  });

  // 「PR 未設定」の表現は空文字（setTerminalPrUrl 自身が prUrl ?? '' を書き込む）なので、
  // 空文字・空白のみを不一致として扱ってはいけない（#258 の回帰そのもの）。
  it('空文字・空白のみ・非文字列は「未設定」として扱い、不一致にしない', () => {
    for (const value of ['', '   ', null, undefined, 42, {}]) {
      const result = resolvePaneOwnership({
        pane: { apiPrUrl: value, apiUrl: value },
        expectedPrUrl: PR_URL,
        expectedTitleUrl: TITLE_URL,
      });
      assert.equal(
        result.ownership,
        PANE_OWNERSHIP.UNVERIFIABLE,
        `${JSON.stringify(value)} は未設定として扱う`
      );
    }
  });

  it('apiPrUrl が未設定なら prUrl 側へフォールバックして照合する', () => {
    const result = resolvePaneOwnership({
      pane: { apiPrUrl: '', prUrl: 'https://github.com/vektor-inc/example/pull/12' },
      expectedPrUrl: PR_URL,
      expectedTitleUrl: null,
    });
    assert.equal(result.ownership, PANE_OWNERSHIP.OTHER_TASK);
    assert.equal(result.mismatch, 'pr-url');
  });

  it('期待値が無い（照合材料をこちらが持たない）場合も照合不能で state を信頼する', () => {
    const result = resolvePaneOwnership({
      pane: { apiPrUrl: PR_URL, apiUrl: TITLE_URL },
    });
    assert.equal(result.ownership, PANE_OWNERSHIP.UNVERIFIABLE);
  });

  it('ペインそのものが無ければ照合不能', () => {
    assert.equal(
      resolvePaneOwnership({ pane: null, expectedPrUrl: PR_URL, expectedTitleUrl: TITLE_URL }).ownership,
      PANE_OWNERSHIP.UNVERIFIABLE
    );
  });

  // 期待値の変更（安藤レビュー）: 以前は PR 側を理由として報告していたが、ヘッダー URL を
  // 優先して判定するようにしたため、両方ずれていてもヘッダー側で確定する。判定に使った
  // 材料と報告する理由がずれるとログから原因を辿れないので、理由も title-url に揃える。
  it('PR とヘッダーの両方が不一致ならヘッダー側を理由として報告する', () => {
    const result = resolvePaneOwnership({
      pane: {
        apiPrUrl: 'https://github.com/vektor-inc/example/pull/12',
        apiUrl: 'https://github.com/vektor-inc/example/issues/901',
      },
      expectedPrUrl: PR_URL,
      expectedTitleUrl: TITLE_URL,
    });
    assert.equal(result.ownership, PANE_OWNERSHIP.OTHER_TASK);
    assert.equal(result.mismatch, 'title-url');
  });
});

// -------------------------------------------------------
// ヘッダー URL による照合は「その URL がタスクごとに一意」であることに依存する。
// buildPaneTitle と resolvePaneOwnership を実際につないで、その前提が保たれているかを見る。
// -------------------------------------------------------
describe('ヘッダー URL のタスク一意性（buildPaneTitle との結合）', () => {
  const SOURCE_ISSUE = {
    number: 275,
    title: '移動先のタブに入力欄も説明も無い',
    url: 'https://github.com/vektor-inc/vk-terminals/issues/275',
  };
  const metaIssue = (number) => ({
    number,
    title: `[vk-terminals] タスク ${number}`,
    html_url: `https://github.com/vektor-inc/task-queue/issues/${number}`,
  });

  // resolveTarget() はメタ issue 本文から元 issue の URL を拾うだけで排他が無いため、
  // 同じ元 issue を指すメタ issue は複数作られうる（失敗タスクの再登録・作業分割）。
  // ヘッダー URL が元 issue の URL そのものだと 2 つのペインで同値になり、
  // termId の掴み違いが起きたときに「一致した」ことにされてしまう。
  it('同じ元 issue を指す 2 タスクのペインを取り違えたら別タスクと判定する', () => {
    const taskA = buildPaneTitle(metaIssue(581), SOURCE_ISSUE);
    const taskB = buildPaneTitle(metaIssue(900), SOURCE_ISSUE);

    assert.notEqual(taskA.url, taskB.url, '同じ元 issue でもタスクごとに違う URL になる');

    const result = resolvePaneOwnership({
      // 掴んでいるのはタスク B のペイン
      pane: { apiUrl: taskB.url },
      // 期待しているのはタスク A（state に残っている控え）
      expectedTitleUrl: taskA.url,
    });
    assert.equal(result.ownership, PANE_OWNERSHIP.OTHER_TASK);
    assert.equal(result.mismatch, 'title-url');
  });

  it('同じタスクのペインなら（当然）所有者と判定する', () => {
    const taskA = buildPaneTitle(metaIssue(581), SOURCE_ISSUE);
    const result = resolvePaneOwnership({
      pane: { apiUrl: taskA.url },
      expectedTitleUrl: taskA.url,
    });
    assert.equal(result.ownership, PANE_OWNERSHIP.OWNER);
  });
});

// -------------------------------------------------------
// 再発防止の蓋: stale termId を使う経路が照合を通しているか
//
// index.js は import しただけで常駐処理が動き出す副作用モジュールのため、
// ensureConflictHandbackPane / recordPRAcrossSurfaces は関数として呼べない。
// 判定ロジック自体は上の純粋関数テストで担保済みで、ここで見るのは
// 「照合を通さない stale termId 経路が残っていないか」だけ。
// -------------------------------------------------------
describe('stale termId 経路の配線（src/engine/index.js）', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'engine', 'index.js'), 'utf8');

  function sliceFunction(name) {
    const start = source.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, `${name} の定義が見つかりません`);
    const next = source.indexOf('\nasync function ', start + 1);
    return source.slice(start, next === -1 ? source.length : next);
  }

  it('ensureConflictHandbackPane は既存ペインを再利用する前に所有者を照合する', () => {
    const body = sliceFunction('ensureConflictHandbackPane');
    assert.match(body, /resolvePaneOwnership\(/, '照合ヘルパーを通していない');
    assert.match(body, /PANE_OWNERSHIP\.OTHER_TASK/, '別タスク判定の分岐が無い');
    assert.match(body, /paneTitleUrl/, 'state のヘッダー URL を照合材料に渡していない');
  });

  it('recordPRAcrossSurfaces は PR バッジを書く前に所有者を照合する', () => {
    const body = sliceFunction('recordPRAcrossSurfaces');
    assert.match(body, /PANE_OWNERSHIP\.OTHER_TASK/, '別タスク判定の分岐が無い');
    assert.match(body, /setTerminalPrUrl/, 'PR バッジ送信の呼び出しが見つかりません');
  });

  // 「これから書き込む値」を期待値にすると、ペイン側は未設定か別値しか返しようがない。
  // 所有権の肯定材料にならないばかりか、PR を張り替えた自分自身のペインを別タスクと
  // 誤判定し、以後 PR ボタンが二度と更新されなくなる（安藤レビュー）。
  it('recordPRAcrossSurfaces は照合の期待値に PR URL を渡さない', () => {
    assert.doesNotMatch(
      sliceFunction('recordPRAcrossSurfaces'),
      /expectedPrUrl/,
      'これから書き込む PR URL を照合の期待値にしている'
    );
  });

  it('ペイン作成時に設定したヘッダー URL を state へ記録している', () => {
    assert.match(
      sliceFunction('startTask'),
      /paneTitleUrl/,
      '通常起動で paneTitleUrl を state に残していない'
    );
  });

  // state.json は $HOME 固定のため実 I/O では検証できない（利用者の state を壊すため）。
  // 受け渡しが片方だけ欠けると照合材料が常に null になり、機能が黙って無効化される
  // （常に「照合不能」＝修正前の挙動へ戻る）ので、その一点だけソースで蓋をする。
  it('recordTaskStart は受け取った paneTitleUrl をレコードへ書いている', () => {
    const stateSource = readFileSync(join(__dirname, '..', 'src', 'engine', 'state.js'), 'utf8');
    const start = stateSource.indexOf('export function recordTaskStart(');
    assert.notEqual(start, -1, 'recordTaskStart の定義が見つかりません');
    const body = stateSource.slice(start, stateSource.indexOf('\nexport function', start + 1));

    assert.match(body, /recordTaskStart\(\{[^}]*paneTitleUrl/, '引数で受け取っていない');
    assert.match(body, /state\.issues\[key\] = \{[\s\S]*?paneTitleUrl/, 'レコードへ書いていない');
  });
});
