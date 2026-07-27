/**
 * check-status.mjs
 *
 * タスク登録リポジトリ（task-queue）のオープン Issue とその status/priority ラベルを一覧表示する。
 *
 * ※ この補助スクリプトは GitHub モード（queue.backend = github）専用です。
 *   ローカルモード（queue.backend = local）では GitHub 上に Issue が無いため対象がありません。
 *   ローカルキューの確認は `vk-orchestrator task list` を使ってください（親 #156 決定事項 7・MVP では未対応）。
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// orchestrator/ の一つ上（task-queue/）の .env を読む
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '..', '.env') });

import { GitHubClient } from '../github/index.js';
import { ensureGitHubToken } from '../config.js';

ensureGitHubToken();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER ?? 'vektor-inc';
const GITHUB_REPO  = process.env.GITHUB_REPO  ?? 'task-queue';

const github = new GitHubClient({ token: GITHUB_TOKEN, owner: GITHUB_OWNER, repo: GITHUB_REPO });

// 全オープンissue を取得
const { data: allIssues } = await github.octokit.issues.listForRepo({
  owner: GITHUB_OWNER, repo: GITHUB_REPO, state: 'open', per_page: 50,
});

console.log(`オープンissue: ${allIssues.length} 件\n`);
for (const issue of allIssues) {
  const labels = issue.labels.map(l => l.name).join(', ');
  console.log(`  #${issue.number} [${labels}] ${issue.title}`);
}

// in-progress なものがあれば詳細チェック
const inProgress = allIssues.filter(i => i.labels.some(l => l.name === 'status:in-progress'));
if (inProgress.length === 0) {
  console.log('\nin-progress なissueはありません。');

  // status:done / closed を直近10件確認
  const { data: closed } = await github.octokit.issues.listForRepo({
    owner: GITHUB_OWNER, repo: GITHUB_REPO, state: 'closed', per_page: 10, sort: 'updated', direction: 'desc',
  });
  console.log(`\n直近のclosed issue:`);
  for (const issue of closed) {
    const labels = issue.labels.map(l => l.name).join(', ');
    console.log(`  #${issue.number} [${labels}] ${issue.title}  (${issue.closed_at})`);
  }
  process.exit(0);
}

for (const issue of inProgress) {
  console.log(`\n=== issue #${issue.number}: ${issue.title} ===`);

  const fullText = [issue.title, issue.body].filter(Boolean).join('\n');
  const match = fullText.match(/https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/issues\/(\d+)/);

  if (!match) {
    console.log('  → 汎用タスク（PR監視なし）');
    continue;
  }

  const [, owner, repo, num] = match;
  const issueNumber = Number(num);
  console.log(`  → ターゲットissue: ${match[0]}`);

  // まずオープンPRを探す
  let pr = await github.findPRForIssue(owner, repo, issueNumber);

  // マージ済みPRも検索
  if (!pr) {
    try {
      const { data } = await github.octokit.search.issuesAndPullRequests({
        q: `repo:${owner}/${repo} is:pr is:merged ${issueNumber} in:body`,
        sort: 'created', order: 'desc', per_page: 5,
      });
      const merged = data.items.filter(i => i.pull_request);
      if (merged.length > 0) {
        console.log(`  → マージ済みPR発見: ${merged[0].html_url}`);
        pr = merged[0];
      }
    } catch (e) {
      console.warn(`  マージ済みPR検索エラー: ${e.message}`);
    }
  }

  if (!pr) {
    console.log('  → PRが見つかりません（open/merged どちらも）');
    continue;
  }
  console.log(`  → PR: ${pr.html_url}`);

  // PRがopenの場合のみ完了条件チェック
  if (pr.pull_request?.merged_at || pr.state === 'closed') {
    console.log('  → PR はマージ/クローズ済み');
  } else {
    const result = await github.checkPRCompletion(owner, repo, pr.number);
    console.log(`  → CodeRabbit idle OK: ${result.coderabbitOk}`);
    console.log(`  → CI 全通過: ${result.ciPassing}`);
    console.log(`  → 完了条件: ${result.ready ? '✅ 満たしている' : '❌ まだ'}`);
  }
}
