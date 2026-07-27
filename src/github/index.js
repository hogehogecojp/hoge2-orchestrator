import { Octokit } from '@octokit/rest';
import { DEFAULT_LABELS, getLabelsConfig } from '../config.js';

// エージェントレビュー完了マーカーのラベル名 / SHA コメント接頭辞。
// automerge を使うタスクコマンドがレビュー完了時に付ける公開規約として固定し、
// マーカー名自体は config 化しない（config.js の DEFAULT_LABELS からは撤去済み）。
const REVIEW_PASSED_LABEL = 'agent-review-passed';
const REVIEW_PASSED_SHA_PREFIX = 'agent-review-passed-sha:';

// エージェントレビュー完了マーカー判定で使う、呼び出し引数に依存しない固定値。
// hasReviewGateMarker が毎回組み立て直さないようモジュールスコープへホイストする。
// SHA コメントの投稿者として信頼する author_association（write 権限相当）。
const TRUSTED_ASSOC = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
// 「<REVIEW_PASSED_SHA_PREFIX> <sha>」を拾う正規表現。接頭辞は正規表現メタ文字（`:` 等）を
// 含む可能性があるため escape してから組み立てる。短縮 SHA（7 桁以上）も許容する。
const REVIEW_SHA_RE = new RegExp(
  `${REVIEW_PASSED_SHA_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*([0-9a-f]{7,40})`,
  'i'
);

// source 側 issue 本文から最初の GitHub issue URL を抽出する。
// 取り込み時 createTaskQueueIssueFromSource が body 先頭に source URL を入れているため、
// 最初にマッチしたものが source とみなせる（後から追記される PR URL は /pull/ なのでマッチしない）。
const SOURCE_ISSUE_URL_RE = /https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/issues\/(\d+)/;
const REPOSITORY_URL_RE = /repos\/([^/]+)\/([^/]+)$/;

// 本文中の GitHub issue URL を全て列挙するパターン。owner/repo/number は抽出せず、
// URL 文字列単位で厳密一致比較するために使う（`.../issues/12` が `.../issues/127` に
// 接頭辞一致する誤検知を防ぐ）。`.match()` 専用なら /g でも lastIndex を持ち越さないため、
// 単一インスタンスを各所で共有して安全（`.test()` / `.exec()` には流用しないこと）。
const ISSUE_URL_PATTERN = /https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/issues\/\d+/g;

function extractSourceIssueRef(body) {
  if (!body) return null;
  const m = body.match(SOURCE_ISSUE_URL_RE);
  if (!m) return null;
  return { url: m[0], owner: m[1], repo: m[2], number: Number(m[3]) };
}

// PR 本文が「対象 issue を実際に解決対象として参照しているか」を厳密に判定する。
// 単なる言及（コメント経由の偶発 cross-reference や、本文に番号が出てくるだけ）と
// 本物の対応 PR を区別するためのもので、timeline cross-referenced 候補と
// Search API 候補の両方の絞り込みに共用する。
//
// 採用する参照は次のいずれか:
//   1. 本文に対象 issue の URL を厳密一致で含む（`.../issues/12` が `.../issues/127` に
//      接頭辞一致する誤検知は ISSUE_URL_PATTERN の URL 単位比較で回避）
//   2. クローズキーワード（close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved）+ `#N`
//      （`#132` が `#1320` に前方一致しないよう末尾の数字境界を厳密化）
// どちらも無ければ「対応 PR ではない」とみなす。
// 背景: vk-agents#132 を本文/コメントで言及しただけの無関係な merged PR #134 が、
//       timeline cross-referenced 経由で task-queue#169 の対応 PR と誤認された事故への対策。
function prBodyReferencesIssue(body, owner, repo, issueNumber) {
  if (!body) return false;
  const targetUrl = `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
  const urls = body.match(ISSUE_URL_PATTERN) ?? [];
  if (urls.includes(targetUrl)) return true;
  const closingRe = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b[\\s:]+#${issueNumber}(?!\\d)`,
    'i'
  );
  return closingRe.test(body);
}

export class GitHubClient {
  constructor({ token, owner, repo, assignee = null, queueLabel = 'task-queue' }) {
    this.octokit = new Octokit({ auth: token });
    this.owner = owner;
    this.repo = repo;
    // 作業対象リポジトリの取り込みラベル名。汎用化のため注入可能（既定は従来の 'task-queue'）。
    // 作業対象リポジトリからの claim / restore で使う。
    this.queueLabel = queueLabel || 'task-queue';
    // 自分の担当分だけを処理するための assignee フィルタ（GitHub ログイン名）。
    // null / 空文字 / 空白のみは安全側として issue を一切拾わない。
    // 全件を対象にする場合は "all" を明示する。ログイン名を設定すると fetch* 系の
    // issue 取得に assignee 条件が加わり、複数メンバーが同じタスク登録リポジトリを衝突なく共用できる。
    const normalizedAssignee = typeof assignee === 'string' ? assignee.trim() : assignee;
    if (!normalizedAssignee) {
      this.pickupEnabled = false;
      this.assignee = null;
    } else if (typeof normalizedAssignee === 'string' && normalizedAssignee.toLowerCase() === 'all') {
      this.pickupEnabled = true;
      this.assignee = null;
    } else {
      this.pickupEnabled = true;
      this.assignee = normalizedAssignee;
    }
    // capability 宣言（#138 方針5 / #157）: GitHubClient はトークン前提で構築されるため
    // 常に GitHub 連携を有効と宣言する。エンジンはこのフラグを見て GitHub 依存処理の
    // 早期 return を判断する。
    this.capabilities = { githubIntegration: true };
  }

  // listForRepo に渡す assignee フィルタ条件（フィルタなしなら空オブジェクト）。
  // 各 fetch* メソッドの検索条件にスプレッドして使う。
  assigneeQuery() {
    return this.assignee ? { assignee: this.assignee } : {};
  }

  // キュー（タスク登録リポジトリ）上の全 open issue を一覧取得する。
  // tasks-view.json スナップショット生成用のインターフェースメソッド。
  // 一覧はメンバー横断で全タスクを表示するため assignee フィルタは掛けない。
  // octokit.paginate があれば全ページ取得、無ければ（テストの簡易 octokit モック等）
  // 単発 listForRepo にフォールバックする。
  // 後続の LocalQueueClient も同じシグネチャ（引数なし・open issue 配列を返す）で実装する。
  async listAllQueueIssues() {
    const params = {
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    };

    if (typeof this.octokit?.paginate === 'function') {
      return this.octokit.paginate(this.octokit.issues.listForRepo, params);
    }

    const { data } = await this.octokit.issues.listForRepo(params);
    return data;
  }

