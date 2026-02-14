import { describe, expect, test, afterEach } from "bun:test";
import { ServiceManager } from "../service-manager.ts";
import type { ServiceConfig } from "../config.ts";
import { join } from "path";

const TEST_SERVER = join(import.meta.dir, "fixtures", "test-server.ts");

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
});
