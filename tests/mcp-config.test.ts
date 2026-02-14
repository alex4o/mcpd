import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const configPath = resolve(import.meta.dir, "../.mcp.json");

describe(".mcp.json", () => {
  test("is valid JSON", () => {
    const raw = readFileSync(configPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("has mcpServers key", () => {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config).toHaveProperty("mcpServers");
    expect(typeof config.mcpServers).toBe("object");
  });

  test("mcpd server is configured", () => {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const mcpd = config.mcpServers.mcpd;
    expect(mcpd).toBeDefined();
    expect(mcpd.command).toBe("bun");
    expect(mcpd.args).toEqual(["run", "index.ts"]);
  });
});
