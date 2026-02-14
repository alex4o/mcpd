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
  serviceMiddlewares: Map<string, McpMiddleware[]>
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
    const { service } = aggregator.parseName(name);
    const result = await aggregator.routeToolCall(name, args ?? {});
    const middlewares = serviceMiddlewares.get(service) ?? [];
    return applyMiddleware(middlewares, name, result);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
