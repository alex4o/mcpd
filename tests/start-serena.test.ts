import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const scriptPath = resolve(import.meta.dir, "../start-serena.sh");
const script = readFileSync(scriptPath, "utf-8");

describe("start-serena.sh", () => {
  test("has valid shebang", () => {
    expect(script.startsWith("#!/bin/bash")).toBe(true);
  });

  test("uses port 8766 (not 8765)", () => {
    expect(script).toContain("PORT=8766");
    expect(script).not.toContain("PORT=8765");
  });

  test("supports kill mode", () => {
    expect(script).toContain('"kill"');
  });

  test("supports restart mode", () => {
    expect(script).toContain('"restart"');
  });

  test("references SCRIPT_DIR for project path", () => {
    expect(script).toContain("SCRIPT_DIR=");
    expect(script).toContain("--project \"$SCRIPT_DIR\"");
  });

  test("manages PID file", () => {
    expect(script).toContain("PIDFILE=");
    expect(script).toContain(".serena.pid");
    expect(script).toContain('echo $! > "$PIDFILE"');
  });

  test("is executable", async () => {
    const stat = Bun.file(scriptPath);
    // Check file exists and is non-empty
    expect(stat.size).toBeGreaterThan(0);
    // Check executable permission via subprocess
    const result = Bun.spawnSync(["test", "-x", scriptPath]);
    expect(result.exitCode).toBe(0);
  });
});
