import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BackendClient } from "./sse-client.ts";

export interface NamespacedTool extends Tool {
  _service: string;
  _originalName: string;
}

export class ToolAggregator {
  private backends = new Map<string, BackendClient>();

  addBackend(name: string, client: BackendClient): void {
    this.backends.set(name, client);
  }

  removeBackend(name: string): void {
    this.backends.delete(name);
  }

  private get needsPrefix(): boolean {
    return this.backends.size > 1;
  }

  async listAllTools(): Promise<NamespacedTool[]> {
    const results: NamespacedTool[] = [];
    const prefix = this.needsPrefix;

    const entries = [...this.backends.entries()];
    const toolLists = await Promise.all(
      entries.map(async ([name, client]) => {
        const tools = await client.listTools();
        return { name, tools };
      })
    );

    for (const { name, tools } of toolLists) {
      for (const tool of tools) {
        results.push({
          ...tool,
          name: prefix ? `${name}_${tool.name}` : tool.name,
          description: tool.description ?? "",
          _service: name,
          _originalName: tool.name,
        });
      }
    }

    return results;
  }

  parseName(toolName: string): { service: string; tool: string } {
    if (!this.needsPrefix) {
      // Single backend — tool name is unprefixed, route to the only backend
      const [serviceName] = this.backends.keys();
      if (!serviceName) throw new Error("No backends registered");
      return { service: serviceName, tool: toolName };
    }
    // Try each underscore position to find a matching service prefix.
    // This handles service names containing underscores (e.g., "my_db_run_query" → "my_db" + "run_query").
    let idx = 0;
    while (true) {
      idx = toolName.indexOf("_", idx);
      if (idx === -1) break;
      const prefix = toolName.slice(0, idx);
      if (this.backends.has(prefix)) {
        return { service: prefix, tool: toolName.slice(idx + 1) };
      }
      idx++;
    }
    throw new Error(`Invalid tool name: ${toolName} (no matching service prefix)`);
  }

  async routeToolCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const { service, tool } = this.parseName(toolName);
    const client = this.backends.get(service);
    if (!client) {
      throw new Error(`Unknown service: ${service}`);
    }
    return client.callTool(tool, args);
  }
}
