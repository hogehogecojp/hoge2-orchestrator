/**
 * ensure-task-queue-label.mjs
 *
 * 作業対象リポジトリに取り込みラベル（既定 `task-queue`）が存在することを保証する。
 *
 * ※ この補助スクリプトは GitHub モード（queue.backend = github）専用です。
 *   ローカルモード（queue.backend = local）は GitHub の Issue ラベルを使わないため対象外です
 *   （親 #156 決定事項 7・MVP では未対応）。
 *
 * 背景:
 *   orchestrator は GitHub Search API で `label:<queueLabel>` を組織横断検索して
 *   作業対象リポジトリの Issue を見つける（github.js の searchSourceIssuesByLabel）。
 *   ラベルは GitHub の issue 画面から都度作れるが、各リポジトリに事前に作っておくと
 *   依頼者がラベル名のタイプミスや未作成で詰まらない。新規リポジトリ追加時に流すと便利。
 *
 * ラベル名・ラベル登録先 org / タスク登録リポジトリは
 * config.json（`github.queueLabel` / `owner` / `repo`）または環境変数
 * （`QUEUE_LABEL` / `GITHUB_OWNER` / `GITHUB_REPO`）で切り替えられる。
 * 優先順位は他のコードと同じく env > config.json > 既定値。
 *
 * 実行:
 *   node ensure-task-queue-label.mjs                # org 各リポに queueLabel を ensure
 *   node ensure-task-queue-label.mjs repo1 repo2    # 指定リポジトリのみ
 *   node ensure-task-queue-label.mjs --list         # 対象リポジトリ一覧を表示するだけ
 *   node ensure-task-queue-label.mjs --status       # タスク登録リポジトリに status:* / priority:* など運用ラベル一式を ensure
 *   node ensure-task-queue-label.mjs --status --list # 登録するラベル一覧を表示するだけ
 *
 * 認証:
 *   gh CLI（`gh auth login` 済み）を利用する。ラベル登録だけ別トークンで実行したい場合は
 *   SETUP_TOKEN 環境変数を渡す:
 *     SETUP_TOKEN=... node ensure-task-queue-label.mjs
 */

import { execFileSync } from 'child_process';
import { loadUnifiedConfig, applyConfigToEnv } from '../config.js';

// config.json の値を env へ流し込んでから読む（既存の env は上書きしない＝ env 優先）。
// これで orchestrator 本体と同じ設定（queueLabel / owner / repo）を共有できる。
applyConfigToEnv(loadUnifiedConfig());

const OWNER     = process.env.GITHUB_OWNER ?? 'vektor-inc';
const TASK_REPO = process.env.GITHUB_REPO  ?? 'task-queue';
const LABEL     = process.env.QUEUE_LABEL  ?? 'task-queue';

const SETUP_TOKEN = process.env.SETUP_TOKEN || null;

// GitHub の owner / repo 名で使える文字（英数字・ピリオド・ハイフン・アンダースコア）。
// execFile 経由で渡すためシェルインジェクションは原理上発生しないが、API パスに埋め込むので念のため検証する。
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
function assertSafeName(label, value) {
  if (!NAME_PATTERN.test(value)) {
    throw new Error(`不正な ${label} 名: "${value}"（英数字・. - _ のみ許可）`);
  }
}
assertSafeName('GITHUB_OWNER', OWNER);
assertSafeName('GITHUB_REPO', TASK_REPO);

// ラベル名は `status:ready` のようにコロン等を含み得るため NAME_PATTERN では縛らない。
// 空文字だけ弾き、API パスに埋め込む箇所（GET）では encodeURIComponent する。
if (!LABEL) {
  throw new Error('作業対象リポジトリの取り込みラベル名（QUEUE_LABEL / github.queueLabel）が空です。');
}

// タスク登録リポジトリ（OWNER/TASK_REPO）に登録する運用ラベル一式（--status モードで使用）。
// 色・説明は現行 task-queue リポの定義をそのまま写したもの。
// orchestrator が自動付与する status:* は未存在でも API 側で自動作成されるが、
// その場合ランダム色・説明なしになる。人が付ける status:ready / priority:* /
// sequential / parallel / automerge は事前に作っておかないと候補に出ず手動作成が要る。
// agent-review-passed は各 source リポの PR に付けられるレビュー完了マーカーのラベルのためここには含めない。
const QUEUE_REPO_LABELS = [
  { name: 'status:awaiting-approval', color: 'fbca04', description: '実行承認待ち（人の確認待ち。orchestrator は拾わない）' },
  { name: 'status:ready',            color: 'e4e669', description: '実行待ち（承認済み。orchestrator が拾う対象）' },
  { name: 'status:in-progress',      color: '0075ca', description: '実行中' },
  { name: 'status:waiting-input',    color: 'e99695', description: '指示待ち（ユーザーの返信を待っています）' },
  { name: 'status:waiting-merge',    color: '8a2be2', description: 'マージ待ち（PRがCI通過＆CodeRabbitのコメント待ち完了・非Draft。automerge時はレビュー完了マーカーも確認済み）' },
  { name: 'status:done',             color: '0e8a16', description: '完了' },
  { name: 'status:failed',           color: 'd93f0b', description: '失敗' },
  { name: 'priority:high',           color: 'b60205', description: '優先度：高' },
  { name: 'priority:medium',         color: 'fbca04', description: '優先度：中' },
  { name: 'priority:low',            color: 'd4c5f9', description: '優先度：低' },
  { name: 'sequential',              color: 'c5def5', description: '順番に実行（デフォルト）' },
  { name: 'parallel',                color: 'bfd4f2', description: '並列実行可能' },
  { name: 'automerge',               color: '6d1e95', description: 'マージ手順を事前承認（orchestrator が自動マージ）' },
];

