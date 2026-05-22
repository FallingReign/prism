import { z, type ZodTypeAny } from "zod";

import type { AdapterToolDefinition } from "./types.js";

export type ToolMapping = AdapterToolDefinition & {
  httpMethod: "GET" | "POST";
  requiresSurface: boolean;
  inputSchema: ZodTypeAny;
  payload(input: Record<string, unknown>): Record<string, unknown>;
};

const surfaceSchema = z.enum(["public_channel", "private_channel", "dm", "mpim", "search", "files_metadata"]);
const executionModeSchema = z.enum(["user", "bot", "automatic"]);

export const toolMappings: ToolMapping[] = [
  {
    name: "slack_list_channels",
    description: "List Slack conversations through Prism.",
    method: "conversations.list",
    httpMethod: "GET",
    requiresSurface: true,
    inputSchema: z.object({
      surface: surfaceSchema,
      cursor: z.string().optional(),
      limit: z.number().int().positive().max(1000).optional(),
      workspaceId: z.string().optional()
    }),
    payload: (input) => ({ cursor: input.cursor, limit: input.limit })
  },
  {
    name: "slack_channel_history",
    description: "Read Slack conversation history through Prism.",
    method: "conversations.history",
    httpMethod: "GET",
    requiresSurface: true,
    inputSchema: z.object({
      channel: z.string(),
      surface: surfaceSchema,
      cursor: z.string().optional(),
      latest: z.string().optional(),
      limit: z.number().int().positive().max(1000).optional(),
      oldest: z.string().optional(),
      workspaceId: z.string().optional(),
      executionMode: executionModeSchema.optional()
    }),
    payload: (input) => ({ channel: input.channel, cursor: input.cursor, latest: input.latest, limit: input.limit, oldest: input.oldest })
  },
  {
    name: "slack_search_messages",
    description: "Search Slack messages through Prism.",
    method: "search.messages",
    httpMethod: "GET",
    requiresSurface: false,
    inputSchema: z.object({
      query: z.string(),
      count: z.number().int().positive().max(100).optional(),
      cursor: z.string().optional(),
      page: z.number().int().positive().optional(),
      sort: z.string().optional(),
      sortDir: z.string().optional(),
      workspaceId: z.string().optional(),
      executionMode: executionModeSchema.optional()
    }),
    payload: (input) => ({ query: input.query, count: input.count, cursor: input.cursor, page: input.page, sort: input.sort, sort_dir: input.sortDir })
  },
  {
    name: "slack_post_message",
    description: "Post a Slack message through Prism.",
    method: "chat.postMessage",
    httpMethod: "POST",
    requiresSurface: true,
    inputSchema: z.object({
      channel: z.string(),
      text: z.string(),
      surface: surfaceSchema,
      threadTs: z.string().optional(),
      workspaceId: z.string().optional(),
      executionMode: executionModeSchema.optional()
    }),
    payload: (input) => ({ channel: input.channel, text: input.text, thread_ts: input.threadTs })
  }
];
