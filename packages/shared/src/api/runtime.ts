// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: runtime. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import {
  RuntimeKindSchema,
} from '../db/schema.js';

// Ephemeral per-agent run state used by `agent_activity` realtime events and
// reconnect snapshots. These rows are not persisted to the messages DB.
export const AgentRunStatusSchema = z.enum([
  'starting',
  'thinking',
  'tool_running',
  'idle',
  'failed',
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentRunTerminalReasonSchema = z.enum([
  'replied',
  'turn_ended',
  'replaced',
  'stopped',
  'crashed',
  'timeout',
  'conversation_closed',
]);
export type AgentRunTerminalReason = z.infer<
  typeof AgentRunTerminalReasonSchema
>;

export const AgentActivitySnippetKindSchema = z.enum([
  'thinking',
  'text',
]);
export type AgentActivitySnippetKind = z.infer<
  typeof AgentActivitySnippetKindSchema
>;

export const AgentRunStateSchema = z.object({
  runId: z.string(),
  agentId: z.string(),
  conversationId: z.string(),
  status: AgentRunStatusSchema,
  startedAt: z.number(),
  updatedAt: z.number(),
  lastActivityAt: z.number(),
  terminalReason: AgentRunTerminalReasonSchema.optional(),
  activitySnippet: z.string().optional(),
  activitySnippetKind: AgentActivitySnippetKindSchema.optional(),
  toolCallCounts: z.record(z.string(), z.number()).optional(),
  compacting: z.boolean().optional(),
  compactingSince: z.number().optional(),
  compactionStale: z.boolean().optional(),
  detail: z.string().optional(),
});
export type AgentRunState = z.infer<typeof AgentRunStateSchema>;

export const AgentActivityEventSchema = AgentRunStateSchema;
export type AgentActivityEvent = AgentRunState;

export const AgentRunStatesDtoSchema = z.object({
  states: z.array(AgentRunStateSchema),
});
export type AgentRunStatesDto = z.infer<typeof AgentRunStatesDtoSchema>;

export const RuntimeAvailabilityStateSchema = z.enum([
  'present',
  'present_unverified',
  'absent',
  'unknown',
]);
export type RuntimeAvailabilityState = z.infer<
  typeof RuntimeAvailabilityStateSchema
>;

export const RuntimeDetectionReasonSchema = z.enum([
  'resolved',
  'version_unavailable',
  'not_found',
  'probe_failed',
]);
export type RuntimeDetectionReason = z.infer<
  typeof RuntimeDetectionReasonSchema
>;

export const RuntimeInfoSchema = z.object({
  kind: RuntimeKindSchema,
  state: RuntimeAvailabilityStateSchema,
  reason: RuntimeDetectionReasonSchema,
  installed: z.boolean(),
  binary: z.string().nullable(),
  version: z.string().nullable(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

export const RuntimeCatalogResponseSchema = z.object({
  runtimes: z.array(RuntimeInfoSchema),
  detected_at: z.number(),
});
export type RuntimeCatalogResponse = z.infer<
  typeof RuntimeCatalogResponseSchema
>;
