import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface ReadinessConfig {
  check: "http";
  url?: string;
  timeout: number; // ms
  interval: number; // ms
}

export interface ServiceConfig {
  command: string;
  args: string[];
  transport: "sse" | "stdio";
  url?: string;
  env?: Record<string, string>;
  cwd?: string;
  readiness: ReadinessConfig;
  restart: "on-failure" | "always" | "never";
  keep_alive: boolean;
  middleware?: {
    response?: (string | Record<string, any>)[];
  };
}

export interface McpdConfig {
  services: Record<string, ServiceConfig>;
}

export function parseDuration(s: string): number {
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)$/);
  if (!match) throw new Error(`Invalid duration: ${s}`);
  const [, value, unit] = match;
  const n = parseFloat(value!);
  switch (unit) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    default:
      throw new Error(`Unknown unit: ${unit}`);
  }
}

const SERVICE_DEFAULTS = {
  args: [] as string[],
  transport: "sse" as const,
  restart: "on-failure" as const,
  keep_alive: true,
  readiness: {
    check: "http" as const,
    timeout: 30_000,
    interval: 500,
  },
};

function applyServiceDefaults(raw: any): ServiceConfig {
  if (!raw.command) throw new Error("Service must have a 'command' field");

  const readinessRaw = raw.readiness ?? {};
  const readiness: ReadinessConfig = {
    check: readinessRaw.check ?? SERVICE_DEFAULTS.readiness.check,
    url: readinessRaw.url,
    timeout:
      typeof readinessRaw.timeout === "string"
        ? parseDuration(readinessRaw.timeout)
        : readinessRaw.timeout ?? SERVICE_DEFAULTS.readiness.timeout,
    interval:
      typeof readinessRaw.interval === "string"
        ? parseDuration(readinessRaw.interval)
        : readinessRaw.interval ?? SERVICE_DEFAULTS.readiness.interval,
  };

  return {
    command: raw.command,
    args: raw.args ?? SERVICE_DEFAULTS.args,
    transport: raw.transport ?? SERVICE_DEFAULTS.transport,
    url: raw.url,
    env: raw.env,
    cwd: raw.cwd,
    readiness,
    restart: raw.restart ?? SERVICE_DEFAULTS.restart,
    keep_alive: raw.keep_alive ?? SERVICE_DEFAULTS.keep_alive,
    middleware: raw.middleware,
  };
}

function findConfigFile(explicit?: string): string | null {
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    throw new Error(`Config file not found: ${explicit}`);
  }
  const candidates = [
    join(process.cwd(), "mcpd.yml"),
    join(homedir(), ".config", "mcpd", "config.yml"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function loadConfig(path?: string): McpdConfig {
  const file = findConfigFile(path);
  if (!file) throw new Error("No mcpd.yml found");

  const text = require("fs").readFileSync(file, "utf-8");
  const raw = Bun.YAML.parse(text) as Record<string, any>;

  if (!raw?.services || typeof raw.services !== "object") {
    throw new Error("Config must have a 'services' map");
  }

  const services: Record<string, ServiceConfig> = {};
  for (const [name, svc] of Object.entries(raw.services as Record<string, any>)) {
    services[name] = applyServiceDefaults(svc);
  }

  return { services };
}
