import { GitHubClient } from '../github/index.js';
import { DEFAULT_LABELS, getLabelsConfig } from '../config.js';
import { readLocalQueue, resolveLocalQueuePath, writeLocalQueue } from './store.js';

const SOURCE_ISSUE_URL_RE = /https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/issues\/(\d+)/;
const ISSUE_URL_PATTERN = /https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/issues\/\d+/g;
const PR_URL_RE = /\*\*PR:\*\*\s*(https:\/\/github\.com\/[^\s]+\/pull\/\d+)/g;
const GITHUB_PR_URL_RE = /https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/pull\/(\d+)/;

function labelName(label) {
  return typeof label === 'string' ? label : label?.name;
}

function statusLabelFor(status, labelsConfig = getLabelsConfig()) {
  const bare = String(status ?? '').trim().replace(/^status:/, '');
  if (!bare) return null;
  const configured = Object.values(labelsConfig.status ?? {}).find(
    label => typeof label === 'string' && label.replace(/^status:/, '') === bare,
  );
  return configured ?? `status:${bare}`;
}

function priorityLabelFor(priority, labelsConfig = getLabelsConfig()) {
  const bare = String(priority ?? '').trim().replace(/^priority:/, '');
  if (!bare || bare === 'none') return null;
  return (labelsConfig.priority ?? {})[bare] ?? `priority:${bare}`;
}

function labelsForTask(task, labelsConfig = getLabelsConfig()) {
  return [
    statusLabelFor(task.status, labelsConfig),
    priorityLabelFor(task.priority, labelsConfig),
    task.sequential ? labelsConfig.sequential ?? DEFAULT_LABELS.sequential : null,
    task.automerge ? labelsConfig.automerge ?? DEFAULT_LABELS.automerge : null,
  ].filter(Boolean);
}

function normalizePriority(priority) {
  const bare = String(priority ?? '').trim().replace(/^priority:/, '');
  return bare === '' ? 'none' : bare;
}

function extractSourceIssueRef(body) {
  if (!body) return null;
  const m = body.match(SOURCE_ISSUE_URL_RE);
  if (!m) return null;
  return { url: m[0], owner: m[1], repo: m[2], number: Number(m[3]) };
}

function sourceRepoName(sourceIssue) {
  if (typeof sourceIssue?.repository_url === 'string') {
    const repo = sourceIssue.repository_url.split('/').pop();
    if (repo) return repo;
  }
  const m = String(sourceIssue?.html_url ?? '').match(/https:\/\/github\.com\/[^/]+\/([^/]+)\/issues\/\d+/);
  return m?.[1] ?? 'source';
}

function compareCreatedAsc(a, b) {
  return new Date(a.createdAt ?? 0) - new Date(b.createdAt ?? 0);
}

export class LocalQueueClient {
  constructor({
    token,
    owner,
    repo,
    assignee = null,
    queueLabel = 'task-queue',
    queuePath,
    homeDir,
    githubClient = null,
  }) {
    this.queuePath = resolveLocalQueuePath({ queuePath, homeDir });
    // トークン無し × ローカルモードでは内部 GitHubClient を生成しない（#157）。
    // 生成しないことで、対象リポ操作（source import・PR 監視・automerge・対象 issue 操作）が
    // 万一エンジンのガードをすり抜けて委譲されても「静かに実行される」ことを構造的に防ぐ
    // （null 参照で即座に失敗し、握りつぶしでなく気付ける）。トークン有り or githubClient 注入時は従来どおり。
    const hasToken = typeof token === 'string' && token.trim() !== '';
    this.github = githubClient ?? (hasToken ? new GitHubClient({ token, owner, repo, assignee, queueLabel }) : null);
    this.owner = this.github?.owner ?? owner;
    this.repo = this.github?.repo ?? repo;
    this.queueLabel = this.github?.queueLabel ?? (queueLabel || 'task-queue');
    this._writeChain = Promise.resolve();
    // ローカルモードは単一ローカルワーカー前提のため、キュー側 fetch に assignee フィルタは適用しない。
    // 内包 GitHubClient の assignee は source-import 系の対象リポ操作で使うため保持する。
    this.assignee = null;
    this.pickupEnabled = true;
    // capability 宣言（#138 方針5 / #157）: GitHub API アクセス（＝内部 GitHubClient への委譲）が
    // 可能かどうかを宣言する。トークン無しローカルモードでは github=null となり githubIntegration:false。
    // エンジンはこのフラグを見て source import / PR 監視 / automerge / 対象 issue 操作 を早期 return でスキップする。
    this.capabilities = { githubIntegration: this.github !== null };
  }

