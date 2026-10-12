// What the global setup hands to the spec: the URL of the running instance and the values the pages must show. The setup
// runs in the runner process and the spec in a worker, so the hand-over is one environment variable holding JSON that the
// spec validates at this boundary.
import { z } from 'zod';

export const SKELETON_ENV = 'MCS_E2E_SKELETON';

const Usage = z.object({
  input: z.number(),
  output: z.number(),
  cacheCreation: z.number(),
  cacheRead: z.number(),
  total: z.number(),
  turns: z.number(),
});

const ToolCall = z.object({
  toolUseId: z.string(),
  name: z.string(),
  resultText: z.string().nullable(),
  isError: z.boolean().nullable(),
  agentId: z.string(),
});

const Session = z.object({
  id: z.string(),
  label: z.string(),
  state: z.enum(['turn_ended', 'waiting_tool']),
  pendingTools: z.number(),
  inclSubagents: Usage,
  toolCalls: z.array(ToolCall),
});

const SkeletonEnv = z.object({
  baseUrl: z.string(),
  expected: z.object({ sessions: z.array(Session).length(2) }),
});

export type SkeletonEnvValue = z.infer<typeof SkeletonEnv>;
export type EnvSession = z.infer<typeof Session>;

/** Reads and validates the hand-over of the global setup; a missing or malformed value names itself in the error. */
export function readSkeletonEnv(): SkeletonEnvValue {
  const raw = process.env[SKELETON_ENV];
  if (raw === undefined || raw === '') {
    throw new Error(`${SKELETON_ENV} is not set: the global setup did not start the skeleton instance`);
  }
  return SkeletonEnv.parse(JSON.parse(raw));
}
