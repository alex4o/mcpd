import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export class BackendClient {
  private client: Client;
  private transport: SSEClientTransport | null = null;

  constructor(name: string) {
    this.client = new Client({ name: `mcpd-${name}`, version: "1.0.0" });
  }

  async connect(url: string): Promise<void> {
    this.transport = new SSEClientTransport(new URL(url));
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<Tool[]> {
    const result = await this.client.listTools();
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ content: any[]; isError?: boolean }> {
    const result = await this.client.callTool({ name, arguments: args });
    if ("content" in result) {
      return {
        content: result.content as any[],
        isError: result.isError as boolean | undefined,
      };
    }
    // Legacy toolResult format — wrap in text content
    return {
      content: [
        {
          type: "text" as const,
          text:
            typeof result.toolResult === "string"
              ? result.toolResult
              : JSON.stringify(result.toolResult),
        },
      ],
    };
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }
}
