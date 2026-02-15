import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { join } from "path";
import { readFile, writeFile, unlink } from "fs/promises";
import { findProjectRoot } from "../config.ts";
import { ServiceManager, pidAlive } from "../service-manager.ts";
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

  // Read stdout to capture the "listening on" line and extract the actual port
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

/** Connect an SSE MCP client to the given URL. */
async function connectClient(url: string, name = "test-client"): Promise<Client> {
  const transport = new SSEClientTransport(new URL(url));
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function tryReadFile(path: string): Promise<string | null> {
  try { return await readFile(path, "utf-8"); } catch { return null; }
}

describe("proxy: stdio-to-HTTP/SSE bridge", () => {
  const procs: Subprocess[] = [];
  const clients: Client[] = [];
  let savedState: string | null = null;

  // Preserve pre-existing state file
  beforeEach(async () => {
    savedState = await tryReadFile(STATE_FILE);
  });

  afterEach(async () => {
    for (const c of clients) {
      try { await c.close(); } catch {}
    }
    clients.length = 0;
    for (const p of procs) {
      try { p.kill(); } catch {}
    }
    // Wait for proxy processes to exit
    await Promise.all(procs.map(async (p) => {
      try { await Promise.race([p.exited, new Promise(r => setTimeout(r, 2000))]); } catch {}
    }));
    procs.length = 0;
    // Restore original state file
    await unlink(STATE_FILE).catch(() => {});
    if (savedState !== null) {
      await writeFile(STATE_FILE, savedState);
    }
  });

  // -- HTTP endpoints --

  test("health endpoint returns 200", async () => {
    const { proc, port } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    const resp = await fetch(`http://localhost:${port}/health`);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ok");
  });

  test("returns 404 for unknown routes", async () => {
    const { proc, port } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    const resp = await fetch(`http://localhost:${port}/unknown`);
    expect(resp.status).toBe(404);
  });

  test("POST /message with invalid sessionId returns 404", async () => {
    const { proc, port } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    const resp = await fetch(
      `http://localhost:${port}/message?sessionId=nonexistent`,
      { method: "POST", body: "{}", headers: { "content-type": "application/json" } }
    );
    expect(resp.status).toBe(404);
    expect(await resp.text()).toBe("Session not found");
  });

  // -- SSE + MCP protocol --

  test("connects via SSE and lists tools", async () => {
    const { proc, url } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    const client = await connectClient(url);
    clients.push(client);

    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("echo");
    expect(names).toContain("greet");
  });

  test("calls echo tool through proxy", async () => {
    const { proc, url } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    const client = await connectClient(url);
    clients.push(client);

    const result = await client.callTool({
      name: "echo",
      arguments: { message: "proxy roundtrip" },
    });
    expect((result as any).content[0]).toMatchObject({
      type: "text",
      text: "proxy roundtrip",
    });
  });

  test("calls greet tool through proxy", async () => {
    const { proc, url } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    const client = await connectClient(url);
    clients.push(client);

    const result = await client.callTool({
      name: "greet",
      arguments: { name: "World" },
    });
    expect((result as any).content[0]).toMatchObject({
      type: "text",
      text: "Hello, World!",
    });
  });

  test("multiple sequential tool calls on same session", async () => {
    const { proc, url } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    const client = await connectClient(url);
    clients.push(client);

    // Call multiple tools in sequence through the same session
    for (let i = 0; i < 5; i++) {
      const result = await client.callTool({
        name: "echo",
        arguments: { message: `msg-${i}` },
      });
      expect((result as any).content[0].text).toBe(`msg-${i}`);
    }
  });

  // -- Concurrent clients --

  test("multiple concurrent SSE clients get correct responses", async () => {
    const { proc, url } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    const c1 = await connectClient(url, "client-1");
    clients.push(c1);
    const c2 = await connectClient(url, "client-2");
    clients.push(c2);

    // Both call tools concurrently
    const [r1, r2] = await Promise.all([
      c1.callTool({ name: "echo", arguments: { message: "from-1" } }),
      c2.callTool({ name: "greet", arguments: { name: "Client2" } }),
    ]);

    expect((r1 as any).content[0].text).toBe("from-1");
    expect((r2 as any).content[0].text).toBe("Hello, Client2!");
  });

  test("three concurrent clients all call tools successfully", async () => {
    const { proc, url } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    const c1 = await connectClient(url, "c1");
    const c2 = await connectClient(url, "c2");
    const c3 = await connectClient(url, "c3");
    clients.push(c1, c2, c3);

    const results = await Promise.all([
      c1.callTool({ name: "echo", arguments: { message: "a" } }),
      c2.callTool({ name: "echo", arguments: { message: "b" } }),
      c3.callTool({ name: "echo", arguments: { message: "c" } }),
    ]);

    expect((results[0] as any).content[0].text).toBe("a");
    expect((results[1] as any).content[0].text).toBe("b");
    expect((results[2] as any).content[0].text).toBe("c");
  });

  // -- Session lifecycle --

  test("new client works after first client disconnects", async () => {
    const { proc, url } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    // Connect and use first client
    const c1 = await connectClient(url, "first");
    const r1 = await c1.callTool({ name: "echo", arguments: { message: "first" } });
    expect((r1 as any).content[0].text).toBe("first");

    // Disconnect first client
    await c1.close();

    // Brief delay for session cleanup
    await new Promise((r) => setTimeout(r, 200));

    // Connect second client — should work fine
    const c2 = await connectClient(url, "second");
    clients.push(c2);
    const r2 = await c2.callTool({ name: "echo", arguments: { message: "second" } });
    expect((r2 as any).content[0].text).toBe("second");
  });

  // -- State integration --

  test("proxy registers in .mcpd-state.json", async () => {
    const { proc, port } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    // Give state file time to be written
    await new Promise((r) => setTimeout(r, 300));

    const state = await ServiceManager.loadState();
    // Find the proxy entry (name defaults to "bun")
    const entry = Object.entries(state).find(([, info]) =>
      info.url?.includes(String(port))
    );
    expect(entry).toBeDefined();
    const [, info] = entry!;
    expect(info.state).toBe("ready");
    expect(info.pid).toBeDefined();
    expect(info.url).toContain(String(port));
    expect(pidAlive(info.pid!)).toBe(true);
  });

  test("proxy with --name flag uses custom name in state", async () => {
    const { proc, port } = await startTestProxy(
      "bun", ["run", TEST_MCP_SERVER],
      ["-n", "my-proxy"]
    );
    procs.push(proc);

    await new Promise((r) => setTimeout(r, 300));

    const state = await ServiceManager.loadState();
    expect(state["my-proxy"]).toBeDefined();
    expect(state["my-proxy"]!.state).toBe("ready");
    expect(state["my-proxy"]!.url).toContain(String(port));
  });

  // -- Graceful shutdown --

  test("proxy shuts down cleanly on SIGTERM", async () => {
    const { proc, port } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    // Verify it's running
    const resp = await fetch(`http://localhost:${port}/health`);
    expect(resp.status).toBe(200);

    // Send SIGTERM
    proc.kill("SIGTERM");
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ]);

    // Should have exited (not hung)
    expect(exitCode).not.toBeNull();

    // HTTP server should no longer be reachable
    try {
      await fetch(`http://localhost:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      // If fetch succeeds, the server is still running (unexpected)
      expect(true).toBe(false);
    } catch {
      // Expected: connection refused or timeout
    }
  });

  // -- Random port assignment --

  test("port 0 assigns a random port", async () => {
    const { proc, port } = await startTestProxy("bun", ["run", TEST_MCP_SERVER]);
    procs.push(proc);

    // Port should be a valid non-zero port
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);

    // And it should be reachable
    const resp = await fetch(`http://localhost:${port}/health`);
    expect(resp.status).toBe(200);
  });
});

describe("proxy: CLI argument handling", () => {
  test("proxy without -- shows usage error", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "index.ts", "proxy", "-p", "0"],
      { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" }
    );

    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);

    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Usage:");
  });

  test("--help includes proxy command", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "index.ts", "--help"],
      { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" }
    );

    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("proxy");
    expect(stdout).toContain("Bridge a stdio MCP server to HTTP/SSE");
  });

  test("proxy with invalid command fails", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "index.ts", "proxy", "-p", "0", "--", "nonexistent-binary-xyz"],
      { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" }
    );

    const exitCode = await Promise.race([
      proc.exited,
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ]);

    // Should exit with error (non-zero or null if timed out)
    if (exitCode !== null) {
      expect(exitCode).not.toBe(0);
    }
    proc.kill();
  });

  test("rejects invalid port (non-numeric)", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "index.ts", "proxy", "-p", "abc", "--", "bun", "run", TEST_MCP_SERVER],
      { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" }
    );

    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);

    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Invalid port");
  });

  test("rejects negative port", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "index.ts", "proxy", "--port=-1", "--", "bun", "run", TEST_MCP_SERVER],
      { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" }
    );

    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);

    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Invalid port");
  });

  test("rejects invalid restart policy", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "index.ts", "proxy", "-p", "0", "--restart", "bogus", "--", "bun", "run", TEST_MCP_SERVER],
      { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" }
    );

    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);

    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("Invalid restart policy");
  });
});

describe("proxy: state cleanup on shutdown", () => {
  let savedState: string | null = null;

  beforeEach(async () => {
    savedState = await tryReadFile(STATE_FILE);
  });

  afterEach(async () => {
    await unlink(STATE_FILE).catch(() => {});
    if (savedState !== null) {
      await writeFile(STATE_FILE, savedState);
    }
  });

  test("state entry is removed after clean SIGTERM shutdown", async () => {
    const { proc, port } = await startTestProxy(
      "bun", ["run", TEST_MCP_SERVER],
      ["-n", "cleanup-test"]
    );

    // Verify state entry exists
    await new Promise((r) => setTimeout(r, 300));
    let state = await ServiceManager.loadState();
    expect(state["cleanup-test"]).toBeDefined();

    // SIGTERM for clean shutdown
    proc.kill("SIGTERM");
    await Promise.race([
      proc.exited,
      new Promise((r) => setTimeout(r, 5000)),
    ]);

    // State entry should be gone
    await new Promise((r) => setTimeout(r, 200));
    state = await ServiceManager.loadState();
    expect(state["cleanup-test"]).toBeUndefined();
  });
});
