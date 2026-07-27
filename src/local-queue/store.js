import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { writeJsonAtomic } from '../config.js';

export const LOCAL_QUEUE_VERSION = 1;

export function resolveLocalQueuePath(options = {}) {
  return options.queuePath ?? join(options.homeDir ?? homedir(), '.task-queue', 'queue.json');
}

export function createEmptyQueue(now = new Date()) {
  const updatedAt = now instanceof Date ? now.toISOString() : String(now);
  return {
    version: LOCAL_QUEUE_VERSION,
    updatedAt,
    nextId: 1,
    tasks: [],
  };
}

function normalizeQueue(parsed, now = new Date()) {
  const fallback = createEmptyQueue(now);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;

  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const tasks = rawTasks.filter(
    task => task && typeof task === 'object' && !Array.isArray(task) && Number.isInteger(task.id) && task.id > 0,
  );
  const droppedTasks = rawTasks.length - tasks.length;
  if (droppedTasks > 0) {
    console.warn(`[LocalQueue] queue.json の不正な tasks 要素を ${droppedTasks} 件除外しました`);
  }
  const maxId = tasks.reduce((max, task) => {
    return Math.max(max, task.id);
  }, 0);

  return {
    version: parsed.version === LOCAL_QUEUE_VERSION ? parsed.version : LOCAL_QUEUE_VERSION,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : fallback.updatedAt,
    nextId: Number.isInteger(parsed.nextId) && parsed.nextId > maxId ? parsed.nextId : maxId + 1,
    tasks,
  };
}

export function readLocalQueue(queuePath = resolveLocalQueuePath(), options = {}) {
  if (!existsSync(queuePath)) return createEmptyQueue(options.now);

  const text = readFileSync(queuePath, 'utf8');
  if (text.trim() === '') return createEmptyQueue(options.now);

  try {
    return normalizeQueue(JSON.parse(text), options.now);
  } catch (err) {
    throw new Error(`[LocalQueue] queue.json の読み込みに失敗しました (${queuePath}): ${err.message}`, { cause: err });
  }
}

export function writeLocalQueue(queuePath, queue, options = {}) {
  const now = options.now ?? new Date();
  const updatedAt = now instanceof Date ? now.toISOString() : String(now);
  writeJsonAtomic(queuePath, {
    ...queue,
    version: LOCAL_QUEUE_VERSION,
    updatedAt,
  });
}
