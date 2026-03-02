/**
 * MCP → Mastra Tool Bridge — wraps our secure MCP tools as Mastra createTool() instances.
 * Our MCP security layer (command allowlist, SSRF protection, path traversal blocking)
 * remains unchanged — this bridge just adapts the interface.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { callTool } from '../mcp/pool.js';
import { log } from '../utils/logger.js';
import type { McpTool } from '../mcp/client.js';

const MAX_TOOL_RESULT_SIZE = 4096;

/** Bridge a single MCP tool to a Mastra-compatible createTool() instance */
export function mcpToMastraTool(tool: McpTool & { serverId: string }) {
  return createTool({
    id: tool.name,
    description: tool.description || tool.name,
    inputSchema: z.record(z.string(), z.any()),
    execute: async (params) => {
      const result = await callTool(tool.serverId, tool.name, params as Record<string, unknown>);
      const text = result.content?.map((c: { text?: string }) => c.text || '').join('\n') || 'Success';
      return text.length > MAX_TOOL_RESULT_SIZE
        ? text.slice(0, MAX_TOOL_RESULT_SIZE) + '\n[truncated]'
        : text;
    },
  });
}

/** Bridge all workspace MCP tools to Mastra format */
export function bridgeWorkspaceTools(mcpTools: Array<McpTool & { serverId: string }>) {
  const tools: Record<string, ReturnType<typeof mcpToMastraTool>> = {};
  for (const t of mcpTools) {
    try {
      tools[t.name] = mcpToMastraTool(t);
    } catch (err) {
      log.warn({ err, tool: t.name }, 'Failed to bridge MCP tool');
    }
  }
  return tools;
}
