/**
 * 設定パネルの「アップデート」欄のユニットテスト。
 *
 * 表示ブロック（tabs[].content）は同じタブの入力欄グループより必ず前に描かれ、
 * グループの間に差し込むことはできない。つまりここが長くなるほど既存の設定項目が
 * 下へ押し下がるため、平常時の行数を最小に保つことが仕様そのものになる。
 *
 * また、押すだけの項目を入力欄（field）として混ぜると VK Terminals 側の検証
 * （全 field に保存先の解決を要求する）で定義全体が無効になり、設定パネルが
 * ビルトインの内容へフォールバックしてしまう。ここではその境界も固定する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_UPDATE,
  buildSettingsDescriptor,
  buildUpdateContentBlocks,
  buildVersionInfoContentBlocks,
} from '../src/config.js';

const CHECKED_AT = new Date(2026, 6, 30, 9, 12, 0).toISOString();
// 表示時点の現在時刻。既定では確認時刻と同じ瞬間にして「長く未確認」に倒れないようにする。
const NOW = new Date(2026, 6, 30, 9, 12, 0);
// 長く確認できていない状態（33 日前）。
const STALE = new Date(2026, 5, 27, 13, 23, 0).toISOString();

// 実運用の記録と同じ形にする。更新情報ファイル（配布サーバー）は変更履歴の URL を常に持ち、
// saveUpdateSnapshot は更新の有無に関係なくそれを記録するため、zip 環境の記録には必ず入る。
// ここを省いたフィクスチャで検証すると、実物と違う条件で緑になってしまう。
function snapshot(overrides = {}) {
  return {
    channel: 'zip',
    current: '1.5.0',
    latest: '1.5.0',
    updateAvailable: false,
    notice: null,
    summary: 'お使いの版は 1.5.0 で、最新です。2026年7月30日 9:12 に確認しました。',
    lastCheckedAt: CHECKED_AT,
    autoUpdate: true,
    changelogUrl: 'https://example.com/CHANGELOG.md',
    ...overrides,
  };
}

const CONTEXT = { vkTerminalsVersion: '1.48.0', vendoredVkAgentsVersion: 'v0.14.0' };

describe('buildUpdateContentBlocks（アップデートの状況）', () => {
  it('最新で問題も無いときは見出しと 1 行の 2 ブロックで終わる（既存の設定項目を押し下げない）', () => {
    assert.deepEqual(buildUpdateContentBlocks(snapshot(), { now: NOW }), [
      { type: 'heading', text: 'アップデートの状況', level: 3 },
      { type: 'paragraph', text: 'お使いの版は 1.5.0 で、最新です。2026年7月30日 9:12 に確認しました。' },
    ]);
  });

  // 更新情報ファイルは変更履歴の URL を常に持つため、zip 環境の記録には必ず入っている。
  // 変更履歴リンクをこの欄に置くと、平常時が 2 行に収まらなくなる（実運用と違うフィクスチャで
  // 「2 行で終わる」と検証していたために見落とした型）。
  it('変更履歴の URL があってもブロック数は増えない（バージョン情報タブへ置くため）', () => {
    const blocks = buildUpdateContentBlocks(snapshot(), { now: NOW });
    assert.equal(blocks.length, 2);
    assert.equal(blocks.some((b) => b.type === 'links'), false);
  });

  it('見出しは入力欄グループのラベルと重ならない（同じタブで同じ語が 2 回立たない）', () => {
    const desc = buildSettingsDescriptor('/tmp/config.json', { updateSnapshot: null });
    const contentHeading = desc.tabs[0].content.find((b) => b.type === 'heading').text;
    const groupLabels = desc.groups.filter((g) => g.tab === 'orchestrator').map((g) => g.label);
    assert.equal(groupLabels.includes(contentHeading), false, `見出しとグループ名が同じ: ${contentHeading}`);
  });

  it('問い合わせ用の版一覧はここには置かない（専用タブへ常設する）', () => {
    for (const snap of [snapshot(), snapshot({ updateAvailable: true, latest: '1.6.0' })]) {
      const blocks = buildUpdateContentBlocks(snap, { now: NOW });
      assert.equal(blocks.some((b) => b.type === 'code' && b.text.includes('VK Terminals:')), false);
    }
  });

  it('お知らせは 1 つだけ出す', () => {
    const blocks = buildUpdateContentBlocks(
      snapshot({
        updateAvailable: true,
        latest: '1.6.0',
        notice: { code: 'zip-update-available', tone: 'info', lines: ['A です。', 'B です。'] },
      }),
      { now: NOW }
    );
    const callouts = blocks.filter((b) => b.type === 'callout');
    assert.equal(callouts.length, 1);
    assert.equal(callouts[0].tone, 'info');
    // 起動時ログと同じ 1 本の文字列にする（改行は callout では表示に反映されないため）。
    assert.equal(callouts[0].text, 'A です。 B です。');
  });

  it('人が対応しないと直らない状態は warning のお知らせにする', () => {
    const blocks = buildUpdateContentBlocks(
      snapshot({
        channel: 'git',
        updateAvailable: true,
        latest: '1.6.0',
        notice: { code: 'dirty', tone: 'warning', lines: ['保存していない変更があります。'] },
      }),
      { now: NOW }
    );
    assert.equal(blocks.find((b) => b.type === 'callout').tone, 'warning');
  });

  // 自動で切り替わる道があるときにコマンドを足すと、同じ結果に至る手順が 3 つ並び、
  // しかもコマンドは「終了して起動し直す」より手数が多いだけになる。
  it('git ＋自動更新 ON ＋更新ありでは、お知らせだけの 3 ブロックにする', () => {
    const blocks = buildUpdateContentBlocks(
      snapshot({
        channel: 'git',
        updateAvailable: true,
        latest: '1.6.0',
        notice: {
          code: 'git-update-available',
          tone: 'info',
          lines: ['次にアプリを起動したときに、自動で新しい版 1.6.0 に切り替わります。'],
        },
      }),
      { now: NOW }
    );
    assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'callout']);
    assert.equal(blocks.some((b) => b.type === 'code'), false, '自動で切り替わるならコマンドは出さない');
  });

  it('自動更新 OFF のときはコマンドが本当の代替手段になるので出す', () => {
    const blocks = buildUpdateContentBlocks(
      snapshot({
        channel: 'git',
        updateAvailable: true,
        latest: '1.6.0',
        notice: { code: 'auto-update-off', tone: 'info', lines: ['自動でのアップデートを OFF にしています。'] },
      }),
      { now: NOW }
    );
    const codes = blocks.filter((b) => b.type === 'code');
    assert.equal(codes.length, 1);
    assert.equal(codes[0].text, 'git pull --ff-only && npm install');
    assert.equal(codes[0].copy, true, 'コピーボタンを出す');
  });

  it('コマンドの直前に前置きを置く（裸のコマンドだけを出さない）', () => {
    const blocks = buildUpdateContentBlocks(
      snapshot({
        channel: 'git',
        updateAvailable: true,
        latest: '1.6.0',
        notice: { code: 'auto-update-off', tone: 'info', lines: ['自動でのアップデートを OFF にしています。'] },
      }),
      { now: NOW }
    );
    const codeIndex = blocks.findIndex((b) => b.type === 'code');
    const preface = blocks[codeIndex - 1];
    assert.equal(preface.type, 'paragraph');
    // 設定画面はアプリが動いている間しか開けないので、終了を促す文が必須。
    assert.match(preface.text, /終了して/);
  });

  it('未コミット変更のときは前置きを重ねない（お知らせ本文が既にコマンドを指している）', () => {
    const blocks = buildUpdateContentBlocks(
      snapshot({
        channel: 'git',
        updateAvailable: true,
        latest: '1.6.0',
        notice: { code: 'dirty', tone: 'warning', lines: ['下のコマンドで変更の一覧を確認してください。'] },
      }),
      { now: NOW }
    );
    const codeIndex = blocks.findIndex((b) => b.type === 'code');
    assert.equal(blocks[codeIndex].text, 'git status');
    assert.equal(blocks[codeIndex - 1].type, 'callout', 'お知らせの直後にコマンドを置く');
    assert.equal(blocks.filter((b) => b.type === 'paragraph').length, 1, 'バージョン行の 1 つだけ');
  });

  it('zip 環境には git のコマンドを出さない（手順は終了→起動で完結する）', () => {
    for (const code of ['zip-update-available', 'auto-update-off']) {
      const blocks = buildUpdateContentBlocks(
        snapshot({
          channel: 'zip',
          updateAvailable: true,
          latest: '1.6.0',
          notice: { code, tone: 'info', lines: ['x'] },
        }),
        { now: NOW }
      );
      assert.equal(blocks.some((b) => b.type === 'code'), false, `コマンドを出してはいけない: ${code}`);
    }
  });

  // 経過時間は「見た瞬間」の性質。記録に焼いた判定だけを見ていると、確認が走らない構成
  // （オーケストレーターを起動しない GUI セッションなど）では 1 か月前の確認結果で
  // 「最新です」と出し続けてしまう。
  it('確認から長く経っていれば、表示する時点で注意を合成する', () => {
    const blocks = buildUpdateContentBlocks(snapshot({ lastCheckedAt: STALE, notice: null }), { now: NOW });
    const callout = blocks.find((b) => b.type === 'callout');
    assert.ok(callout, '記録に無くても表示時点で注意を出す');
    assert.equal(callout.tone, 'warning');
    assert.match(callout.text, /7 日以上/);
  });

  it('確認が新しければ注意を合成しない', () => {
    const blocks = buildUpdateContentBlocks(snapshot(), { now: NOW });
    assert.equal(blocks.some((b) => b.type === 'callout'), false);
  });

  // 記録された info で短絡させると、確認が失敗した記録（offline）が居座って
  // 経過時間の評価に入れなくなる。
  it('記録が info でも、長く未確認なら注意へ切り替える', () => {
    const blocks = buildUpdateContentBlocks(
      snapshot({
        lastCheckedAt: STALE,
        notice: { code: 'offline', tone: 'info', lines: ['新しい版があるかを確認できませんでした。'] },
      }),
      { now: NOW }
    );
    const callouts = blocks.filter((b) => b.type === 'callout');
    assert.equal(callouts.length, 1);
    assert.equal(callouts[0].tone, 'warning');
    assert.match(callouts[0].text, /7 日以上/);
  });

  it('記録が warning なら、長く未確認でもそちらを優先して 1 つに保つ', () => {
    const blocks = buildUpdateContentBlocks(
      snapshot({
        channel: 'git',
        lastCheckedAt: STALE,
        notice: { code: 'dirty', tone: 'warning', lines: ['保存していない変更があります。'] },
      }),
      { now: NOW }
    );
    const callouts = blocks.filter((b) => b.type === 'callout');
    assert.equal(callouts.length, 1);
    assert.equal(callouts[0].text, '保存していない変更があります。');
  });

  it('長く未確認なら、バージョン行から「最新です」を落とす（版と時刻は残す）', () => {
    const blocks = buildUpdateContentBlocks(snapshot({ lastCheckedAt: STALE, notice: null }), { now: NOW });
    const line = blocks.find((b) => b.type === 'paragraph').text;
    assert.equal(line, 'お使いの版は 1.5.0 です。2026年6月27日 13:23 に確認しました。');
    assert.doesNotMatch(line, /最新です/, '裏付けの無い断言を残さない');
    assert.match(line, /1\.5\.0/, 'いちばん有用な事実（版）は残す');
  });

  // 記録された warning が勝つ場合も「長く確認できていない」ことは成り立つので、
  // バージョン行はそちらにも従う（notice.code だけを見ていると断言が残る）。
  it('記録の warning が勝つ場合も、バージョン行から断言を落とす', () => {
    const blocks = buildUpdateContentBlocks(
      snapshot({
        channel: 'git',
        lastCheckedAt: STALE,
        notice: { code: 'dirty', tone: 'warning', lines: ['保存していない変更があります。'] },
      }),
      { now: NOW }
    );
    const line = blocks.find((b) => b.type === 'paragraph').text;
    assert.doesNotMatch(line, /最新です/);
    assert.match(line, /1\.5\.0/);
  });

  it('長く未確認のときはコマンドを出さない（ネットワークが直っていないのに勧めない）', () => {
    const blocks = buildUpdateContentBlocks(
      snapshot({ channel: 'git', updateAvailable: true, latest: '1.6.0', lastCheckedAt: STALE, notice: null }),
      { now: NOW }
    );
    assert.equal(blocks.some((b) => b.type === 'code'), false);
  });

  it('ブロック数は 3 のまま（高さを変えない）', () => {
    assert.equal(buildUpdateContentBlocks(snapshot({ lastCheckedAt: STALE, notice: null }), { now: NOW }).length, 3);
  });

  it('確認記録が無くても落ちず、未確認として描く', () => {
    const blocks = buildUpdateContentBlocks(null, { now: NOW });
    assert.equal(blocks[0].text, 'アップデートの状況');
    assert.equal(blocks[1].type, 'paragraph');
    assert.ok(blocks[1].text.length > 0);
  });
});

describe('buildVersionInfoContentBlocks（バージョン情報タブ）', () => {
  it('アップデートの状況に関係なく常に版一覧を出す', () => {
    for (const snap of [snapshot(), snapshot({ updateAvailable: true, latest: '1.6.0' }), null]) {
      const blocks = buildVersionInfoContentBlocks(snap, CONTEXT);
      assert.ok(blocks.some((b) => b.type === 'code' && b.text.includes('VK Terminals:')));
    }
  });

  it('見出しはタブ名と同じ語にしない', () => {
    const desc = buildSettingsDescriptor('/tmp/config.json', { updateSnapshot: null });
    const tab = desc.tabs.find((t) => t.id === 'version');
    const heading = tab.content.find((b) => b.type === 'heading').text;
    assert.notEqual(heading, tab.label, `タブ名と見出しが同じ: ${heading}`);
  });

  it('説明文を先、内容を後ろに置く（「下の内容」で位置を指せる）', () => {
    const blocks = buildVersionInfoContentBlocks(snapshot(), CONTEXT);
    assert.equal(blocks[0].type, 'heading');
    assert.equal(blocks[0].level, 3);
    assert.equal(blocks[1].type, 'paragraph');
    assert.equal(blocks[1].text, 'お問い合わせのときは、下の内容をコピーして添えてください。');
    assert.equal(blocks[2].type, 'code');
  });

  it('各コンポーネントの版をまとめてコピーできる形で出す', () => {
    const diagnostics = buildVersionInfoContentBlocks(snapshot(), CONTEXT).find((b) => b.type === 'code');
    assert.match(diagnostics.text, /VK Orchestrator: 1\.5\.0/);
    assert.match(diagnostics.text, /VK Terminals: 1\.48\.0/);
    assert.match(diagnostics.text, /vk-agents（同梱）: v0\.14\.0/);
    assert.equal(diagnostics.copy, true);
  });

  it('変更履歴は https のときだけリンクを出す', () => {
    const withLink = buildVersionInfoContentBlocks(snapshot(), CONTEXT);
    assert.deepEqual(withLink.find((b) => b.type === 'links').items, [
      { label: '変更履歴', url: 'https://example.com/CHANGELOG.md' },
    ]);

    const without = buildVersionInfoContentBlocks(snapshot({ changelogUrl: null }), CONTEXT);
    assert.equal(without.some((b) => b.type === 'links'), false);
  });

  it('危険な scheme の変更履歴 URL は表示しない（GUI 側の防御に依存しない）', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'http://example.com/x', 'not a url']) {
      const blocks = buildVersionInfoContentBlocks(snapshot({ changelogUrl: url }), CONTEXT);
      assert.equal(blocks.some((b) => b.type === 'links'), false, `通してはいけない URL: ${url}`);
    }
  });
});

describe('表示ブロックの共通条件', () => {
  it('表示ブロックの種類は VK Terminals が解釈できるものだけを使う', () => {
    const allowed = new Set(['heading', 'paragraph', 'list', 'links', 'code', 'callout', 'tabLink']);
    const situation = snapshot({
      channel: 'git',
      updateAvailable: true,
      latest: '1.6.0',
      notice: { code: 'dirty', tone: 'warning', lines: ['x'] },
    });
    for (const blocks of [
      buildUpdateContentBlocks(situation, { now: NOW }),
      buildVersionInfoContentBlocks(situation, CONTEXT),
    ]) {
      for (const block of blocks) {
        assert.ok(allowed.has(block.type), `未対応のブロック種別: ${block.type}`);
      }
    }
  });

  it('設定ディスクリプタが出す全タブの content が解釈できる種類だけで構成される', () => {
    const allowed = new Set(['heading', 'paragraph', 'list', 'links', 'code', 'callout', 'tabLink', 'status']);
    const desc = buildSettingsDescriptor('/tmp/config.json', { updateSnapshot: null });
    for (const tab of desc.tabs) {
      for (const block of tab.content ?? []) {
        assert.ok(allowed.has(block.type), `未対応のブロック種別: ${block.type} (tab: ${tab.id})`);
      }
    }
  });
});

describe('アップデート設定グループ', () => {
  it('Orchestrator タブの先頭グループとして置く', () => {
    const desc = buildSettingsDescriptor('/tmp/config.json', { updateSnapshot: null });
    const orchestratorGroups = desc.groups.filter((g) => g.tab === 'orchestrator');
    assert.equal(orchestratorGroups[0].label, '自動アップデート');
  });

  it('保存先を ~/.vk-orchestrator/config.json に明示する（作業ツリー内へ書かないため）', () => {
    const desc = buildSettingsDescriptor('/tmp/config.json', { updateSnapshot: null });
    const group = desc.groups.find((g) => g.label === '自動アップデート');
    assert.equal(group.targetPath, '~/.vk-orchestrator/config.json');
  });

  it('「起動時に自動でアップデートする」は既定 ON のチェック項目', () => {
    const desc = buildSettingsDescriptor('/tmp/config.json', { updateSnapshot: null });
    const field = desc.groups
      .find((g) => g.label === '自動アップデート')
      .fields.find((f) => f.key === 'update.autoUpdate');
    assert.equal(field.type, 'boolean');
    assert.equal(field.default, true);
    assert.equal(DEFAULT_UPDATE.autoUpdate, true);
    assert.equal(field.label, '起動時に自動でアップデートする');
    assert.match(field.help, /既定: ON/);
    // 切り替え後に起動し直すこと（そのとき起動が長くなること）も画面から分かるようにする。
    assert.match(field.help, /起動し直す/);
    assert.match(field.help, /OFF にすると/);
  });

  it('押すだけの項目を入力欄に混ぜない（全 field が保存先を解決できる状態を保つ）', () => {
    const desc = buildSettingsDescriptor('/tmp/config.json', { updateSnapshot: null });
    for (const group of desc.groups) {
      for (const field of group.fields ?? []) {
        const hasTarget =
          typeof field.targetPath === 'string' ||
          typeof group.targetPath === 'string' ||
          typeof desc.targetPath === 'string';
        assert.ok(hasTarget, `保存先が解決できない項目がある: ${field.key}`);
        assert.ok(typeof field.key === 'string' && field.key !== '');
      }
    }
  });
});
