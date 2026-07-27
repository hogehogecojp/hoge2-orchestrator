import { getQueueBackend } from '../config.js';
import { formatErrorSummary } from '../engine/format-error.js';
import { LocalQueueClient } from './index.js';

const LOCAL_TASK_STATUSES = new Set([
  'ready',
  'awaiting-approval',
  'in-progress',
  'waiting-merge',
  'waiting-input',
  'done',
  'failed',
]);
const LOCAL_TASK_PRIORITIES = new Set(['high', 'medium', 'low']);

function localTaskUsage() {
  return `vk-orchestrator task <command>

commands:
  task add "<title>" [--body <text>] [--priority high|medium|low] [--sequential] [--cwd <path>] [--status <status>]
  task list [--status <status>] [--all] [--json]
  task set-status <id> <status>
`;
}

function parseTaskOptions(argv, spec = {}) {
  const options = {};
  const positionals = [];
  const valueOptions = new Set(spec.valueOptions ?? []);
  const booleanOptions = new Set(spec.booleanOptions ?? []);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const name = arg.slice(2, eqIndex === -1 ? undefined : eqIndex);
    if (booleanOptions.has(name)) {
      if (eqIndex !== -1) throw new Error(`--${name} は値を取りません`);
      options[name] = true;
      continue;
    }

    if (!valueOptions.has(name)) {
      throw new Error(`不明なオプションです: --${name}`);
    }

    if (eqIndex !== -1) {
      options[name] = arg.slice(eqIndex + 1);
      continue;
    }

    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`--${name} には値が必要です`);
    }
    options[name] = value;
    i += 1;
  }

  return { options, positionals };
}

function normalizeTaskStatus(status) {
  const value = String(status ?? '').trim().replace(/^status:/, '');
  if (!LOCAL_TASK_STATUSES.has(value)) {
    throw new Error(`不明なステータスです: ${status}（有効値: ${[...LOCAL_TASK_STATUSES].join(', ')}）`);
  }
  return value;
}

function normalizeTaskPriority(priority) {
  const value = String(priority ?? '').trim();
  if (value === '') return 'none';
  if (!LOCAL_TASK_PRIORITIES.has(value)) {
    throw new Error(`不明な優先度です: ${priority}（有効値: high, medium, low）`);
  }
  return value;
}

function ensureLocalTaskBackend() {
  const backend = getQueueBackend();
  if (backend !== 'local') {
    console.error(`これらのコマンドは queue.backend: local 専用です（現在: ${backend}）。`);
    process.exit(1);
  }
}

function createLocalTaskClient() {
  return new LocalQueueClient({
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER ?? 'vektor-inc',
    repo: process.env.GITHUB_REPO ?? 'task-queue',
    assignee: process.env.ASSIGNEE_FILTER ?? null,
    queueLabel: process.env.QUEUE_LABEL ?? 'task-queue',
  });
}

function printTaskTable(tasks) {
  if (tasks.length === 0) {
    console.log('該当するタスクはありません');
    return;
  }
  const rows = [
    ['id', 'status', 'priority', 'title'],
    ...tasks.map(task => [String(task.id), task.status || '-', task.priority || 'none', task.title || '']),
  ];
  const widths = rows[0].map((_, index) => Math.max(...rows.map(row => row[index].length)));
  for (const row of rows) {
    console.log(row.map((cell, index) => cell.padEnd(widths[index])).join('  '));
  }
}

export async function runLocalTaskCommand(argv) {
  ensureLocalTaskBackend();
  const [action, ...rest] = argv;
  const client = createLocalTaskClient();

  try {
    switch (action) {
      case 'add': {
        const { options, positionals } = parseTaskOptions(rest, {
          valueOptions: ['body', 'priority', 'cwd', 'status'],
          booleanOptions: ['sequential'],
        });
        if (positionals.length < 1) {
          console.error(localTaskUsage());
          process.exit(1);
        }
        if (positionals.length > 1) {
          throw new Error(`title 以外の位置引数は指定できません: ${positionals.slice(1).join(' ')}`);
        }
        const status = normalizeTaskStatus(options.status ?? 'ready');
        const priority = options.priority == null ? 'none' : normalizeTaskPriority(options.priority);
        const issue = await client.createLocalTask({
          title: positionals[0],
          body: options.body ?? '',
          priority,
          sequential: options.sequential === true,
          status,
          cwd: options.cwd ?? null,
        });
        console.log(`task #${issue.number} を登録しました（status:${status}）`);
        break;
      }
      case 'list': {
        const { options, positionals } = parseTaskOptions(rest, {
          valueOptions: ['status'],
          booleanOptions: ['all', 'json'],
        });
        if (positionals.length > 0) {
          throw new Error(`不明な引数です: ${positionals.join(' ')}`);
        }
        const status = options.status == null ? null : normalizeTaskStatus(options.status);
        const queue = client.readQueue();
        const tasks = queue.tasks
          .filter(task => options.all === true || (task.state ?? 'open') !== 'closed')
          .filter(task => status == null || task.status === status)
          .sort((a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0));
        if (options.json === true) {
          console.log(JSON.stringify(tasks, null, 2));
        } else {
          printTaskTable(tasks);
        }
        break;
      }
      case 'set-status': {
        const { options, positionals } = parseTaskOptions(rest);
        if (Object.keys(options).length > 0 || positionals.length !== 2) {
          console.error(localTaskUsage());
          process.exit(1);
        }
        const id = Number(positionals[0]);
        if (!Number.isInteger(id) || id <= 0) {
          throw new Error(`id は正の整数で指定してください: ${positionals[0]}`);
        }
        const status = normalizeTaskStatus(positionals[1]);
        await client.setStatus(id, status);
        break;
      }
      default:
        console.error(localTaskUsage());
        process.exit(1);
    }
  } catch (err) {
    console.error(formatErrorSummary(err));
    process.exit(1);
  }
}
