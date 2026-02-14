import { describe, expect, test } from "bun:test";
import { ToolAggregator } from "../aggregator.ts";
import type { BackendClient } from "../sse-client.ts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

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

describe("ToolAggregator — single backend (no prefix)", () => {
  test("exposes tools without prefix", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA, toolB]));

    const tools = await agg.listAllTools();
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe("find_symbol");
    expect(tools[1]!.name).toBe("search");
  });

  test("routes calls directly by tool name", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA]));

    const result = await agg.routeToolCall("find_symbol", { query: "test" });
    expect(result.content[0]).toHaveProperty(
      "text",
      'Called find_symbol with {"query":"test"}'
    );
  });

  test("preserves internal metadata", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA]));

    const tools = await agg.listAllTools();
    expect(tools[0]!._service).toBe("serena");
    expect(tools[0]!._originalName).toBe("find_symbol");
  });
});

describe("ToolAggregator — multiple backends (prefixed)", () => {
  test("prefixes tools with service_", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA]));
    agg.addBackend("db", mockClient([toolC]));

    const tools = await agg.listAllTools();
    expect(tools).toHaveLength(2);

    const names = tools.map((t) => t.name);
    expect(names).toContain("serena_find_symbol");
    expect(names).toContain("db_run_query");
  });

  test("routes calls to correct backend", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA]));
    agg.addBackend("db", mockClient([toolC]));

    const result = await agg.routeToolCall("serena_find_symbol", { query: "test" });
    expect(result.content[0]).toHaveProperty(
      "text",
      'Called find_symbol with {"query":"test"}'
    );
  });

  test("routes to second backend correctly", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA]));
    agg.addBackend("db", mockClient([toolC]));

    const result = await agg.routeToolCall("db_run_query", { sql: "SELECT 1" });
    expect(result.content[0]).toHaveProperty(
      "text",
      'Called run_query with {"sql":"SELECT 1"}'
    );
  });

  test("throws on unknown service prefix", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA]));
    agg.addBackend("db", mockClient([toolC]));

    await expect(
      agg.routeToolCall("unknown_find_symbol", {})
    ).rejects.toThrow("Unknown service");
  });
});

describe("ToolAggregator — edge cases", () => {
  test("removeBackend drops back to no-prefix mode", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA]));
    agg.addBackend("db", mockClient([toolC]));
    agg.removeBackend("db");

    const tools = await agg.listAllTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("find_symbol");
  });

  test("parseName with single backend routes everything to it", () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA]));

    const { service, tool } = agg.parseName("find_symbol");
    expect(service).toBe("serena");
    expect(tool).toBe("find_symbol");
  });

  test("parseName with invalid multi-backend name throws", () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA]));
    agg.addBackend("db", mockClient([toolC]));

    expect(() => agg.parseName("noseparator")).toThrow("expected service prefix");
  });
});
