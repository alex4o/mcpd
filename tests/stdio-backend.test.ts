import { describe, expect, test, afterEach } from "bun:test";
import { BackendClient } from "../sse-client.ts";
import { ToolAggregator } from "../aggregator.ts";
import { join } from "path";

const TEST_MCP_SERVER = join(import.meta.dir, "fixtures", "test-mcp-server.ts");

describe("BackendClient.connectStdio", () => {
  let client: BackendClient;

  afterEach(async () => {
    try {
      await client?.disconnect();
    } catch {}
  });

  test("connects to a stdio MCP server and lists tools", async () => {
    client = new BackendClient("test-stdio");
    await client.connectStdio("bun", ["run", TEST_MCP_SERVER]);

    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("echo");
    expect(names).toContain("greet");
  });

  test("calls a tool via stdio transport", async () => {
    client = new BackendClient("test-stdio");
    await client.connectStdio("bun", ["run", TEST_MCP_SERVER]);

    const result = await client.callTool("echo", { message: "hello stdio" });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "hello stdio",
    });
  });

  test("calls greet tool via stdio transport", async () => {
    client = new BackendClient("test-stdio");
    await client.connectStdio("bun", ["run", TEST_MCP_SERVER]);

    const result = await client.callTool("greet", { name: "World" });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Hello, World!",
    });
  });
});

describe("ToolAggregator with stdio backends", () => {
  const clients: BackendClient[] = [];

  afterEach(async () => {
    for (const c of clients) {
      try { await c.disconnect(); } catch {}
    }
    clients.length = 0;
  });

  test("exposes stdio backend tools through aggregator (single)", async () => {
    const client = new BackendClient("backend");
    await client.connectStdio("bun", ["run", TEST_MCP_SERVER]);
    clients.push(client);

    const agg = new ToolAggregator();
    agg.addBackend("backend", client);

    const tools = await agg.listAllTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("echo");
    expect(names).toContain("greet");
  });

  test("routes tool calls to stdio backend through aggregator", async () => {
    const client = new BackendClient("backend");
    await client.connectStdio("bun", ["run", TEST_MCP_SERVER]);
    clients.push(client);

    const agg = new ToolAggregator();
    agg.addBackend("backend", client);

    const result = await agg.routeToolCall("echo", { message: "via aggregator" });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "via aggregator",
    });
  });

  test("prefixes tools when mixing multiple stdio backends", async () => {
    const client1 = new BackendClient("alpha");
    await client1.connectStdio("bun", ["run", TEST_MCP_SERVER]);
    clients.push(client1);

    const client2 = new BackendClient("beta");
    await client2.connectStdio("bun", ["run", TEST_MCP_SERVER]);
    clients.push(client2);

    const agg = new ToolAggregator();
    agg.addBackend("alpha", client1);
    agg.addBackend("beta", client2);

    const tools = await agg.listAllTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("alpha_echo");
    expect(names).toContain("alpha_greet");
    expect(names).toContain("beta_echo");
    expect(names).toContain("beta_greet");

    const result = await agg.routeToolCall("beta_greet", { name: "Test" });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Hello, Test!",
    });
  });
});
