import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTmuxBackend } from '../src/terminals/backend-tmux.js';

// tmux 実行を差し替えるフェイク。呼ばれた args を記録し、指定した stdout を返す。
function fakeRunner(responses = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const key = args.join(' ');
    for (const [prefix, out] of Object.entries(responses)) {
      if (key.startsWith(prefix)) return { status: 0, stdout: out, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('createNewPane: split-window で並べ、pane_id を返し tiled に整える', async () => {
  const { run, calls } = fakeRunner({ 'split-window': '%3\n' });
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  const termId = await be.createNewPane(0, '/work/dir', {});
  assert.equal(termId, '%3');
  const sw = calls.find(a => a.includes('split-window'));
  assert.ok(sw.includes('-t') && sw.includes('vk-orch'));
  assert.ok(sw.includes('-c') && sw.includes('/work/dir'));
  assert.ok(sw.join(' ').includes('claude'));                   // claudeCommand を起動
  const layout = calls.find(a => a.includes('select-layout'));
  assert.deepEqual(layout, ['select-layout', '-t', 'vk-orch', 'tiled']);
});

test('createNewPane: noClaude なら claude を起動しない', async () => {
  const { run, calls } = fakeRunner({ 'split-window': '%4\n' });
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  await be.createNewPane(0, null, { noClaude: true });
  const sw = calls.find(a => a.includes('split-window'));
  assert.ok(!sw.join(' ').includes('claude'));
});

test('sendToTerminal: \\r は Enter、本文はリテラル送信', async () => {
  const { run, calls } = fakeRunner();
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  await be.sendToTerminal(0, '%3', 'hello world');
  await be.sendToTerminal(0, '%3', '\r');
  const literal = calls.find(a => a.includes('-l'));
  assert.deepEqual(literal, ['send-keys', '-t', '%3', '-l', '--', 'hello world']);
  const enter = calls.find(a => a.includes('Enter'));
  assert.deepEqual(enter, ['send-keys', '-t', '%3', 'Enter']);
});

test('sendToTerminal: tmux が失敗(status!=0)したら throw する', async () => {
  const run = () => ({ status: 1, stdout: '', stderr: 'no such pane' });
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  await assert.rejects(() => be.sendToTerminal(0, '%3', 'hi'), /send-keys failed/);
});

test('getStates: 生成済みペインのみ、lastOutputTime は ms（内容変化で更新）', async () => {
  let clock = 5000;
  const { run } = fakeRunner({
    'split-window': '%3\n',
    'list-panes': '%3\n%9\n',   // %9 は追跡外（orchestrator等）→ 報告しない
    'capture-pane': 'line1\nline2\n',
  });
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run, now: () => clock });
  await be.createNewPane(0, null, {});
  const { terminals } = await be.getStates(0);
  const ids = Object.keys(terminals);
  assert.deepEqual(ids, ['%3']);
  assert.equal(terminals['%3'].termId, '%3');
  assert.equal(terminals['%3'].lastOutputTime, 5000); // 初回 capture で '' → 内容ありに変化 → now
  assert.match(terminals['%3'].lastLines, /line2/);
  assert.equal(terminals['%3'].waiting, false);
});

test('getStates: ペインごとに出力変化で idle を個別判定する（window 共有しない）', async () => {
  let clock = 100;
  let idCounter = 0;
  const capById = { '%1': 'aaa', '%2': 'xxx' };
  const run = (args) => {
    const key = args.join(' ');
    if (key.startsWith('split-window')) return { status: 0, stdout: `%${++idCounter}\n`, stderr: '' };
    if (key.startsWith('list-panes')) return { status: 0, stdout: '%1\n%2\n', stderr: '' };
    if (key.startsWith('capture-pane')) {
      const id = args[args.indexOf('-t') + 1];
      return { status: 0, stdout: capById[id], stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run, now: () => clock });
  await be.createNewPane(0, null, {}); // %1
  await be.createNewPane(0, null, {}); // %2

  // 1回目(clock=100): 両方 '' → 内容ありに変化 → 両方 100
  let { terminals } = await be.getStates(0);
  assert.equal(terminals['%1'].lastOutputTime, 100);
  assert.equal(terminals['%2'].lastOutputTime, 100);

  // 2回目(clock=200): %1 だけ内容が変わる。%2 は据え置き。
  clock = 200;
  capById['%1'] = 'aaa-updated';
  ({ terminals } = await be.getStates(0));
  assert.equal(terminals['%1'].lastOutputTime, 200); // 動いた
  assert.equal(terminals['%2'].lastOutputTime, 100); // 止まったまま＝idle 判定が効く
});

test('getStates: list-panes 失敗時は throw し、追跡ペインを prune しない', async () => {
  let listOk = true;
  const run = (args) => {
    const key = args.join(' ');
    if (key.startsWith('split-window')) return { status: 0, stdout: '%3\n', stderr: '' };
    if (key.startsWith('list-panes')) {
      return listOk ? { status: 0, stdout: '%3\n', stderr: '' } : { status: 1, stdout: '', stderr: 'server exited' };
    }
    if (key.startsWith('capture-pane')) return { status: 0, stdout: 'body\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  await be.createNewPane(0, null, {});

  // list-panes 一時失敗 → throw（ポーリング側で再試行）
  listOk = false;
  await assert.rejects(() => be.getStates(0), /list-panes failed/);

  // 復旧後、ペインは prune されずに残っている
  listOk = true;
  const { terminals } = await be.getStates(0);
  assert.deepEqual(Object.keys(terminals), ['%3']);
});

test('setExternalWaiting: getStates に反映される往復ストア', async () => {
  const { run } = fakeRunner({ 'split-window': '%3\n', 'list-panes': '%3\n', 'capture-pane': 'x\n' });
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  await be.createNewPane(0, null, {});
  await be.setExternalWaiting(0, '%3', true);
  const { terminals } = await be.getStates(0);
  assert.equal(terminals['%3'].waiting, true);
});

test('checkHealth: has-session の status 0 で true', async () => {
  const run = (args) => args.includes('has-session') ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: '' };
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  assert.equal(await be.checkHealth(0), true);
});

test('setTerminalPrUrl / setPaneLock / postMenu は no-op で {ok:true}', async () => {
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run: () => ({ status: 0, stdout: '', stderr: '' }) });
  assert.deepEqual(await be.setTerminalPrUrl(0, '%3', 'http://x'), { ok: true });
  assert.deepEqual(await be.setPaneLock(0, '%3', { close: false }), { ok: true });
  assert.deepEqual(await be.postMenu(0, {}), { ok: true });
});

test('setTerminalTitle: pane タイトルを select-pane -T で設定、空なら呼ばない', async () => {
  const { run, calls } = fakeRunner();
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  await be.setTerminalTitle(0, '%3', 'issue #400');
  const sp = calls.find(a => a.includes('select-pane'));
  assert.deepEqual(sp, ['select-pane', '-t', '%3', '-T', 'issue #400']);

  calls.length = 0;
  await be.setTerminalTitle(0, '%3', '');
  assert.equal(calls.find(a => a.includes('select-pane')), undefined);
});

test('getStates: list-panes から消えた pane は panes から除去され、以後も正しく振る舞う', async () => {
  let listPanesOut = '%3\n';
  const run = (args) => {
    const key = args.join(' ');
    if (key.startsWith('split-window')) return { status: 0, stdout: '%3\n', stderr: '' };
    if (key.startsWith('list-panes')) return { status: 0, stdout: listPanesOut, stderr: '' };
    if (key.startsWith('capture-pane')) return { status: 0, stdout: 'line1\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  await be.createNewPane(0, null, {});

  // 1回目: pane は存在する → 報告される
  let { terminals } = await be.getStates(0);
  assert.deepEqual(Object.keys(terminals), ['%3']);

  // 2回目: list-panes から消えた（成功応答で不在）→ 報告されず、内部 panes からも除去
  listPanesOut = '';
  ({ terminals } = await be.getStates(0));
  assert.deepEqual(Object.keys(terminals), []);

  // 3回目: 同じ pane id が再度現れても、panes からは既に除去済みのため無視される
  listPanesOut = '%3\n';
  ({ terminals } = await be.getStates(0));
  assert.deepEqual(Object.keys(terminals), []);
});