  // 途中で止まったissue（in-progress / waiting-input）を取得
  // status:waiting-merge はターミナルを使わずGitHub APIだけで再開できるため対象外
  async fetchStuckIssues() {
    if (!this.pickupEnabled) return [];

    const stuckLabels = ['status:in-progress', 'status:waiting-input'];
    const results = await Promise.all(
      stuckLabels.map(label =>
        this.octokit.issues.listForRepo({
          owner: this.owner,
          repo:  this.repo,
          state: 'open',
          labels: label,
          per_page: 100,
          ...this.assigneeQuery(),
        }).then(r => r.data)
      )
    );
    // 重複除去（両ラベルが付いているケースなど）
    const seen = new Set();
    return results.flat().filter(issue => {
      if (seen.has(issue.number)) return false;
      seen.add(issue.number);
      return true;
    });
  }

  // status:waiting-merge のissueを取得（マージ検知ポーリング用）
  async fetchWaitingMergeIssues() {
    if (!this.pickupEnabled) return [];

    const { data } = await this.octokit.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      labels: 'status:waiting-merge',
      per_page: 100,
      ...this.assigneeQuery(),
    });
    return data;
  }

  // status:in-progress のopen issueを取得（人手マージの事後検知用）
  async fetchInProgressIssues() {
    if (!this.pickupEnabled) return [];

    const { data } = await this.octokit.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      labels: 'status:in-progress',
      per_page: 100,
      ...this.assigneeQuery(),
    });
    return data;
  }

  // status:waiting-input のopen issueを取得
  // （waiting-input 中も PR が立っていれば本文への PR URL 追記と apiPrUrl 反映だけは行うため）
  // 注意: ここで返した issue のステータスを変更したり close したりはしない。
  // 「人の確認待ち」の意図は崩さず、PR 紐付けの追記だけを担当する補完ループ用。
  async fetchWaitingInputIssues() {
    if (!this.pickupEnabled) return [];

    const { data } = await this.octokit.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      labels: 'status:waiting-input',
      per_page: 100,
      ...this.assigneeQuery(),
    });
    return data;
  }

  // status:failed のopen issueを取得（事後復旧チェック用）
  async fetchFailedIssues() {
    if (!this.pickupEnabled) return [];

    const { data } = await this.octokit.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      labels: 'status:failed',
      per_page: 100,
      ...this.assigneeQuery(),
    });
    return data;
  }

  // status:ready のissueを優先度順に取得（承認済みの実行待ち）
  async fetchPendingIssues() {
    if (!this.pickupEnabled) return [];

    const { data } = await this.octokit.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      labels: 'status:ready',
      sort: 'created',
      direction: 'asc',
      per_page: 100,
      ...this.assigneeQuery(),
    });

    // 優先度でソート: high → medium → low → なし
    const priorityOrder = { 'priority:high': 0, 'priority:medium': 1, 'priority:low': 2 };
    return data.sort((a, b) => {
      const pa = a.labels.find(l => l.name.startsWith('priority:'))?.name ?? '';
      const pb = b.labels.find(l => l.name.startsWith('priority:'))?.name ?? '';
      return (priorityOrder[pa] ?? 3) - (priorityOrder[pb] ?? 3);
    });
  }

  // sequential ラベルが付いているかを判定する。
  // sequential 付き = 同じ作業対象リポジトリのタスクが in-flight なら起動を待機する。
  // ラベル無し = 待機チェックをせず、空きペインがあれば即起動する。
  isSequential(issue) {
    return issue.labels.map(l => l.name).includes('sequential');
  }

  // issueのラベルを更新（status を付け替える）
  //
  // 副作用: status:done / status:failed への「遷移」を検知した場合、作業対象リポジトリ側 issue
  // （タスク登録リポジトリ側 issue 本文 1 行目に記録された外部リポジトリの issue URL）に
  // 完了/失敗通知コメントを投稿する。同じ status を再設定するだけのケース（restart
  // 復旧で同状態に上書きされた、recheck ループで再評価された等）では遷移ではないので
  // コメントは投稿しない。コメント投稿失敗時はラベル更新の成功を損なわないよう warn のみ。
  async setStatus(issueNumber, newStatus) {
    const { data: issue } = await this.octokit.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });

    const currentLabels = issue.labels.map(l => l.name);
    const otherLabels = currentLabels.filter(name => !name.startsWith('status:'));
    const isTransition = !currentLabels.includes(newStatus);

    await this.octokit.issues.setLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      labels: [...otherLabels, newStatus],
    });

    console.log(`  [GitHub] issue #${issueNumber} → ${newStatus}`);

    if (isTransition && (newStatus === 'status:done' || newStatus === 'status:failed')) {
      const sourceRef = extractSourceIssueRef(issue.body);
      if (sourceRef) {
        const queueIssueUrl = `https://github.com/${this.owner}/${this.repo}/issues/${issueNumber}`;
        try {
          await this.postSourceCompletionComment(sourceRef, queueIssueUrl, newStatus);
        } catch (err) {
          console.warn(`  [GitHub] source 完了コメント投稿失敗 (${sourceRef.url}): ${err.message}`);
        }
      }
    }
  }

  // issue の優先度ラベルを更新する。
  // status / sequential など priority:* 以外のラベルは維持し、priority ファミリーだけを差し替える。
  // newPriority は high / medium / low / none を受け付け、none は priority:* を外すだけにする。
  async setPriority(issueNumber, newPriority) {
    const labelsConfig = getLabelsConfig();
    const priorityLabels = labelsConfig.priority ?? {};
    const nextLabel = newPriority === 'none' ? null : priorityLabels[newPriority];
    if (newPriority !== 'none' && !nextLabel) {
      throw new Error(`不明な優先度です: ${newPriority}`);
    }

    const { data: issue } = await this.octokit.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });

    const currentLabels = issue.labels.map(l => l.name);
    const otherLabels = currentLabels.filter(name => !name.startsWith('priority:'));
    const labels = nextLabel ? [...otherLabels, nextLabel] : otherLabels;

    await this.octokit.issues.setLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      labels,
    });

    console.log(`  [GitHub] issue #${issueNumber} priority → ${newPriority}`);
  }

  // issue の直列実行ラベルを更新する。
  // sequential 以外のラベルは維持し、parallel の場合も parallel ラベルは付けない。
  async setSequential(issueNumber, mode) {
    const labelsConfig = getLabelsConfig();
    const sequentialLabel = labelsConfig.sequential ?? 'sequential';
    if (mode !== 'sequential' && mode !== 'parallel') {
      throw new Error(`不明な実行方式です: ${mode}`);
    }

    const { data: issue } = await this.octokit.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });

    const currentLabels = issue.labels.map(l => l.name);
    const otherLabels = currentLabels.filter(name => name !== sequentialLabel);
    const labels = mode === 'sequential' ? [...otherLabels, sequentialLabel] : otherLabels;

    await this.octokit.issues.setLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      labels,
    });

    console.log(`  [GitHub] issue #${issueNumber} execution → ${mode}`);
  }

  // issue の自動マージラベルを更新する。
  // automerge 以外のラベルは維持し、manual の場合は automerge ラベルを外すだけにする。
  async setAutomerge(issueNumber, mode) {
    const labelsConfig = getLabelsConfig();
    const automergeLabel = labelsConfig.automerge ?? DEFAULT_LABELS.automerge;
    if (mode !== 'automerge' && mode !== 'manual') {
      throw new Error(`不明な自動マージ指定です: ${mode}`);
    }

    const { data: issue } = await this.octokit.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });

    const currentLabels = issue.labels.map(l => l.name);
    const otherLabels = currentLabels.filter(name => name !== automergeLabel);
    const labels = mode === 'automerge' ? [...otherLabels, automergeLabel] : otherLabels;

    await this.octokit.issues.setLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      labels,
    });

    console.log(`  [GitHub] issue #${issueNumber} automerge → ${mode}`);
  }

  // 作業対象リポジトリの Issue の repository_url（"https://api.github.com/repos/{owner}/{repo}" 形式）から
  // owner / repo を取り出す。取り込み系メソッド共通のヘルパー。
  parseSourceRepo(sourceIssue) {
    const m = sourceIssue.repository_url.match(REPOSITORY_URL_RE);
    if (!m) {
      throw new Error(`作業対象リポジトリの Issue の repository_url を解釈できません: ${sourceIssue.repository_url}`);
    }
    const [, owner, repo] = m;
    return { owner, repo };
  }

  // GitHub ネイティブ sub-issue の直下 issue 状態を全ページ取得する。
  // repository_url から owner/repo を読むことで、親と別リポジトリの sub-issue も判定できる。
  async listSubIssueStates(owner, repo, issueNumber) {
    const subIssues = await this.octokit.paginate(
      this.octokit.issues.listSubIssues,
      { owner, repo, issue_number: issueNumber, per_page: 100 }
    );

    return subIssues.map(subIssue => {
      const m = subIssue.repository_url.match(REPOSITORY_URL_RE);
      if (!m) {
        throw new Error(`sub-issue の repository_url を解釈できません: ${subIssue.repository_url}`);
      }
      const [, subOwner, subRepo] = m;
      return {
        owner: subOwner,
        repo: subRepo,
        number: subIssue.number,
        state: subIssue.state,
      };
    });
  }

  // 作業対象リポジトリ側 issue に「オーケストレーターが取り込みました」通知コメントを投稿する。
  // 取り込みループから直接呼ばれる。失敗時のリカバリは呼び出し側で warn ログのみ。
  async postSourceImportComment(sourceIssue, queueIssueUrl) {
    const { owner, repo } = this.parseSourceRepo(sourceIssue);
    const body = [
      `🤖 オーケストレーターが取り込みました → ${queueIssueUrl}`,
      '',
      'このタスクは自動オーケストレーター経由で対応されます。進行状況は上記メタ issue を参照してください。',
    ].join('\n');
    await this.octokit.issues.createComment({
      owner,
      repo,
      issue_number: sourceIssue.number,
      body,
    });
  }

  // source 側 issue に完了/失敗の通知コメントを投稿する。
  // setStatus 経由で done / failed への遷移時にのみ呼ばれる。
  async postSourceCompletionComment(sourceRef, queueIssueUrl, newStatus) {
    const body = newStatus === 'status:done'
      ? `✅ オーケストレーターが完了しました → ${queueIssueUrl}`
      : [
          `⚠️ オーケストレーターが失敗ステータスになりました → ${queueIssueUrl}`,
          '',
          '詳細はメタ issue を確認してください。',
        ].join('\n');
    await this.octokit.issues.createComment({
      owner: sourceRef.owner,
      repo: sourceRef.repo,
      issue_number: sourceRef.number,
      body,
    });
  }

  // issueにコメントを追加
  async addComment(issueNumber, body) {
    await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });
  }

  // issueをcloseする
  async closeIssue(issueNumber) {
    await this.octokit.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      state: 'closed',
    });
  }

  // 作業対象リポジトリ側 issue を明示 owner/repo/number で close する。
  async closeSourceIssue({ owner, repo, number }) {
    await this.octokit.issues.update({
      owner,
      repo,
      issue_number: number,
      state: 'closed',
    });
    console.log(`  [GitHub] source issue ${owner}/${repo}#${number} → closed`);
  }

  // issue本文の末尾にPR URLを追記する（既に含まれている場合はスキップ）
  //
  // 一時的なAPIエラーに耐えるため、指数バックオフ（1s, 3s, 9s）で最大3回リトライする。
  // 追記漏れが起きると後続のマージ検知ループ（checkWaitingMergeIssues）や
  // 起動時リカバリーの判定材料が欠けるため、ここの成功率は重要。
  // 4xx（429除く）は即時 throw（リトライしても結果が変わらない）。
  async appendPRUrlToIssue(issueNumber, prUrl) {
    const delays = [1000, 3000, 9000];
    let lastErr;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const { data: issue } = await this.octokit.issues.get({
          owner: this.owner,
          repo:  this.repo,
          issue_number: issueNumber,
        });

        if (issue.body?.includes(prUrl)) {
          console.log(`  [GitHub] issue #${issueNumber} 本文にPR URLは既に記載済みです`);
          return;
        }

        const newBody = (issue.body?.trimEnd() ?? '') + `\n\n---\n\n**PR:** ${prUrl}`;
        await this.octokit.issues.update({
          owner: this.owner,
          repo:  this.repo,
          issue_number: issueNumber,
          body: newBody,
        });

        console.log(`  [GitHub] issue #${issueNumber} 本文にPR URLを追記: ${prUrl}`);
        return;
      } catch (err) {
        lastErr = err;
        // 4xx（429 を除く）は即時 throw（権限・存在しないリソース等はリトライ無意味）
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
          throw err;
        }
        if (attempt < delays.length) {
          const wait = delays[attempt];
          console.warn(`  [GitHub] PR URL追記失敗 (${attempt + 1}/${delays.length + 1}): ${err.message} → ${wait}ms 後にリトライ`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    }
    throw lastErr;
  }

  // PR 本文末尾に「タスク登録リポジトリ側 issue 由来である」back-reference を追記する。
  //
  // タスク登録リポジトリ側 issue → PR の紐づけは appendPRUrlToIssue が担っているが、逆方向（PR → タスク登録リポジトリ側 issue）の
  // 紐づけは Claude が PR 本文で言及する保証がなく、特に「タスク登録リポジトリに直接登録された汎用 issue」では
  // PR 本文に何の情報も載らないままになるケースがある。orchestrator が検知時に back-reference を入れることで、
  // PR 単体を見てもタスク登録リポジトリ側のどの issue から出たかが追えるようにする。
  //
  // 既に同じ URL が PR 本文に含まれていればスキップ（idempotent）。
  // appendPRUrlToIssue と同じく指数バックオフ（1s, 3s, 9s）で最大3回リトライする。
  // 4xx（429 除く）は即時 throw。
  async appendQueueIssueRefToPR(prRef, queueIssueUrl) {
    const { owner, repo, number } = prRef;
    const delays = [1000, 3000, 9000];
    let lastErr;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const { data: pr } = await this.octokit.pulls.get({
          owner,
          repo,
          pull_number: number,
        });

        // includes() だと URL の接頭辞一致で誤検知する（例: `.../issues/12` が `.../issues/123` を
        // 含む別 issue にヒットする）。本文から issue URL を抽出し、厳密一致で比較する。
        const issueUrls = (pr.body ?? '').match(ISSUE_URL_PATTERN) ?? [];
        if (issueUrls.includes(queueIssueUrl)) {
          console.log(`  [GitHub] PR ${owner}/${repo}#${number} 本文にタスク登録リポジトリ側 issue URL は既に記載済みです`);
          return;
        }

        const newBody = (pr.body?.trimEnd() ?? '') + `\n\n---\n\n**Task-queue:** ${queueIssueUrl}`;
        await this.octokit.pulls.update({
          owner,
          repo,
          pull_number: number,
          body: newBody,
        });

        console.log(`  [GitHub] PR ${owner}/${repo}#${number} 本文にタスク登録リポジトリ側 issue URL を追記: ${queueIssueUrl}`);
        return;
      } catch (err) {
        lastErr = err;
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
          throw err;
        }
        if (attempt < delays.length) {
          const wait = delays[attempt];
          console.warn(`  [GitHub] PR 本文への task-queue URL 追記失敗 (${attempt + 1}/${delays.length + 1}): ${err.message} → ${wait}ms 後にリトライ`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    }
    throw lastErr;
  }

  /**
   * issue / PR のコメントを作成日時の昇順で全件取得する（汎用）。
   *
   * 新方針（案B）のスキャナが、対象 issue/PR の decision-record コメント
   * （waiting-input / 返信）を読むのに使う。100 件を超える issue でも取り逃さない
   * よう octokit のページネーションで全ページを集約する。
   *
   * @param {string} owner
   * @param {string} repo
   * @param {number} issueNumber  issue または PR の番号
   * @param {object} [opts]
   * @param {string} [opts.since]  この時刻以降のコメントに絞る（ISO8601）
   * @returns {Promise<Array<{id:number, body:string, created_at:string, user:object}>>}
   */
  async listIssueComments(owner, repo, issueNumber, { since } = {}) {
    return this.octokit.paginate(this.octokit.issues.listComments, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
      ...(since ? { since } : {}),
    });
  }

  // -------------------------------------------------------
  // PR完了判定（CodeRabbitAI + CI）
  // -------------------------------------------------------

  // 対象issueに紐づくPRを検索する（state は問わない）
  // vk-kore が "Closes #N" / "Fixes #N" を本文に含むPRを作成するのを前提としている。
  //
  // GitHub Search API はインデックス遅延が 30 分以上発生することがあり、
  // 「PR は実在するのに検索ヒットしない」状態が起きうる（issue #22 / #26 参照）。
  // そのため第一手として timeline events API（cross-referenced イベント）を使い、
  // issue を参照している PR を直接特定する。
  // timeline でヒットしなかった場合のみ、従来の Search API ベースのフォールバックに回す。
  async findPRForIssue(owner, repo, issueNumber) {
    // --- 第一手: timeline events ---
    try {
      const events = await this.octokit.paginate(
        this.octokit.issues.listEventsForTimeline,
        { owner, repo, issue_number: issueNumber, per_page: 100 }
      );

      const candidatePrNumbers = new Set();
      for (const ev of events) {
        if (ev.event !== 'cross-referenced') continue;
        const src = ev.source;
        // source.issue.pull_request が存在するものだけが PR からの参照
        if (src?.type === 'issue' && src.issue?.pull_request) {
          // 別リポジトリからの参照も理論上ありえるが、検出対象は同一 owner/repo のみ
          const refRepoUrl = src.issue.repository_url ?? '';
          const expected = `/repos/${owner}/${repo}`;
          if (refRepoUrl && !refRepoUrl.endsWith(expected)) continue;
          candidatePrNumbers.add(src.issue.number);
        }
      }

      if (candidatePrNumbers.size > 0) {
        // 各 PR の最新状態を取得（OPEN 優先 / なければ updated が最新のもの）
        const prs = [];
        for (const prNumber of candidatePrNumbers) {
          try {
            const { data: pr } = await this.octokit.pulls.get({
              owner, repo, pull_number: prNumber,
            });
            prs.push(pr);
          } catch (err) {
            console.warn(`  [GitHub] PR #${prNumber} 取得エラー: ${err.message}`);
          }
        }
        // cross-referenced は「issue を言及しただけ」の PR も拾う（PR のコメントでの
        // 言及や、本文に番号が出てくるだけのもの）。本文で対象 issue を実際に解決対象として
        // 参照している PR だけに絞り、偶発的な相互参照で無関係 PR を対応 PR と誤認しない
        // ようにする（task-queue#169 が vk-agents#132 経由で無関係な #134 に誤紐付けされた事故）。
        const referencing = prs.filter(
          pr => prBodyReferencesIssue(pr.body, owner, repo, issueNumber)
        );
        if (referencing.length > 0) {
          const open = referencing.find(p => p.state === 'open');
          if (open) return open;
          // OPEN が無ければ updated_at が最新のものを返す
          referencing.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
          return referencing[0];
        }
        // 参照を持つ候補が無ければ timeline では確定させず、Search API フォールバックに回す
      }
    } catch (err) {
      console.warn(`  [GitHub] timeline 経由のPR検出エラー: ${err.message}（Search API にフォールバック）`);
    }

    // --- フォールバック: Search API ---
    try {
      const { data } = await this.octokit.search.issuesAndPullRequests({
        q: `repo:${owner}/${repo} is:pr ${issueNumber} in:body`,
        sort: 'updated',
        order: 'desc',
        per_page: 20,
      });
      // GitHub の全文検索は `${issueNumber}` を裸の数値トークンとして緩くマッチさせ、
      // 本文に "127" を含むだけの無関係 PR まで拾ってしまう（task-queue#127 の誤 close 事故）。
      // 対象 issue を実際に解決対象として参照する PR（issue URL の厳密一致、または
      // クローズキーワード + #N）だけに絞る。`.../issues/12` が `.../issues/127` に
      // 接頭辞一致するのも防ぐ。該当が無ければ推測で誤マッチさせず null を返す。
      const prs = data.items.filter(
        item => item.pull_request && prBodyReferencesIssue(item.body, owner, repo, issueNumber)
      );
      if (prs.length === 0) return null;
      // OPEN を最優先（活きているPRがあればそれを追う）
      const open = prs.find(p => p.state === 'open');
      if (open) return open;
      // OPEN が無ければ最新のものを返す（merged 判定は呼び出し側で getPRState）
      return prs[0];
    } catch (err) {
      console.warn(`  [GitHub] PR検索エラー: ${err.message}`);
      return null;
    }
  }

  // issue を close した PR を timeline から特定する
  // 「PR 未検出だが対象 issue は close 済み」となったケースで、close した PR を
  // 救済的に拾うために使う。timeline の `closed` イベントには commit_id が含まれており、
  // その commit を含む PR を listPullRequestsAssociatedWithCommit で逆引きできる。
  async findPRThatClosedIssue(owner, repo, issueNumber) {
    try {
      const events = await this.octokit.paginate(
        this.octokit.issues.listEventsForTimeline,
        { owner, repo, issue_number: issueNumber, per_page: 100 }
      );

      // 最後の closed イベントを採用（再 open → close を考慮）
      const closedEvents = events.filter(ev => ev.event === 'closed');
      if (closedEvents.length === 0) return null;
      const lastClosed = closedEvents[closedEvents.length - 1];

      // 1. commit_id 経由（"Closes #N" でマージされた場合に付く）
      if (lastClosed.commit_id) {
        try {
          const { data: prs } = await this.octokit.repos.listPullRequestsAssociatedWithCommit({
            owner, repo, commit_sha: lastClosed.commit_id,
          });
          // マージ済み PR を最優先
          const merged = prs.find(p => p.merged_at);
          if (merged) return merged;
          if (prs.length > 0) return prs[0];
        } catch (err) {
          console.warn(`  [GitHub] commit→PR 逆引きエラー: ${err.message}`);
        }
      }

      // 2. closed の source が PR を指している場合（UI から手動 close など）
      const src = lastClosed.source;
      if (src?.type === 'issue' && src.issue?.pull_request) {
        // 別リポジトリからの参照を弾く（findPRForIssue の cross-referenced 判定と同等のガード）
        const refRepoUrl = src.issue.repository_url ?? '';
        const expected = `/repos/${owner}/${repo}`;
        if (refRepoUrl && !refRepoUrl.endsWith(expected)) {
          return null;
        }
        try {
          const { data: pr } = await this.octokit.pulls.get({
            owner, repo, pull_number: src.issue.number,
          });
          return pr;
        } catch (err) {
          console.warn(`  [GitHub] closed source PR 取得エラー: ${err.message}`);
        }
      }

      return null;
    } catch (err) {
      console.warn(`  [GitHub] closed PR 特定エラー: ${err.message}`);
      return null;
    }
  }

  // issue の現在の state を取得する（PR検出失敗時のフォールバック検証用）
  // 既定では指数バックオフ（1s, 3s, 9s）で最大3回リトライし、全て失敗した場合のみ throw する。
  // 瞬間的なネットワーク/API ブリップで即失敗するのを避けるため。
  //
  // ただし 4xx クライアントエラー（404 Not Found / 403 Forbidden など）は
  // リトライしても結果が変わらないため即時 throw する。
  // 429 Too Many Requests のみ 4xx でもリトライ対象として残す（レート制限の回復を待つため）。
  //
  // 戻り値には state / closedAt に加え、title / htmlUrl / body / labels も含める。
  // ペインヘッダーに元の作業対象 issue のタイトル・リンクを表示する用途で使う
  // （既存呼び出し側は .state / .closedAt しか参照していないため後方互換）。
  //
  // retryDelays でリトライ間隔（ミリ秒の配列）を上書きできる。既定は [1000, 3000, 9000]。
  // 空配列 `[]` を渡すと単発試行（リトライなし）になる。ペインタイトル取得のような
  // 付随処理（失敗してもフォールバックできる）で、リトライがタスク起動をブロックしないよう使う。
  //
  // @param {object} [opts]
  // @param {number[]} [opts.retryDelays=[1000,3000,9000]]  リトライ間隔（空配列でリトライなし）
  // @returns {Promise<{state:string, closedAt:string|null, title:string, htmlUrl:string, body:string|null, labels:Array}>}
  async getIssueState(owner, repo, issueNumber, { retryDelays = [1000, 3000, 9000] } = {}) {
    const delays = retryDelays;
    let lastErr;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const { data } = await this.octokit.issues.get({
          owner, repo, issue_number: issueNumber,
        });
        return {
          state: data.state,
          closedAt: data.closed_at,
          title: data.title,
          htmlUrl: data.html_url,
          body: data.body,
          labels: data.labels ?? [],
        };
      } catch (err) {
        lastErr = err;
        // 4xx（429 を除く）は即時 throw。リトライしても無駄なため。
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
          throw err;
        }
        if (attempt < delays.length) {
          const wait = delays[attempt];
          console.warn(`  [GitHub] issue状態取得失敗 (${attempt + 1}/${delays.length + 1}): ${err.message} → ${wait}ms 後にリトライ`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    }
    throw lastErr;
  }

  // 対象リポジトリのデフォルトブランチに `.wp-env.json` があるかを返す。
  // タスク着手時に wp-env 連携（ポート割り当て・{wpPort} 展開・マージ後クリーンアップ）を
  // 自動 ON/OFF する判定に使う。WordPress 案件は `.wp-env.json` を持つため true、
  // 非 WordPress リポは 404 で false になる。404 以外のエラー（権限・ネットワーク等）は
  // 呼び出し側でフォールバック（安全側に倒す）できるよう throw する。
  async hasWpEnvConfig(owner, repo) {
    try {
      await this.octokit.repos.getContent({ owner, repo, path: '.wp-env.json' });
      return true;
    } catch (err) {
      if (err.status === 404) return false;
      throw err;
    }
  }

  // PR上のCodeRabbitAI（bot）の最新コメント時刻を返す（コメントなしはnull）
  async getLastCodeRabbitCommentTime(owner, repo, prNumber) {
    const botLogin = 'coderabbitai[bot]';
    const times = [];

    // 1. PRレビュー（Approve/Request Changes等）
    const { data: reviews } = await this.octokit.pulls.listReviews({
      owner, repo, pull_number: prNumber, per_page: 100,
    });
    for (const r of reviews) {
      if (r.user?.login === botLogin) {
        times.push(new Date(r.submitted_at).getTime());
      }
    }

    // 2. PRインラインレビューコメント
    const { data: reviewComments } = await this.octokit.pulls.listReviewComments({
      owner, repo, pull_number: prNumber, per_page: 100,
    });
    for (const c of reviewComments) {
      if (c.user?.login === botLogin) {
        times.push(new Date(c.created_at).getTime());
      }
    }

    // 3. issueコメント（PR本体のコメント欄）
    const { data: issueComments } = await this.octokit.issues.listComments({
      owner, repo, issue_number: prNumber, per_page: 100,
    });
    for (const c of issueComments) {
      if (c.user?.login === botLogin) {
        times.push(new Date(c.created_at).getTime());
      }
    }

    return times.length > 0 ? Math.max(...times) : null;
  }

  // 指定したコミットSHAに対する GitHub Actions のワークフロー実行が全て通過しているか確認する。
  // 呼び出し元（checkPRCompletion）で取得した head SHA をそのまま渡すことで、
  // CI判定と返却 headSha を同じコミットに固定する（並列 pulls.get でのレースを防ぐ）。
  //
  // 以前は check-runs API（checks.listForRef）を使っていたが、これは Checks 権限を要求し、
  // fine-grained PAT には Checks 権限が存在しない（GitHub 仕様）ため 403 になり、classic PAT
  // でしか動かなかった。fine-grained PAT でも読める Actions API（listWorkflowRunsForRepo +
  // head_sha）に置き換えることで、どちらのトークン種別でも CI 判定が動くようにしている。
  //
  // 縮退に関する注意: Actions API は「このリポジトリの GitHub Actions ワークフロー実行」のみを
  // 返す。check-runs API が拾っていた外部 App の Check Run（CircleCI 等）や旧 Commit Status は
  // 判定対象外になる。task-queue が処理する対象リポの CI は GitHub Actions 前提のため現状は
  // 過不足ないが、外部 CI を併用するリポを対象にする場合はこの判定だけでは不足する点に注意。
  async checkCIPassing(owner, repo, sha) {
    // head SHA に紐づくワークフロー実行を全ページ取得する。
    // per_page 単ページ取得だと、同一 SHA に多数の run があるとき取りこぼして
    // 「未完了/失敗を見逃して allPassed=true」になる誤通過が起こりうるため paginate で全件取る。
    const runs = await this.octokit.paginate(
      this.octokit.actions.listWorkflowRunsForRepo,
      { owner, repo, head_sha: sha, per_page: 100 }
    );
    if (runs.length === 0) return true; // CI未設定（対象ワークフローなし）は通過扱い

    // 同一 SHA に対し、同じワークフロー(workflow_id)の run が複数返ることがある
    // （push と pull_request の二重トリガー、concurrency キャンセル後の再実行など）。
    // 古い run の conclusion（failure/cancelled 等）が残ると「全 run 成功」を永久に
    // 満たせず automerge が進まなくなるため、workflow_id ごとに最新の run（run_number が
    // 最大のもの）だけを代表として残す。run_number は同一ワークフロー内で単調増加する。
    const latestByWorkflow = new Map();
    for (const r of runs) {
      const cur = latestByWorkflow.get(r.workflow_id);
      if (!cur || (r.run_number ?? 0) > (cur.run_number ?? 0)) {
        latestByWorkflow.set(r.workflow_id, r);
      }
    }
    const effectiveRuns = [...latestByWorkflow.values()];

    const allCompleted = effectiveRuns.every(r => r.status === 'completed');
    const allPassed = effectiveRuns.every(r =>
      r.status === 'completed' &&
      ['success', 'skipped', 'neutral'].includes(r.conclusion)
    );

    if (!allCompleted) {
      const pending = effectiveRuns.filter(r => r.status !== 'completed').map(r => r.name);
      console.log(`  [CI] 実行中: ${pending.join(', ')}`);
    } else if (!allPassed) {
      const failed = effectiveRuns.filter(r => !['success', 'skipped', 'neutral'].includes(r.conclusion));
      console.log(`  [CI] 失敗: ${failed.map(r => `${r.name}(${r.conclusion})`).join(', ')}`);
    }

    return allPassed;
  }

  // PRの完了条件を総合チェックする
  // - CodeRabbitAIの最新コメントから coderabbitIdleMs 経過
  // - CI全通過
  //
  // 戻り値の headSha は「この検証時点での PR head の SHA」。
  // automerge ルートで pulls.merge に渡すことで、検証後・マージ前に push されたコミットを
  // GitHub 側でブロックさせる（TOCTOU 対策）。
  async checkPRCompletion(owner, repo, prNumber, { coderabbitIdleMs = 30 * 60 * 1000 } = {}) {
    // PR を 1 回だけ取得し、その head.sha を CI 判定と返却 headSha の両方で使う。
    // 並列に2回 pulls.get すると検証中の push でズレが生じ、未検証コミットがそのまま
    // mergePR(sha) を通る可能性があるため、取得を一本化する。
    const { data: pr } = await this.octokit.pulls.get({ owner, repo, pull_number: prNumber });
    const headSha = pr.head.sha;

    const [lastCRTime, ciPassing] = await Promise.all([
      this.getLastCodeRabbitCommentTime(owner, repo, prNumber),
      this.checkCIPassing(owner, repo, headSha),
    ]);

    const now = Date.now();
    const waitMin = Math.floor(coderabbitIdleMs / 60000);
    // コメントなしの場合はPR作成時刻を起点にして経過時間を判定する
    let coderabbitOk;
    if (lastCRTime === null) {
      const prCreatedAt = new Date(pr.created_at).getTime();
      const elapsed = now - prCreatedAt;
      coderabbitOk = elapsed >= coderabbitIdleMs;
      console.log(`  [CodeRabbit] コメントなし。PR作成から ${Math.floor(elapsed / 60000)}分経過 (待機: ${waitMin}分)`);
    } else {
      const elapsed = now - lastCRTime;
      coderabbitOk = elapsed >= coderabbitIdleMs;
      console.log(`  [CodeRabbit] 最終コメントから ${Math.floor(elapsed / 60000)}分経過 (待機: ${waitMin}分)`);
    }

    console.log(`  [CI] ${ciPassing ? '✅ 全通過' : '⏳ 未通過'}`);
    return { coderabbitOk, ciPassing, ready: coderabbitOk && ciPassing, headSha };
  }

  // エージェントレビュー完了マーカーが現 head SHA に対して存在するか判定する。
  // automerge ルートでのみ使用。マーカー = 'agent-review-passed' ラベル + 「agent-review-passed-sha: <sha>」コメント（現 head と一致）。
  //
  // マーカーの意味は「automerge を使うタスクコマンドの最終レビュー通過」だが、
  // orchestrator は意味を解釈せず、ラベルと SHA 一致だけを見る。
  // SHA 照合は呼び出し側（checkPRCompletion）の headSha を渡して行い、検証後に push が割り込んだ場合は
  // SHA 不一致でマーカー無効＝自動マージ保留になる（TOCTOU 対策。mergePR(sha) と同じ思想）。
  // ラベルと SHA 一致コメントの両方が揃ったときだけ true を返す（安全側：マーカー無し → マージしない）。
  //
  // SHA コメントは投稿者の author_association が信頼境界内（OWNER/MEMBER/COLLABORATOR）の
  // ものだけを採用する。マーカーの第一のゲートは「'agent-review-passed' ラベル付与＝write 権限が必要」だが、
  // SHA コメント側も write 権限保持者に限定して二要素とも信頼境界に寄せる多層防御
  // （PR にコメントできる第三者によるマーカー偽装を防ぐ）。マーカーコメントは bot アプリではなく
  // エージェント実行者が member の gh トークンで投稿する運用のため、bot ログイン固定ではなく
  // author_association で判定する（vk-agents[bot] 固定だと現行運用に合わずゲートが壊れる）。
  async hasReviewGateMarker(owner, repo, prNumber, headSha) {
    // 1. REVIEW_PASSED_LABEL ラベルの有無を pulls.get の labels から判定する。
    const { data: pr } = await this.octokit.pulls.get({
      owner, repo, pull_number: prNumber,
    });
    const hasLabel = (pr.labels ?? []).some(
      l => (typeof l === 'string' ? l : l.name) === REVIEW_PASSED_LABEL
    );
    if (!hasLabel) return false;

    // 2. コメントを全件取得し、「<REVIEW_PASSED_SHA_PREFIX> <sha>」が現 head SHA と前方一致するものを探す。
    //    短縮 SHA（7 桁以上）も許容するため headSha.startsWith(sha) で判定する。
    //    TRUSTED_ASSOC / REVIEW_SHA_RE は呼び出し引数に依存しないためモジュールスコープに定義。
    const comments = await this.octokit.paginate(this.octokit.issues.listComments, {
      owner, repo, issue_number: prNumber, per_page: 100,
    });
    for (const c of comments) {
      // 信頼境界外（CONTRIBUTOR / NONE 等）の投稿者によるマーカーは無視する。
      if (!TRUSTED_ASSOC.has(c.author_association)) continue;
      const m = (c.body ?? '').match(REVIEW_SHA_RE);
      if (m && headSha.startsWith(m[1].toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------
  // マージ検知
  // -------------------------------------------------------

  // PR の URL を {owner, repo, number} に分解する
  parsePRUrl(url) {
    if (!url) return null;
    const m = url.match(/https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/pull\/(\d+)/);
    if (!m) return null;
    return { owner: m[1], repo: m[2], number: Number(m[3]) };
  }

  // issue 本文に追記された PR URL を抽出する（appendPRUrlToIssue と対応）
  // 複数の PR URL が追記されている場合は最新（末尾）のものを返す
  extractPRUrlFromIssueBody(body) {
    if (!body) return null;
    const matches = [
      ...body.matchAll(/\*\*PR:\*\*\s*(https:\/\/github\.com\/[^\s]+\/pull\/\d+)/g),
    ];
    return matches.length > 0 ? matches[matches.length - 1][1] : null;
  }

  // PR の state / merged を取得
  async getPRState(owner, repo, prNumber) {
    const { data: pr } = await this.octokit.pulls.get({
      owner, repo, pull_number: prNumber,
    });
    return {
      state: pr.state,         // 'open' | 'closed'
      merged: pr.merged === true,
      mergedAt: pr.merged_at,
      htmlUrl: pr.html_url,
      headRefName: pr.head?.ref ?? null,   // マージ後クリーンアップで削除するブランチ名
      draft: pr.draft === true,
      mergeable: pr.mergeable,             // true | false | null（GitHub計算中はnull）
      mergeableState: pr.mergeable_state,  // 'clean' | 'dirty' | 'blocked' | 'unstable' | 'behind' | 'unknown' | ...
    };
  }

  // PR を squash merge する。
  // GitHub の mergeable 判定はマージ直前に再評価されるため、API 側でブロックされた場合は throw する。
  //
  // sha を指定すると GitHub は「PR head がこの SHA と一致するときだけマージ」を保証する。
  // 検証（CI / CodeRabbit / mergeable 判定）と実マージの間に push されたケースで API が 409 を返し、
  // レビュー対象でないコミットがそのまま squash merge されるのを防ぐ。
  async mergePR(owner, repo, prNumber, { method = 'squash', sha } = {}) {
    const params = {
      owner,
      repo,
      pull_number: prNumber,
      merge_method: method,
    };
    if (sha) params.sha = sha;
    const { data } = await this.octokit.pulls.merge(params);
    console.log(`  [GitHub] PR ${owner}/${repo}#${prNumber} を ${method} merge しました (sha: ${data.sha})`);
    return data;
  }

  /**
   * 対象リポジトリのリモートブランチを削除する。
   *
   * 既に削除済み、または ref が存在しない場合はクリーンアップ済みとして成功扱いにする。
   * 422 は ref 不存在を示す場合のみ成功扱いにし、保護ブランチ拒否などの 422 は throw する。
   *
   * @param {string} owner
   * @param {string} repo
   * @param {string} branch
   * @returns {Promise<void>}
   */
  async deleteRemoteBranch(owner, repo, branch) {
    try {
      await this.octokit.git.deleteRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      console.log(`  [GitHub] remote branch ${owner}/${repo}:${branch} を削除しました`);
    } catch (err) {
      if (err.status === 404) return;
      // 422 は ref 不存在時のみ削除済み扱いにする（保護ブランチ拒否などは呼び出し側へ渡す）。
      if (err.status === 422 && /does not exist|not exist|not found|No commit found/i.test(err.message ?? '')) return;
      throw err;
    }
  }

  // issue オブジェクトから automerge ラベルが付いているかを判定する。
  hasAutomergeLabel(issue) {
    const labelsConfig = getLabelsConfig();
    const automergeLabel = labelsConfig.automerge ?? DEFAULT_LABELS.automerge;
    return (issue.labels ?? []).some(l => (typeof l === 'string' ? l : l.name) === automergeLabel);
  }

  // -------------------------------------------------------
  // 作業対象リポジトリからのタスク取り込み（polling 方式）
  // -------------------------------------------------------

  // 指定 organization 内で `task-queue` ラベルが付いた open issue を組織横断で検索する。
  // タスク登録リポジトリ自身は対象から除外（自分自身の status:* 系が誤検出されないため）。
  // GitHub Search API はインデックス遅延（通常数秒〜数分、稀に30分程度）があるが、
  // 取り込みはリアルタイム性より確実性が大事なので許容する。
  async searchSourceIssuesByLabel(org, label) {
    if (!this.pickupEnabled) return [];

    // assignee が設定されている場合は「自分にアサインされた作業対象リポジトリの Issue だけ」を取り込む。
    // assignee が null で pickupEnabled が true の場合は "all" 明示による全件取り込み。
    // null / 空文字 / 空白のみは pickupEnabled=false として、ここに到達する前に何も拾わない。
    const assigneeQ = this.assignee ? ` assignee:${this.assignee}` : '';
    const q = `org:${org} label:${label} is:issue is:open -repo:${this.owner}/${this.repo}${assigneeQ}`;
    const items = await this.octokit.paginate(
      this.octokit.search.issuesAndPullRequests,
      { q, per_page: 100 }
    );
    // 念のため pull_request を除外（is:issue で弾けるはずだが多重防御）
    return items.filter(i => !i.pull_request);
  }

  // 指定された作業対象リポジトリの Issue URL がタスク登録リポジトリに既に取り込まれているか確認する。
  // open / closed 両方を見ることで、完了済みタスクへの再ラベル付けによる重複インポートを防ぐ。
  async findTaskQueueIssueBySourceUrl(sourceUrl) {
    const q = `repo:${this.owner}/${this.repo} is:issue "${sourceUrl}" in:body`;
    const { data } = await this.octokit.search.issuesAndPullRequests({
      q, per_page: 10,
    });
    // 本文内の issue URL を抽出して厳密一致で比較する（includes だと
    // `.../issues/12` が `.../issues/123` を含む別 issue にヒットしてしまうため）。
    return data.items.find(i => {
      const urls = (i.body ?? '').match(ISSUE_URL_PATTERN) ?? [];
      return urls.includes(sourceUrl);
    }) ?? null;
  }

  // 作業対象リポジトリの Issue をタスク登録リポジトリに新規 issue として取り込む。
  // ラベルは status:awaiting-approval のみ。sequential / priority は人が承認時に付与する。
  // assignee が設定されていれば、取り込んだユーザー（＝この orchestrator の担当者）を
  // 新規 issue にそのままアサインし、誰が取り込み・処理するかをタスク登録リポジトリ側でも示す。
  // push 権限の無い assignee は GitHub API 側で無視される（エラーにはならない）。
  async createTaskQueueIssueFromSource(sourceIssue) {
    // repository_url は "https://api.github.com/repos/{owner}/{repo}" 形式
    const repoName = sourceIssue.repository_url.split('/').pop();
    const { data } = await this.octokit.issues.create({
      owner: this.owner,
      repo:  this.repo,
      title: `[${repoName}] ${sourceIssue.title}`,
      body:  sourceIssue.html_url,
      labels: ['status:awaiting-approval'],
      ...(this.assignee ? { assignees: [this.assignee] } : {}),
    });
    return data;
  }

  // 作業対象リポジトリの Issue から `task-queue` ラベルを外し、取り込みの所有権を確保する。
  //
  // 複数端末（assignee フィルタ運用）が同時に取り込みを試みても、REST の removeLabel は
  // Search API と違って強整合なので、ラベルを実際に外せた1台だけが取り込みを行う。
  // 既にラベルが無い場合（＝他端末が先に確保済み）は 404 になるので false を返してスキップさせる。
  // これにより Search API のインデックス遅延（最大30分）に関係なく二重取り込みを防げる。
  //
  // 戻り値: true=自分が確保した（取り込みを続行してよい） / false=他端末が確保済み（スキップ）。
  // ラベル剥がしを create より「先」に行うため、create が失敗すると作業対象リポジトリの Issue が
  // どのラベルも無い orphan になる。呼び出し側は create 失敗時に
  // restoreSourceTaskQueueLabel でロールバックすること。
  async claimSourceIssueByLabelRemoval(sourceIssue) {
    const { owner, repo } = this.parseSourceRepo(sourceIssue);
    try {
      await this.octokit.issues.removeLabel({
        owner,
        repo,
        issue_number: sourceIssue.number,
        name: this.queueLabel,
      });
      return true;
    } catch (err) {
      // 404 = ラベルが既に付いていない（他端末が先に剥がした）。所有権は取れなかった。
      if (err.status === 404) return false;
      throw err;
    }
  }

  // 取り込みの所有権確保後に create が失敗した場合のロールバック。
  // 先に外した `task-queue` ラベルを再付与し、次ループでリトライ可能な状態に戻す
  // （作業対象リポジトリの Issue が orphan のまま放置されるのを防ぐ）。ラベル定義は repo 側に残っているので
  // addLabels で再付与できる（issue から外しただけでラベル自体は消えていない）。
  async restoreSourceTaskQueueLabel(sourceIssue) {
    const { owner, repo } = this.parseSourceRepo(sourceIssue);
    await this.octokit.issues.addLabels({
      owner,
      repo,
      issue_number: sourceIssue.number,
      labels: [this.queueLabel],
    });
  }

  // 作業対象リポジトリの Issue に作業中ラベル（既定: working。labels.workingInProgress で変更可）を付ける。
  // 取り込み時点（task-queue ラベルを外すタイミング）で呼び出すことで、
  // vk-kore の実行開始を待たずに作業対象リポジトリ側の一覧でも対応が始まったことを示す。
  // vk-kore が実行開始時に付けるラベルと同名・同色（付与済みでも addLabels は冪等）。
  // addLabels はラベル未作成の repo では自動作成するがランダム色になるため、
  // 先に vk-kore と同じ色（FBCA04）で作成を試みる。422（作成済み）は無視する。
  async addSourceWorkingLabel(sourceIssue) {
    const { owner, repo } = this.parseSourceRepo(sourceIssue);
    const workingLabel = getLabelsConfig().workingInProgress;
    try {
      await this.octokit.issues.createLabel({ owner, repo, name: workingLabel, color: 'FBCA04' });
    } catch (err) {
      if (err.status !== 422) throw err;
    }
    await this.octokit.issues.addLabels({
      owner,
      repo,
      issue_number: sourceIssue.number,
      labels: [workingLabel],
    });
  }
}
