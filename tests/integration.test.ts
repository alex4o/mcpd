import { describe, expect, test, afterEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "path";

const TEST_MCP_SERVER = join(import.meta.dir, "fixtures", "test-mcp-server.ts");

describe("integration: stdio MCP client ↔ server", () => {
  let client: Client;
  let transport: StdioClientTransport;

  afterEach(async () => {
    try {
      await client?.close();
    } catch {}
  });

  test("connects and lists tools", async () => {
    transport = new StdioClientTransport({
      command: "bun",
      args: ["run", TEST_MCP_SERVER],
    });
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);

    const result = await client.listTools();
    expect(result.tools.length).toBeGreaterThanOrEqual(2);

    const names = result.tools.map((t) => t.name);
    expect(names).toContain("echo");
    expect(names).toContain("greet");
  });

  test("calls echo tool", async () => {
    transport = new StdioClientTransport({
      command: "bun",
      args: ["run", TEST_MCP_SERVER],
    });
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);

    const result = await client.callTool({
      name: "echo",
      arguments: { message: "hello world" },
    });
    expect("content" in result).toBe(true);
    if ("content" in result) {
      expect((result as any).content[0]).toMatchObject({
        type: "text",
        text: "hello world",
      });
    }
  });

  test("calls greet tool", async () => {
    transport = new StdioClientTransport({
      command: "bun",
      args: ["run", TEST_MCP_SERVER],
    });
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);

    const result = await client.callTool({
      name: "greet",
      arguments: { name: "Alice" },
    });
    expect("content" in result).toBe(true);
    if ("content" in result) {
      expect((result as any).content[0]).toMatchObject({
        type: "text",
        text: "Hello, Alice!",
      });
    }
  });
});
