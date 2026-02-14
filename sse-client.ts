import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export class BackendClient {
  private client: Client;
  private transport: SSEClientTransport | StdioClientTransport | null = null;

  constructor(name: string) {
    this.client = new Client({ name: `mcpd-${name}`, version: "1.0.0" });
  }

  async connect(url: string): Promise<void> {
    this.transport = new SSEClientTransport(new URL(url));
    await this.client.connect(this.transport);
  }

  async connectStdio(
    command: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string> }
  ): Promise<void> {
    this.transport = new StdioClientTransport({
      command,
      args,
      cwd: opts?.cwd,
      env: opts?.env
        ? { ...process.env, ...opts.env } as Record<string, string>
        : undefined,
      stderr: "ignore",
    });
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<Tool[]> {
    const result = await this.client.listTools();
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const result = await this.client.callTool({ name, arguments: args });
    if ("content" in result) {
      return result as CallToolResult;
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
