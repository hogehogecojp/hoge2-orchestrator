/**
 * 「稼働中は入れ替えない」という不変条件の回帰テスト。
 *
 * この不変条件は自分たちで決めたもので、破ると動いている GUI と engine の足元で
 * インストールディレクトリが差し替わる。走行中のプロセスは古い実体を掴み続けるため、
 * 入れ替え後に engine が書く設定ファイルは控え側へ落ち、次回更新時の削除で黙って失われる。
 *
 * 実際に、明示コマンド（`vk-orchestrator update`）だけが稼働確認をしていて、
 * **既定 ON の自動経路（`up` 起動時）には確認が無い**状態になっていた。ユニットテストは
 * すべて緑のまま通り抜けたので、ここでは「CLI の実装が確認を通っているか」を
 * ソースの構造として検証する（実プロセスを起こさずに固定できる形にする）。
 *
 * 併せて、判定そのもの（evaluateUpdateBlockers）が両経路で共有されていることも見る。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { evaluateUpdateBlockers } from '../src/engine/update-apply.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 改行コードを LF へ揃えてから検査する。このテストはソースを**文字列として**読んで
// 構造を確かめるため、`'    return;\n  }'` のような改行込みのパターンを使う。
// Windows の Git は既定（core.autocrlf=true）でチェックアウト時に CRLF へ変換するので、
// 素で読むと実装が正しくてもパターンが一致せず落ちる。検証したいのは処理の順序であって
// 作業ツリーの改行コードではないので、読み取り時に吸収する。
const BIN_SOURCE = readFileSync(join(REPO_ROOT, 'bin', 'vk-orchestrator.js'), 'utf8')
  .replace(/\r\n/g, '\n');

/** 関数本体を名前から切り出す（次の同レベル関数宣言までを本体とみなす）。 */
function functionBody(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} が見つからない`);
  const rest = source.slice(start + 1);
  const nextDecl = rest.search(/\n(?:async )?function [A-Za-z]/);
  return nextDecl === -1 ? rest : rest.slice(0, nextDecl);
}

describe('自動経路（up 起動時）の稼働確認', () => {
  const body = functionBody(BIN_SOURCE, 'reconcileOrchestratorVersion');

  it('実行可否を測ってから判定する', () => {
    assert.match(
      body,
      /measureCurrentUpdateBlockers\(/,
      '自動経路が稼働確認を通っていない（動作中のプロセスの足元で入れ替わる）'
    );
  });

  it('稼働中であることを版の判定へも伝える（busy を渡す）', () => {
    assert.match(body, /runUpdateCheck\(\{[^}]*busy[^}]*\}\)/s, 'runUpdateCheck に busy を渡していない');
  });

  it('実行できない理由があれば入れ替えへ進まない', () => {
    // blockers を測るだけで分岐していなければ意味がない。
    assert.match(body, /if \(blockers\.length > 0\)/, 'blockers を測っただけで分岐していない');
    const guardIndex = body.indexOf('if (blockers.length > 0)');
    // 関数先頭の import 行にも名前が出るため、呼び出し（`名前(` の形）の位置で比較する。
    const zipIndex = body.indexOf('performZipUpdate({');
    const gitIndex = body.indexOf('applyGitUpdate(');
    assert.ok(guardIndex !== -1 && zipIndex !== -1 && gitIndex !== -1);
    assert.ok(guardIndex < zipIndex, '配布 zip の入れ替えより前に確認する');
    assert.ok(guardIndex < gitIndex, 'git の更新より前に確認する');
  });
});

// 入れ替え直後の起動し直しでは、展開先はもう install へ rename されていて片付ける対象が無く、
// かつ入れ替えを行った親プロセスがまだ更新ロックを保持している（--apply から返るまで解放されない）。
// ここで片付けを呼ぶと「アップデート処理が実行中」という案内が、切り替え成功の直後に毎回出る。
describe('アップデート直後の起動し直し', () => {
  const body = functionBody(BIN_SOURCE, 'reconcileOrchestratorVersion');

  it('展開先の片付けを呼ばずに戻る', () => {
    const returnIndex = body.indexOf('    return;\n  }');
    const pruneIndex = body.indexOf('pruneStaleStagingDirs(');
    assert.ok(returnIndex !== -1, 'アップデート後の早期 return が見つからない');
    assert.ok(pruneIndex !== -1, '片付けの呼び出しが見つからない');
    assert.ok(
      returnIndex < pruneIndex,
      'アップデート直後は片付けを呼ばずに戻ること（成功直後に「実行中」の案内を出さないため）'
    );
  });

  it('中断したアップデートの後始末は早期 return より前に行う', () => {
    // ここを飛ばすと「install が無い」状態のまま起動しようとして何も動かなくなる。
    const recoverIndex = body.indexOf('recoverPendingUpdate({');
    const returnIndex = body.indexOf('    return;\n  }');
    assert.ok(recoverIndex !== -1 && returnIndex !== -1);
    assert.ok(recoverIndex < returnIndex);
  });
});

describe('明示経路（update コマンド）の稼働確認', () => {
  const body = functionBody(BIN_SOURCE, 'runUpdateSubcommand');

  it('自動経路と同じ測り方を共有する', () => {
    assert.match(body, /measureCurrentUpdateBlockers\(/);
  });

  it('確認のみ（--check）では稼働確認を必要としない（副作用が無いため）', () => {
    assert.match(body, /checkOnly \? \[\] : await measureCurrentUpdateBlockers\(/);
  });
});

describe('入れ替え直前の再確認', () => {
  const body = functionBody(BIN_SOURCE, 'runUpdateApply');

  it('入れ替えを行う直前にもう一度測る（展開に数分かかる間に起動されうる）', () => {
    assert.match(body, /measureCurrentUpdateBlockers\(/);
    const measureIndex = body.indexOf('measureCurrentUpdateBlockers(');
    const applyIndex = body.indexOf('applyStagedUpdate(');
    assert.ok(measureIndex !== -1 && applyIndex !== -1);
    assert.ok(measureIndex < applyIndex, '入れ替えより前に測る');
  });

  it('測った結果を入れ替え処理へ渡す', () => {
    assert.match(body, /applyStagedUpdate\(\{[^}]*blockers[^}]*\}\)/s);
  });
});

describe('稼働確認の測り方（両経路の共通実装）', () => {
  const body = functionBody(BIN_SOURCE, 'measureCurrentUpdateBlockers');

  it('GUI の応答と起動ロックの両方を見る', () => {
    assert.match(body, /checkHealth\(/, 'GUI の応答を見ていない');
    assert.match(body, /defaultStartLockFile\(\)/, 'オーケストレーターの起動ロックを見ていない');
    assert.match(body, /measureUpdateBlockers\(/);
  });
});

describe('evaluateUpdateBlockers（判定の中身）', () => {
  it('GUI 稼働中は拒否する', () => {
    assert.deepEqual(
      evaluateUpdateBlockers({ channel: 'zip', healthResponding: true, startLockHeld: false })
        .map((b) => b.code),
      ['busy-gui']
    );
  });

  it('オーケストレーター稼働中は拒否する', () => {
    assert.deepEqual(
      evaluateUpdateBlockers({ channel: 'zip', healthResponding: false, startLockHeld: true })
        .map((b) => b.code),
      ['busy-engine']
    );
  });

  it('静止していれば通す', () => {
    assert.deepEqual(
      evaluateUpdateBlockers({ channel: 'zip', healthResponding: false, startLockHeld: false }),
      []
    );
  });
});
