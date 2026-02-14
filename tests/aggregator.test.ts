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
    ).rejects.toThrow("no matching service prefix");
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

    expect(() => agg.parseName("noseparator")).toThrow("no matching service prefix");
  });

  test("parseName with no backends throws", () => {
    const agg = new ToolAggregator();
    expect(() => agg.parseName("anything")).toThrow("No backends registered");
  });
});

describe("ToolAggregator — underscore service names", () => {
  test("routes to service with underscores in name", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("my_db", mockClient([toolC]));
    agg.addBackend("serena", mockClient([toolA]));

    const result = await agg.routeToolCall("my_db_run_query", { sql: "SELECT 1" });
    expect(result.content[0]).toHaveProperty(
      "text",
      'Called run_query with {"sql":"SELECT 1"}'
    );
  });

  test("parseName correctly splits underscore service name", () => {
    const agg = new ToolAggregator();
    agg.addBackend("my_db", mockClient([toolC]));
    agg.addBackend("serena", mockClient([toolA]));

    const { service, tool } = agg.parseName("my_db_run_query");
    expect(service).toBe("my_db");
    expect(tool).toBe("run_query");
  });

  test("prefers longest matching prefix", () => {
    const agg = new ToolAggregator();
    // "a" and "a_b" are both backends; "a_b_tool" should match "a_b"
    // since longest prefix wins for unambiguous routing
    agg.addBackend("a", mockClient([toolA]));
    agg.addBackend("a_b", mockClient([toolC]));

    const { service, tool } = agg.parseName("a_b_tool");
    expect(service).toBe("a_b");
    expect(tool).toBe("tool");
  });

  test("falls through to longer prefix when short prefix has no match", () => {
    const agg = new ToolAggregator();
    // Only "a_b" is a backend, not "a"
    agg.addBackend("a_b", mockClient([toolC]));
    agg.addBackend("serena", mockClient([toolA]));

    const { service, tool } = agg.parseName("a_b_run_query");
    expect(service).toBe("a_b");
    expect(tool).toBe("run_query");
  });

  test("lists tools with underscore service prefix", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("my_db", mockClient([toolC]));
    agg.addBackend("serena", mockClient([toolA]));

    const tools = await agg.listAllTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("my_db_run_query");
    expect(names).toContain("serena_find_symbol");
  });
});

describe("ToolAggregator — exclude_tools", () => {
  test("excludes tools by name", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA, toolB]), ["search"]);

    const tools = await agg.listAllTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("find_symbol");
  });

  test("excludes tools with multiple backends", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA, toolB]), ["find_symbol"]);
    agg.addBackend("db", mockClient([toolC]));

    const tools = await agg.listAllTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["serena_search", "db_run_query"]);
  });

  test("exclusion only affects the specified backend", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("a", mockClient([toolA, toolB]), ["search"]);
    agg.addBackend("b", mockClient([toolA, toolB]));

    const tools = await agg.listAllTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("b_search");
    expect(names).not.toContain("a_search");
  });

  test("removeBackend clears exclusion state", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA, toolB]), ["search"]);
    agg.removeBackend("serena");
    // Re-add without exclusions — stale exclusions should not apply
    agg.addBackend("serena", mockClient([toolA, toolB]));

    const tools = await agg.listAllTools();
    expect(tools).toHaveLength(2);
  });

  test("addBackend without exclusions clears previous exclusions", async () => {
    const agg = new ToolAggregator();
    agg.addBackend("serena", mockClient([toolA, toolB]), ["search"]);
    // Replace backend without exclusions
    agg.addBackend("serena", mockClient([toolA, toolB]));

    const tools = await agg.listAllTools();
    expect(tools).toHaveLength(2);
  });
});
