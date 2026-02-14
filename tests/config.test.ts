import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { loadConfig, parseDuration } from "../config.ts";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

const TMP_DIR = join(import.meta.dir, "tmp");
const TMP_CONFIG = join(TMP_DIR, "mcpd.yml");

function writeYaml(content: string) {
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(TMP_CONFIG, content);
}

afterEach(() => {
  try {
    unlinkSync(TMP_CONFIG);
  } catch {}
});

describe("parseDuration", () => {
  test("parses milliseconds", () => {
    expect(parseDuration("500ms")).toBe(500);
  });

  test("parses seconds", () => {
    expect(parseDuration("30s")).toBe(30000);
  });

  test("parses minutes", () => {
    expect(parseDuration("2m")).toBe(120000);
  });

  test("parses fractional values", () => {
    expect(parseDuration("1.5s")).toBe(1500);
  });

  test("throws on invalid format", () => {
    expect(() => parseDuration("abc")).toThrow("Invalid duration");
  });
});

describe("loadConfig", () => {
  test("loads valid YAML config", () => {
    writeYaml(`
services:
  serena:
    command: ./start-serena.sh
    url: http://localhost:8766/sse
`);
    const config = loadConfig(TMP_CONFIG);
    expect(config.services.serena).toBeDefined();
    expect(config.services.serena!.command).toBe("./start-serena.sh");
    expect(config.services.serena!.url).toBe("http://localhost:8766/sse");
  });

  test("applies defaults for missing optional fields", () => {
    writeYaml(`
services:
  myservice:
    command: node server.js
`);
    const config = loadConfig(TMP_CONFIG);
    const svc = config.services.myservice!;
    expect(svc.args).toEqual([]);
    expect(svc.transport).toBe("sse");
    expect(svc.restart).toBe("on-failure");
    expect(svc.keep_alive).toBe(true);
    expect(svc.readiness.check).toBe("http");
    expect(svc.readiness.timeout).toBe(30000);
    expect(svc.readiness.interval).toBe(500);
  });

  test("parses duration strings in readiness config", () => {
    writeYaml(`
services:
  myservice:
    command: node server.js
    readiness:
      timeout: 10s
      interval: 1s
`);
    const config = loadConfig(TMP_CONFIG);
    const svc = config.services.myservice!;
    expect(svc.readiness.timeout).toBe(10000);
    expect(svc.readiness.interval).toBe(1000);
  });

  test("errors on missing required fields", () => {
    writeYaml(`
services:
  broken:
    url: http://localhost:8000
`);
    expect(() => loadConfig(TMP_CONFIG)).toThrow("command");
  });

  test("errors when no services map", () => {
    writeYaml(`foo: bar`);
    expect(() => loadConfig(TMP_CONFIG)).toThrow("services");
  });

  test("errors on non-existent explicit path", () => {
    expect(() => loadConfig("/nonexistent/mcpd.yml")).toThrow("not found");
  });

  test("preserves service args", () => {
    writeYaml(`
services:
  myservice:
    command: node
    args:
      - server.js
      - --port
      - "8080"
`);
    const config = loadConfig(TMP_CONFIG);
    expect(config.services.myservice!.args).toEqual([
      "server.js",
      "--port",
      "8080",
    ]);
  });

  test("preserves middleware config", () => {
    writeYaml(`
services:
  myservice:
    command: node server.js
    middleware:
      response:
        - strip-json-keys
        - strip-result-wrapper
`);
    const config = loadConfig(TMP_CONFIG);
    expect(config.services.myservice!.middleware?.response).toEqual([
      "strip-json-keys",
      "strip-result-wrapper",
    ]);
  });
});
