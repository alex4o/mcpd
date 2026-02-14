import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BackendClient } from "./sse-client.ts";

export const SEPARATOR = "__";

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

  async listAllTools(): Promise<NamespacedTool[]> {
    const results: NamespacedTool[] = [];

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
          name: `${name}${SEPARATOR}${tool.name}`,
          description: tool.description
            ? `[${name}] ${tool.description}`
            : `[${name}]`,
          _service: name,
          _originalName: tool.name,
        });
      }
    }

    return results;
  }

  parseNamespacedName(namespacedName: string): {
    service: string;
    tool: string;
  } {
    const idx = namespacedName.indexOf(SEPARATOR);
    if (idx === -1) {
      throw new Error(
        `Invalid namespaced tool name: ${namespacedName} (missing '${SEPARATOR}')`
      );
    }
    return {
      service: namespacedName.slice(0, idx),
      tool: namespacedName.slice(idx + SEPARATOR.length),
    };
  }

  async routeToolCall(
    namespacedName: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const { service, tool } = this.parseNamespacedName(namespacedName);
    const client = this.backends.get(service);
    if (!client) {
      throw new Error(`Unknown service: ${service}`);
    }
    return client.callTool(tool, args);
  }
}
