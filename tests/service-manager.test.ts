import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { ServiceManager, pidAlive } from "../service-manager.ts";
import type { ServiceConfig } from "../config.ts";
import { findProjectRoot } from "../config.ts";
import { join } from "path";
import { unlinkSync } from "fs";

const TEST_SERVER = join(import.meta.dir, "fixtures", "test-server.ts");
const STATE_FILE = join(findProjectRoot(), ".mcpd-state.json");

function makeConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    command: "bun",
    args: ["run", TEST_SERVER, "0"],
    transport: "sse",
    readiness: {
      check: "http",
      timeout: 10000,
      interval: 100,
    },
    restart: "never",
    keep_alive: true,
    ...overrides,
  };
}

let manager: ServiceManager;

afterEach(async () => {
  if (manager) {
    await manager.stopAll();
  }
});

describe("pidAlive", () => {
  test("returns true for current process", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  test("returns false for non-existent PID", () => {
    expect(pidAlive(999999)).toBe(false);
  });
});

describe("ServiceManager", () => {
  test("start spawns a process and passes readiness check", async () => {
    manager = new ServiceManager();
    // We need a URL for readiness; we'll use a trick: start the server,
    // read its port from stdout, then check readiness.
    // For simplicity, start with readiness disabled (stdio transport).
    const config = makeConfig({ transport: "stdio" });
    await manager.start("test", config);
    expect(manager.getState("test")).toBe("ready");
  });

  test("stop terminates a running process", async () => {
    manager = new ServiceManager();
    const config = makeConfig({ transport: "stdio" });
    await manager.start("test", config);
    expect(manager.getState("test")).toBe("ready");
    await manager.stop("test");
    expect(manager.getState("test")).toBe("stopped");
  });

  test("restart gives a new process", async () => {
    manager = new ServiceManager();
    const config = makeConfig({ transport: "stdio" });
    await manager.start("test", config);
    const info1 = manager.getAll().find((s) => s.name === "test");
    const pid1 = info1?.pid;

    await manager.restart("test");
    const info2 = manager.getAll().find((s) => s.name === "test");
    const pid2 = info2?.pid;

    expect(pid1).toBeDefined();
    expect(pid2).toBeDefined();
    expect(pid1).not.toBe(pid2);
    expect(manager.getState("test")).toBe("ready");
  });

  test("getAll returns all service states", async () => {
    manager = new ServiceManager();
    const config = makeConfig({ transport: "stdio" });
    await manager.start("a", config);
    await manager.start("b", config);
    const all = manager.getAll();
    expect(all.length).toBe(2);
    expect(all.map((s) => s.name).sort()).toEqual(["a", "b"]);
  });

  test("start with HTTP readiness check", async () => {
    manager = new ServiceManager();
    // Start the test server on a known port and configure readiness
    const port = 18900 + Math.floor(Math.random() * 100);
    const config = makeConfig({
      args: ["run", TEST_SERVER, String(port)],
      url: `http://localhost:${port}/`,
      readiness: {
        check: "http",
        timeout: 10000,
        interval: 100,
      },
    });
    await manager.start("http-test", config);
    expect(manager.getState("http-test")).toBe("ready");
  });

  test("readiness timeout throws error", async () => {
    manager = new ServiceManager();
    // Point at a port nothing listens on
    const config = makeConfig({
      url: "http://localhost:19999/",
      readiness: {
        check: "http",
        timeout: 500,
        interval: 100,
      },
    });
    await expect(manager.start("timeout-test", config)).rejects.toThrow(
      "timed out"
    );
    expect(manager.getState("timeout-test")).toBe("error");
  });

  test("stopAll stops all services", async () => {
    manager = new ServiceManager();
    const config = makeConfig({ transport: "stdio" });
    await manager.start("a", config);
    await manager.start("b", config);
    await manager.stopAll();
    expect(manager.getState("a")).toBe("stopped");
    expect(manager.getState("b")).toBe("stopped");
  });

  test("stop clears PID from service info", async () => {
    manager = new ServiceManager();
    const config = makeConfig({ transport: "stdio" });
    await manager.start("test", config);

    const before = manager.getAll().find((s) => s.name === "test");
    expect(before?.pid).toBeDefined();

    await manager.stop("test");

    const after = manager.getAll().find((s) => s.name === "test");
    expect(after?.pid).toBeUndefined();
    expect(after?.state).toBe("stopped");
  });

  test("restart clears old PID and assigns new one", async () => {
    manager = new ServiceManager();
    const config = makeConfig({ transport: "stdio" });
    await manager.start("test", config);

    const before = manager.getAll().find((s) => s.name === "test");
    const oldPid = before?.pid;
    expect(oldPid).toBeDefined();

    await manager.restart("test");

    const after = manager.getAll().find((s) => s.name === "test");
    expect(after?.pid).toBeDefined();
    expect(after?.pid).not.toBe(oldPid);
    expect(after?.state).toBe("ready");
  });
});

describe("Service reuse — no duplicate instances", () => {
  const managers: ServiceManager[] = [];
  let savedState: string | null = null;

  // Save and remove any pre-existing state file to isolate tests
  beforeEach(() => {
    try {
      savedState = require("fs").readFileSync(STATE_FILE, "utf-8");
      unlinkSync(STATE_FILE);
    } catch {
      savedState = null;
    }
  });

  afterEach(async () => {
    for (const m of managers) {
      await m.stopAll();
    }
    managers.length = 0;
    try { unlinkSync(STATE_FILE); } catch {}
    // Restore original state file if one existed before tests
    if (savedState !== null) {
      require("fs").writeFileSync(STATE_FILE, savedState);
    }
  });

  test("second manager reuses running service via state file + reachability", async () => {
    const port = 19100 + Math.floor(Math.random() * 100);
    const config = makeConfig({
      args: ["run", TEST_SERVER, String(port)],
      url: `http://localhost:${port}/`,
      readiness: { check: "http", timeout: 10000, interval: 100 },
    });

    // Manager A starts the service (spawns the process)
    const managerA = new ServiceManager();
    managers.push(managerA);
    await managerA.start("serena", config);

    const infoA = managerA.getAll().find((s) => s.name === "serena");
    expect(infoA?.state).toBe("ready");
    expect(infoA?.pid).toBeDefined();
    const originalPid = infoA!.pid!;

    // Manager B (new instance, like a second Claude Code session) tries to start same service
    const managerB = new ServiceManager();
    managers.push(managerB);
    await managerB.start("serena", config);

    const infoB = managerB.getAll().find((s) => s.name === "serena");
    expect(infoB?.state).toBe("ready");
    // B should reuse A's PID from the state file, not spawn a new process
    expect(infoB?.pid).toBe(originalPid);
  });

  test("second manager reuses externally-started service via reachability alone", async () => {
    const port = 19200 + Math.floor(Math.random() * 100);

    // Start a server externally (not through ServiceManager)
    const externalProc = Bun.spawn(["bun", "run", TEST_SERVER, String(port)], {
      stdout: "ignore",
      stderr: "ignore",
    });

    // Wait for it to be reachable
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`http://localhost:${port}/`);
        if (resp.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }

    try {
      const config = makeConfig({
        args: ["run", TEST_SERVER, String(port)],
        url: `http://localhost:${port}/`,
        readiness: { check: "http", timeout: 5000, interval: 100 },
      });

      // Manager sees the service is reachable and skips spawning
      const mgr = new ServiceManager();
      managers.push(mgr);
      await mgr.start("serena", config);

      const info = mgr.getAll().find((s) => s.name === "serena");
      expect(info?.state).toBe("ready");
      // No PID tracked — manager didn't spawn this process
      expect(info?.pid).toBeUndefined();
    } finally {
      externalProc.kill("SIGTERM");
      await externalProc.exited;
    }
  });

  test("concurrent starts on same port result in only one process listening", async () => {
    const port = 19300 + Math.floor(Math.random() * 100);
    const config = makeConfig({
      args: ["run", TEST_SERVER, String(port)],
      url: `http://localhost:${port}/`,
      readiness: { check: "http", timeout: 10000, interval: 100 },
    });

    const managerA = new ServiceManager();
    const managerB = new ServiceManager();
    managers.push(managerA, managerB);

    // Start both concurrently — one will bind the port, the other's spawn will fail
    const [resultA, resultB] = await Promise.allSettled([
      managerA.start("serena", config),
      managerB.start("serena", config),
    ]);

    // At least one should succeed
    const anyReady =
      resultA.status === "fulfilled" || resultB.status === "fulfilled";
    expect(anyReady).toBe(true);

    // The service should be reachable (exactly one process owns the port)
    const resp = await fetch(`http://localhost:${port}/`);
    expect(resp.ok).toBe(true);
  });

  test("third manager after stop does not reuse dead service", async () => {
    const port = 19400 + Math.floor(Math.random() * 100);
    const config = makeConfig({
      args: ["run", TEST_SERVER, String(port)],
      url: `http://localhost:${port}/`,
      readiness: { check: "http", timeout: 10000, interval: 100 },
    });

    // Manager A starts and then stops the service
    const managerA = new ServiceManager();
    managers.push(managerA);
    await managerA.start("serena", config);
    const pidA = managerA.getAll().find((s) => s.name === "serena")!.pid!;
    await managerA.stop("serena");

    // Wait for the process to actually die
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && pidAlive(pidA)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(pidAlive(pidA)).toBe(false);

    // Manager B should NOT reuse the dead service — it should spawn a new one
    const managerB = new ServiceManager();
    managers.push(managerB);
    await managerB.start("serena", config);

    const infoB = managerB.getAll().find((s) => s.name === "serena");
    expect(infoB?.state).toBe("ready");
    expect(infoB?.pid).toBeDefined();
    expect(infoB?.pid).not.toBe(pidA);
  });
});