  readQueue() {
    return readLocalQueue(this.queuePath);
  }

  writeQueue(queue, options = {}) {
    writeLocalQueue(this.queuePath, queue, options);
  }

  _runExclusive(fn) {
    const run = () => Promise.resolve().then(fn);
    const result = this._writeChain.then(run, run);
    this._writeChain = result.catch(() => {});
    return result;
  }

  taskToIssue(task) {
    return {
      number: task.id,
      state: task.state ?? 'open',
      title: task.title ?? '',
      body: task.body ?? '',
      labels: labelsForTask(task),
      assignees: Array.isArray(task.assignees) ? task.assignees : [],
      html_url: `local://queue/${task.id}`,
      updated_at: task.updatedAt ?? null,
      created_at: task.createdAt ?? null,
    };
  }

  openTasksByStatus(statuses) {
    const wanted = new Set(statuses);
    return this.readQueue().tasks.filter(
      task => (task.state ?? 'open') !== 'closed' && wanted.has(task.status),
    );
  }

  async listAllQueueIssues() {
    return this.readQueue()
      .tasks
      .filter(task => (task.state ?? 'open') !== 'closed')
      .sort((a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0))
      .map(task => this.taskToIssue(task));
  }

  async fetchStuckIssues() {
    const seen = new Set();
    return ['in-progress', 'waiting-input']
      .flatMap(status => this.openTasksByStatus([status]).sort(compareCreatedAsc))
      .filter(task => {
        if (seen.has(task.id)) return false;
        seen.add(task.id);
        return true;
      })
      .map(task => this.taskToIssue(task));
  }

  async fetchWaitingMergeIssues() {
    return this.openTasksByStatus(['waiting-merge']).sort(compareCreatedAsc).map(task => this.taskToIssue(task));
  }

  async fetchInProgressIssues() {
    return this.openTasksByStatus(['in-progress']).sort(compareCreatedAsc).map(task => this.taskToIssue(task));
  }

  async fetchWaitingInputIssues() {
    return this.openTasksByStatus(['waiting-input']).sort(compareCreatedAsc).map(task => this.taskToIssue(task));
  }

  async fetchFailedIssues() {
    return this.openTasksByStatus(['failed']).sort(compareCreatedAsc).map(task => this.taskToIssue(task));
  }

  async fetchPendingIssues() {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return this.openTasksByStatus(['ready'])
      .sort((a, b) => {
        const pa = priorityOrder[normalizePriority(a.priority)] ?? 3;
        const pb = priorityOrder[normalizePriority(b.priority)] ?? 3;
        return pa - pb || compareCreatedAsc(a, b);
      })
      .map(task => this.taskToIssue(task));
  }

  async mutateTask(issueNumber, mutator) {
    return this._runExclusive(async () => {
      const queue = this.readQueue();
      const id = Number(issueNumber);
      const task = queue.tasks.find(item => item.id === id);
      if (!task) throw new Error(`Local queue task #${issueNumber} が見つかりません`);
      const now = new Date().toISOString();
      await mutator(task, queue, now);
      task.updatedAt = now;
      this.writeQueue(queue, { now });
      return task;
    });
  }

  async setStatus(issueNumber, newStatus) {
    const nextStatus = String(newStatus ?? '').trim().replace(/^status:/, '');
    if (!nextStatus) throw new Error(`不明なステータスです: ${newStatus}`);

    let sourceRef = null;
    let queueIssueUrl = null;
    let shouldNotify = false;
    await this.mutateTask(issueNumber, (task) => {
      shouldNotify = task.status !== nextStatus && (nextStatus === 'done' || nextStatus === 'failed');
      sourceRef = shouldNotify ? extractSourceIssueRef(task.body) : null;
      task.status = nextStatus;
      queueIssueUrl = `local://queue/${task.id}`;
    });

    console.log(`  [LocalQueue] task #${issueNumber} → status:${nextStatus}`);

    // github=null（トークン無しローカルモード）では source 側への完了通知は行わない。
    // 純ローカルタスクは source URL を持たないため sourceRef は元々 null だが、
    // 万一 source URL を含むタスクがトークン無しで done/failed になっても静かにスキップする。
    if (shouldNotify && sourceRef && this.github) {
      try {
        await this.github.postSourceCompletionComment(sourceRef, queueIssueUrl, `status:${nextStatus}`);
      } catch (err) {
        console.warn(`  [LocalQueue] source 完了コメント投稿失敗 (${sourceRef.url}): ${err.message}`);
      }
    }
  }

