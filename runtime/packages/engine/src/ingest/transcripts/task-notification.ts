// Task notification parsing (02 5.6): the user record that announces the end of a background task carries a small tagged
// block. Only three tags are read, only from the first 64 KiB, and only their first occurrence. `<result>`, `<summary>`,
// `<usage>` and `<output-file>` are never read: they hold task output (02 5.7).
import { TOOL_ID_RE } from '@mcs/shared/protocol';

export type TaskNotificationStatus = 'completed' | 'failed' | 'killed' | 'stopped';

export interface TaskNotification {
  taskId: string | null;
  toolUseId: string | null;
  /** Null for an event-only notification (no status tag, or one outside the four known values). */
  status: TaskNotificationStatus | null;
}

const READ_LIMIT = 64 * 1024;
const VALUE_RE = /^[^<]{1,200}$/;
const TASK_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function statusOf(value: string): TaskNotificationStatus | null {
  switch (value) {
    case 'completed':
    case 'failed':
    case 'killed':
    case 'stopped':
      return value;
    default:
      return null;
  }
}

/**
 * The trimmed value of the FIRST `<tag>...</tag>` in `text`. A first occurrence whose value is empty, longer than 200
 * characters or contains `<` gives null: a later occurrence is never used instead (02 5.6).
 */
function firstTagValue(text: string, tag: string): string | null {
  const open = `<${tag}>`;
  const start = text.indexOf(open);
  if (start < 0) return null;
  const valueStart = start + open.length;
  const end = text.indexOf(`</${tag}>`, valueStart);
  if (end < 0) return null;
  const value = text.slice(valueStart, end).trim();
  return VALUE_RE.test(value) ? value : null;
}

/** The text a notification is read from: a string content, or the first text block of a list content. */
function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const blocks: unknown[] = content;
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const type: unknown = 'type' in block ? block.type : undefined;
    const text: unknown = 'text' in block ? block.text : undefined;
    if (type === 'text' && typeof text === 'string') return text;
  }
  return null;
}

/** Reads the task id, the tool use id and the status of a task-notification user record's content. */
export function parseTaskNotification(content: unknown): TaskNotification {
  const result: TaskNotification = { taskId: null, toolUseId: null, status: null };
  const text = textOf(content);
  if (text === null) return result;
  const head = text.slice(0, READ_LIMIT);
  const taskId = firstTagValue(head, 'task-id');
  const toolUseId = firstTagValue(head, 'tool-use-id');
  const status = firstTagValue(head, 'status');
  if (taskId !== null && TASK_ID_RE.test(taskId)) result.taskId = taskId;
  if (toolUseId !== null && TOOL_ID_RE.test(toolUseId)) result.toolUseId = toolUseId;
  if (status !== null) result.status = statusOf(status);
  return result;
}