// 作業対象リポジトリの取り込みラベル（queueLabel）1 種類の定義。org 各リポへ ensure する既定モードで使用。
const QUEUE_LABEL_DEF = { name: LABEL, color: '0075ca', description: `${LABEL} 作業対象リポジトリの取り込みラベル` };

if (!SETUP_TOKEN) {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
  } catch {
    console.error('gh CLI が認証されていません。`gh auth login` を実行するか、SETUP_TOKEN を指定してください。');
    process.exit(1);
  }
}

// gh CLI をシェル経由せず execFile で呼び出す（コマンドインジェクション対策）。
// 引数は配列で受け取り、テンプレートリテラル展開を一切しない。
function gh(argv) {
  const env = SETUP_TOKEN
    ? { ...process.env, GH_TOKEN: SETUP_TOKEN }
    : process.env;
  // maxBuffer 既定（1MB）だと org 全リポの --paginate 結果で ENOBUFS になるため拡張。
  return execFileSync('gh', argv, { encoding: 'utf8', stdio: 'pipe', env, maxBuffer: 64 * 1024 * 1024 });
}
function ghJSON(argv) {
  const out = gh(argv);
  try {
    return JSON.parse(out);
  } catch (err) {
    console.error(`gh ${argv.join(' ')} の出力を JSON としてパースできませんでした:\n${out}`);
    throw err;
  }
}

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const statusMode = args.includes('--status');
const targetRepos = args.filter(a => !a.startsWith('--'));

function fetchOrgRepos() {
  // --paginate を付けないと 1 ページ目（最大 per_page 件）しか取得できず、
  // リポジトリ数が per_page を超える org では残りが黙って漏れる。
  // gh は配列レスポンスを --paginate 時に単一の JSON 配列へマージして返す。
  const repos = ghJSON(['api', '--paginate', `/orgs/${OWNER}/repos?type=all&per_page=100`]);
  return repos.filter(r => !r.fork && r.name !== TASK_REPO);
}

// 単一ラベル定義（{name, color, description}）を 1 リポジトリに ensure する。
// 既存ならスキップ（色・説明は上書きしない＝手動調整を尊重）、404 なら定義どおり作成。冪等。
function ensureLabel(repo, def) {
  assertSafeName('repository', repo);
  try {
    ghJSON(['api', `/repos/${OWNER}/${repo}/labels/${encodeURIComponent(def.name)}`]);
    console.log(`    ✔ label '${def.name}' 既存`);
    return;
  } catch (err) {
    // 404（ラベル未存在）だけ「作成」分岐に入れ、それ以外（権限不足・ネットワーク等）は上位へ。
    const stderr = err.stderr?.toString() ?? '';
    if (!/HTTP 404/.test(stderr)) throw err;
  }
  const argv = [
    'api', '--method', 'POST',
    `/repos/${OWNER}/${repo}/labels`,
    '-f', `name=${def.name}`,
    '-f', `color=${def.color}`,
  ];
  if (def.description) argv.push('-f', `description=${def.description}`);
  gh(argv);
  console.log(`    ✅ label '${def.name}' 作成`);
}

// タスク登録リポジトリ（OWNER/TASK_REPO）に運用ラベル一式（QUEUE_REPO_LABELS）を ensure する。
function ensureQueueRepoLabels() {
  console.log(`=== タスク登録リポジトリ '${OWNER}/${TASK_REPO}' に運用ラベル一式を ensure ===\n`);

  if (listOnly) {
    console.log('登録するラベル一覧:');
    QUEUE_REPO_LABELS.forEach(d => console.log(`  - ${d.name} (#${d.color})`));
    return;
  }

  let ok = 0, ng = 0;
  for (const def of QUEUE_REPO_LABELS) {
    try {
      ensureLabel(TASK_REPO, def);
      ok++;
    } catch (err) {
      const msg = err.stderr?.toString().trim() || err.message;
      console.error(`    ❌ '${def.name}': ${msg}`);
      ng++;
    }
  }

  console.log(`\n完了: ${ok} 件成功、${ng} 件失敗`);
}

// org 各リポジトリに作業対象リポジトリの取り込みラベル（queueLabel）を ensure する（既定モード）。
function ensureQueueLabelOnOrgRepos() {
  console.log(`=== '${LABEL}' ラベル ensure (org: ${OWNER}) ===\n`);

  let repos;
  if (targetRepos.length > 0) {
    repos = targetRepos.map(name => ({ name }));
  } else {
    console.log('org のリポジトリを取得中...');
    repos = fetchOrgRepos();
    console.log(`  → ${repos.length} 件\n`);
  }

  if (listOnly) {
    console.log('対象リポジトリ一覧:');
    repos.forEach(r => console.log(`  - ${r.name}`));
    return;
  }

  let ok = 0, ng = 0;
  for (const r of repos) {
    console.log(`[${r.name}]`);
    try {
      ensureLabel(r.name, QUEUE_LABEL_DEF);
      ok++;
    } catch (err) {
      const msg = err.stderr?.toString().trim() || err.message;
      console.error(`    ❌ エラー: ${msg}`);
      ng++;
    }
  }

  console.log(`\n完了: ${ok} 件成功、${ng} 件失敗`);
}

function main() {
  if (statusMode) {
    ensureQueueRepoLabels();
  } else {
    ensureQueueLabelOnOrgRepos();
  }
}

main();
