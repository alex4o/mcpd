import { describe, expect, test } from "bun:test";
import { ToolAggregator, SEPARATOR } from "../aggregator.ts";
import type { BackendClient } from "../sse-client.ts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// Mock BackendClient for testing
function mockClient(tools: Tool[]): BackendClient {
  return {
    listTools: async () => tools,
    callTool: async (name: string, args: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text: `Called ${name} with ${JSON.stringify(args)}` }],
    }),
    connect: async () => {},
    disconnect: async () => {},
  } as any;
}

const toolA: Tool = {
  name: "find_symbol",
  description: "Find a symbol",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
};

const toolB: Tool = {
  name: "search",
  description: "Search code",
  inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
};

const toolC: Tool = {
  name: "run_query",
  description: "Run a database query",
  inputSchema: { type: "object", properties: { sql: { type: "string" } } },
};

describe("ToolAggregator", () => {
  test("namespaces tools correctly", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA, toolB]));

    const tools = await agg.listAllTools();
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe(`serena${SEPARATOR}find_symbol`);
    expect(tools[1]!.name).toBe(`serena${SEPARATOR}search`);
  });

  test("includes service name in description", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA]));

    const tools = await agg.listAllTools();
    expect(tools[0]!.description).toContain("[serena]");
  });

  test("merges tools from multiple backends", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA]));
    agg.addBackend("db", mockClient([toolC]));

    const tools = await agg.listAllTools();
    expect(tools).toHaveLength(2);

    const names = tools.map((t) => t.name);
    expect(names).toContain(`serena${SEPARATOR}find_symbol`);
    expect(names).toContain(`db${SEPARATOR}run_query`);
  });

  test("routes calls to correct backend", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA]));
    agg.addBackend("db", mockClient([toolC]));

    const result = await agg.routeToolCall(`serena${SEPARATOR}find_symbol`, {
      query: "test",
    });
    expect(result.content[0]).toHaveProperty(
      "text",
      'Called find_symbol with {"query":"test"}'
    );
  });

  test("routes to second backend correctly", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA]));
    agg.addBackend("db", mockClient([toolC]));

    const result = await agg.routeToolCall(`db${SEPARATOR}run_query`, {
      sql: "SELECT 1",
    });
    expect(result.content[0]).toHaveProperty(
      "text",
      'Called run_query with {"sql":"SELECT 1"}'
    );
  });

  test("throws on unknown service", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA]));

    await expect(
      agg.routeToolCall(`unknown${SEPARATOR}find_symbol`, {})
    ).rejects.toThrow("Unknown service");
  });

  test("throws on invalid namespaced name", () => {
    const agg = new ToolAggregator();
    expect(() => agg.parseNamespacedName("no_separator")).toThrow("missing");
  });

  test("parseNamespacedName correctly splits", () => {
    const agg = new ToolAggregator();
    const { service, tool } = agg.parseNamespacedName(
      `serena${SEPARATOR}find_symbol`
    );
    expect(service).toBe("serena");
    expect(tool).toBe("find_symbol");
  });

  test("preserves internal metadata on namespaced tools", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA]));

    const tools = await agg.listAllTools();
    expect(tools[0]!._service).toBe("serena");
    expect(tools[0]!._originalName).toBe("find_symbol");
  });

  test("removeBackend removes a backend", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA]));
    agg.addBackend("db", mockClient([toolC]));
    agg.removeBackend("db");

    const tools = await agg.listAllTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe(`serena${SEPARATOR}find_symbol`);
  });
});
