import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolAggregator } from "./aggregator.ts";
import type { McpMiddleware } from "./middleware.ts";
import { applyMiddleware } from "./middleware.ts";

export async function createServer(
  aggregator: ToolAggregator,
  middlewares: McpMiddleware[]
): Promise<void> {
  const server = new Server(
    { name: "mcpd", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await aggregator.listAllTools();
    // Strip internal fields before sending to client
    return {
      tools: tools.map(({ _service, _originalName, ...tool }) => tool),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await aggregator.routeToolCall(name, args ?? {});
    const processed = applyMiddleware(middlewares, name, result as any);
    return processed as any;
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