  async setPriority(issueNumber, newPriority) {
    const labelsConfig = getLabelsConfig();
    const priorityLabels = labelsConfig.priority ?? {};
    const nextPriority = normalizePriority(newPriority);
    if (nextPriority !== 'none' && !priorityLabels[nextPriority]) {
      throw new Error(`不明な優先度です: ${newPriority}`);
    }

    await this.mutateTask(issueNumber, (task) => {
      task.priority = nextPriority === 'none' ? 'none' : nextPriority;
    });

    console.log(`  [LocalQueue] task #${issueNumber} priority → ${nextPriority}`);
  }

  async setSequential(issueNumber, mode) {
    if (mode !== 'sequential' && mode !== 'parallel') {
      throw new Error(`不明な実行方式です: ${mode}`);
    }

    await this.mutateTask(issueNumber, (task) => {
      task.sequential = mode === 'sequential';
    });

    console.log(`  [LocalQueue] task #${issueNumber} execution → ${mode}`);
  }

  async setAutomerge(issueNumber, mode) {
    if (mode !== 'automerge' && mode !== 'manual') {
      throw new Error(`不明な自動マージ指定です: ${mode}`);
    }

    await this.mutateTask(issueNumber, (task) => {
      task.automerge = mode === 'automerge';
    });

    console.log(`  [LocalQueue] task #${issueNumber} automerge → ${mode}`);
  }

  async addComment(issueNumber, body) {
    await this.mutateTask(issueNumber, (task, _queue, now) => {
      const comments = Array.isArray(task.comments) ? task.comments : [];
      const maxId = comments.reduce((max, comment) => Math.max(max, Number(comment?.id) || 0), 0);
      task.comments = [
        ...comments,
        { id: maxId + 1, author: 'agent', body: String(body ?? ''), createdAt: now },
      ];
    });
  }

  async closeIssue(issueNumber) {
    await this.mutateTask(issueNumber, (task) => {
      task.state = 'closed';
    });
  }

  async appendPRUrlToIssue(issueNumber, prUrl) {
    let appended = false;
    await this.mutateTask(issueNumber, (task) => {
      if ((task.body ?? '').includes(prUrl)) {
        task.prUrl = task.prUrl ?? prUrl;
        return;
      }
      task.body = `${(task.body ?? '').trimEnd()}\n\n---\n\n**PR:** ${prUrl}`;
      task.prUrl = prUrl;
      appended = true;
    });
    if (appended) {
      console.log(`  [LocalQueue] task #${issueNumber} 本文にPR URLを追記: ${prUrl}`);
    } else {
      console.log(`  [LocalQueue] task #${issueNumber} 本文にPR URLは既に記載済みです`);
    }
  }

  async createLocalTask({
    title,
    body = '',
    priority = 'none',
    sequential = false,
    status = 'ready',
    cwd = null,
  }) {
    return this._runExclusive(() => {
      const queue = this.readQueue();
      const now = new Date().toISOString();
      const id = queue.nextId;
      queue.nextId = id + 1;
      const task = {
        id,
        state: 'open',
        title: String(title ?? ''),
        body: String(body ?? ''),
        status: String(status ?? 'ready'),
        priority: String(priority ?? 'none'),
        sequential: sequential === true,
        automerge: false,
        cwd,
        prUrl: null,
        comments: [],
        createdAt: now,
        updatedAt: now,
      };
      queue.tasks.push(task);
      this.writeQueue(queue, { now });
      return this.taskToIssue(task);
    });
  }

