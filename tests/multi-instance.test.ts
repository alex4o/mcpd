import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { BackendClient } from "../sse-client.ts";
import { ToolAggregator } from "../aggregator.ts";
import { join } from "path";
import { readFile, writeFile, unlink } from "fs/promises";
import { findProjectRoot } from "../config.ts";
import { ServiceManager } from "../service-manager.ts";
import type { Subprocess } from "bun";

const TEST_MCP_SERVER = join(import.meta.dir, "fixtures", "test-mcp-server.ts");
const STATE_FILE = join(findProjectRoot(), ".mcpd-state.json");
const PROJECT_ROOT = join(import.meta.dir, "..");

/** Start the proxy as a subprocess on a random port, return the proc and actual URL. */
async function startTestProxy(
  command: string,
  args: string[],
  extraFlags: string[] = [],
  port = 0
): Promise<{ proc: Subprocess; url: string; port: number }> {
  const proc = Bun.spawn(
    [
      "bun", "run", "index.ts", "proxy",
      "-p", String(port),
      ...extraFlags,
      "--",
      command, ...args,
    ],
    { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" }
  );

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
    const match = output.match(/listening on (http:\/\/[^\s]+)/);
    if (match) {
      reader.releaseLock();
      const url = match[1]!;
      const actualPort = parseInt(new URL(url).port);
      return { proc, url, port: actualPort };
    }
  }
  reader.releaseLock();
  proc.kill();
  throw new Error(`Proxy did not start in time. Output: ${output}`);
}

async function tryReadFile(path: string): Promise<string | null> {
  try { return await readFile(path, "utf-8"); } catch { return null; }
}

describe("multi-instance: two mcpd instances share the same backend", () => {
  const procs: Subprocess[] = [];
  const clients: BackendClient[] = [];
  let savedState: string | null = null;

  beforeEach(async () => {
    savedState = await tryReadFile(STATE_FILE);
  });

  afterEach(async () => {
    for (const c of clients) {
      try { await c.disconnect(); } catch {}
    }
    clients.length = 0;
    for (const p of procs) {
      try { p.kill(); } catch {}
    }
    await Promise.all(procs.map(async (p) => {
      try { await Promise.race([p.exited, new Promise(r => setTimeout(r, 2000))]); } catch {}
    }));
    procs.length = 0;
    await unlink(STATE_FILE).catch(() => {});
    if (savedState !== null) {
      await writeFile(STATE_FILE, savedState);
    }
  });

  test("two instances connect to the same SSE backend and list tools", async () => {
    const { proc, url } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    // Instance A
    const clientA = new BackendClient("instance-a");
    await clientA.connect(url);
    clients.push(clientA);

    // Instance B
    const clientB = new BackendClient("instance-b");
    await clientB.connect(url);
    clients.push(clientB);

    const toolsA = await clientA.listTools();
    const toolsB = await clientB.listTools();

    const namesA = toolsA.map((t) => t.name);
    const namesB = toolsB.map((t) => t.name);

    expect(namesA).toContain("echo");
    expect(namesA).toContain("greet");
    expect(namesB).toContain("echo");
    expect(namesB).toContain("greet");
  });

  test("two instances call tools independently on the same backend", async () => {
    const { proc, url } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    const clientA = new BackendClient("instance-a");
    await clientA.connect(url);
    clients.push(clientA);

    const clientB = new BackendClient("instance-b");
    await clientB.connect(url);
    clients.push(clientB);

    const resultA = await clientA.callTool("echo", { message: "from-instance-a" });
    expect(resultA.content[0]).toMatchObject({
      type: "text",
      text: "from-instance-a",
    });

    const resultB = await clientB.callTool("greet", { name: "InstanceB" });
    expect(resultB.content[0]).toMatchObject({
      type: "text",
      text: "Hello, InstanceB!",
    });
  });

  test("two instances call tools concurrently without interference", async () => {
    const { proc, url } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    const clientA = new BackendClient("instance-a");
    await clientA.connect(url);
    clients.push(clientA);

    const clientB = new BackendClient("instance-b");
    await clientB.connect(url);
    clients.push(clientB);

    // Fire concurrent calls from both instances
    const [rA, rB] = await Promise.all([
      clientA.callTool("echo", { message: "concurrent-a" }),
      clientB.callTool("echo", { message: "concurrent-b" }),
    ]);

    expect(rA.content[0]).toMatchObject({ type: "text", text: "concurrent-a" });
    expect(rB.content[0]).toMatchObject({ type: "text", text: "concurrent-b" });
  });

  test("two full aggregator stacks route through the same backend", async () => {
    const { proc, url } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    // Instance A: BackendClient + ToolAggregator (simulates a full mcpd)
    const clientA = new BackendClient("instance-a");
    await clientA.connect(url);
    clients.push(clientA);
    const aggA = new ToolAggregator();
    aggA.addBackend("backend", clientA);

    // Instance B: BackendClient + ToolAggregator (simulates a second mcpd)
    const clientB = new BackendClient("instance-b");
    await clientB.connect(url);
    clients.push(clientB);
    const aggB = new ToolAggregator();
    aggB.addBackend("backend", clientB);

    // Both aggregators see the same tools
    const toolsA = await aggA.listAllTools();
    const toolsB = await aggB.listAllTools();

    expect(toolsA.map((t) => t.name)).toEqual(toolsB.map((t) => t.name));
    expect(toolsA.map((t) => t.name)).toContain("echo");

    // Both can route tool calls
    const [rA, rB] = await Promise.all([
      aggA.routeToolCall("echo", { message: "agg-a" }),
      aggB.routeToolCall("greet", { name: "AggB" }),
    ]);

    expect(rA.content[0]).toMatchObject({ type: "text", text: "agg-a" });
    expect(rB.content[0]).toMatchObject({ type: "text", text: "Hello, AggB!" });
  });

  test("one instance disconnecting does not break the other", async () => {
    const { proc, url } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    const clientA = new BackendClient("instance-a");
    await clientA.connect(url);
    // Don't push to clients[] — we'll disconnect manually

    const clientB = new BackendClient("instance-b");
    await clientB.connect(url);
    clients.push(clientB);

    // Both work initially
    const rA = await clientA.callTool("echo", { message: "before-disconnect" });
    expect(rA.content[0]).toMatchObject({ type: "text", text: "before-disconnect" });

    // Instance A disconnects
    await clientA.disconnect();

    // Brief delay for session cleanup
    await new Promise((r) => setTimeout(r, 200));

    // Instance B still works fine
    const rB = await clientB.callTool("echo", { message: "after-disconnect" });
    expect(rB.content[0]).toMatchObject({ type: "text", text: "after-disconnect" });
  });

  test("heavy concurrent load from two instances", async () => {
    const { proc, url } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    const clientA = new BackendClient("instance-a");
    await clientA.connect(url);
    clients.push(clientA);

    const clientB = new BackendClient("instance-b");
    await clientB.connect(url);
    clients.push(clientB);

    // 10 concurrent calls from each instance, interleaved
    const promises: Promise<{ from: string; idx: number; text: string }>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        clientA.callTool("echo", { message: `a-${i}` }).then((r) => ({
          from: "a",
          idx: i,
          text: (r.content[0] as any).text,
        }))
      );
      promises.push(
        clientB.callTool("echo", { message: `b-${i}` }).then((r) => ({
          from: "b",
          idx: i,
          text: (r.content[0] as any).text,
        }))
      );
    }

    const results = await Promise.all(promises);

    // Every call should have returned the correct value — no cross-talk
    for (const r of results) {
      expect(r.text).toBe(`${r.from}-${r.idx}`);
    }
  });
});
