import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BackendClient } from "./sse-client.ts";
import log from "./logger.ts";

export interface NamespacedTool extends Tool {
  _service: string;
  _originalName: string;
}

export class ToolAggregator {
  private backends = new Map<string, BackendClient>();
  private excludedTools = new Map<string, Set<string>>();

  addBackend(name: string, client: BackendClient, excludeTools?: string[]): void {
    this.backends.set(name, client);
    if (excludeTools?.length) {
      this.excludedTools.set(name, new Set(excludeTools));
    } else {
      this.excludedTools.delete(name);
    }
  }

  removeBackend(name: string): void {
    this.backends.delete(name);
    this.excludedTools.delete(name);
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
      const excluded = this.excludedTools.get(name);
      for (const tool of tools) {
        if (excluded?.has(tool.name)) continue;
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
    // Prefer the longest match so "a_b" wins over "a" for "a_b_tool".
    let bestIdx = -1;
    let idx = 0;
    while (true) {
      idx = toolName.indexOf("_", idx);
      if (idx === -1) break;
      const prefix = toolName.slice(0, idx);
      if (this.backends.has(prefix)) {
        bestIdx = idx;
      }
      idx++;
    }
    if (bestIdx !== -1) {
      return { service: toolName.slice(0, bestIdx), tool: toolName.slice(bestIdx + 1) };
    }
    log.error({ toolName }, "no matching service prefix for tool");
    throw new Error(`Invalid tool name: ${toolName} (no matching service prefix)`);
  }

  async routeToolCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const { service, tool } = this.parseName(toolName);
    const client = this.backends.get(service);
    if (!client) {
      log.error({ service, toolName }, "unknown service for tool call");
      throw new Error(`Unknown service: ${service}`);
    }
    return client.callTool(tool, args);
  }
}