  async createTaskQueueIssueFromSource(sourceIssue) {
    return this._runExclusive(() => {
      const queue = this.readQueue();
      const now = new Date().toISOString();
      const id = queue.nextId;
      queue.nextId = id + 1;
      const task = {
        id,
        state: 'open',
        title: `[${sourceRepoName(sourceIssue)}] ${sourceIssue.title ?? ''}`,
        body: sourceIssue.html_url ?? '',
        status: 'awaiting-approval',
        priority: 'none',
        sequential: false,
        automerge: false,
        cwd: null,
        prUrl: null,
        comments: [],
        createdAt: now,
        updatedAt: now,
      };
      queue.tasks.push(task);
      this.writeQueue(queue, { now });
      return this.taskToIssue(task);
    });
  }

  async findTaskQueueIssueBySourceUrl(sourceUrl) {
    const queue = this.readQueue();
    const task = queue.tasks.find((item) => {
      const urls = (item.body ?? '').match(ISSUE_URL_PATTERN) ?? [];
      return urls.includes(sourceUrl);
    });
    return task ? this.taskToIssue(task) : null;
  }

  extractPRUrlFromIssueBody(body) {
    if (!body) return null;
    const matches = [...body.matchAll(PR_URL_RE)];
    return matches.length > 0 ? matches.at(-1)[1] : null;
  }

  parsePRUrl(url) {
    if (!url) return null;
    const m = url.match(GITHUB_PR_URL_RE);
    if (!m) return null;
    return { owner: m[1], repo: m[2], number: Number(m[3]) };
  }

  hasAutomergeLabel(issue) {
    const automergeLabel = getLabelsConfig().automerge ?? DEFAULT_LABELS.automerge;
    return (issue.labels ?? []).some(label => labelName(label) === automergeLabel);
  }

  isSequential(issue) {
    const sequentialLabel = getLabelsConfig().sequential ?? DEFAULT_LABELS.sequential;
    return (issue.labels ?? []).some(label => labelName(label) === sequentialLabel);
  }

  findPRForIssue(...args) { return this.github.findPRForIssue(...args); }
  findPRThatClosedIssue(...args) { return this.github.findPRThatClosedIssue(...args); }
  getPRState(...args) { return this.github.getPRState(...args); }
  checkCIPassing(...args) { return this.github.checkCIPassing(...args); }
  checkPRCompletion(...args) { return this.github.checkPRCompletion(...args); }
  hasReviewGateMarker(...args) { return this.github.hasReviewGateMarker(...args); }
  getLastCodeRabbitCommentTime(...args) { return this.github.getLastCodeRabbitCommentTime(...args); }
  mergePR(...args) { return this.github.mergePR(...args); }
  deleteRemoteBranch(...args) { return this.github.deleteRemoteBranch(...args); }
  async getIssueState(owner, repo, issueNumber, opts) {
    if (owner !== this.owner || repo !== this.repo) {
      return this.github.getIssueState(owner, repo, issueNumber, opts);
    }

    const id = Number(issueNumber);
    const task = this.readQueue().tasks.find(item => item.id === id);
    if (!task) {
      const err = new Error(`Local queue task #${issueNumber} が見つかりません`);
      err.status = 404;
      throw err;
    }

    const state = task.state ?? 'open';
    return {
      state,
      closedAt: state === 'closed' ? task.updatedAt ?? null : null,
      title: task.title ?? '',
      htmlUrl: `local://queue/${task.id}`,
      body: task.body ?? '',
      labels: labelsForTask(task),
    };
  }
  hasWpEnvConfig(...args) { return this.github.hasWpEnvConfig(...args); }
  listSubIssueStates(...args) { return this.github.listSubIssueStates(...args); }
  closeSourceIssue(...args) { return this.github.closeSourceIssue(...args); }
  appendQueueIssueRefToPR(...args) { return this.github.appendQueueIssueRefToPR(...args); }
  listIssueComments(...args) { return this.github.listIssueComments(...args); }
  postSourceImportComment(...args) { return this.github.postSourceImportComment(...args); }
  postSourceCompletionComment(...args) { return this.github.postSourceCompletionComment(...args); }
  parseSourceRepo(...args) { return this.github.parseSourceRepo(...args); }
  claimSourceIssueByLabelRemoval(...args) { return this.github.claimSourceIssueByLabelRemoval(...args); }
  restoreSourceTaskQueueLabel(...args) { return this.github.restoreSourceTaskQueueLabel(...args); }
  addSourceWorkingLabel(...args) { return this.github.addSourceWorkingLabel(...args); }
  searchSourceIssuesByLabel(...args) { return this.github.searchSourceIssuesByLabel(...args); }
}
