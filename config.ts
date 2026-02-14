import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

/** Find the git repository root, falling back to cwd. */
export function findProjectRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
  } catch {
    return process.cwd();
  }
}

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
  exclude_tools?: string[];
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

function validateStringArray(value: unknown, field: string): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`'${field}' must be an array of strings`);
  }
  return value;
}

const VALID_TRANSPORTS = ["sse", "stdio"] as const;
const VALID_RESTART = ["on-failure", "always", "never"] as const;
const VALID_READINESS_CHECK = ["http"] as const;

function applyServiceDefaults(raw: any): ServiceConfig {
  if (!raw.command) throw new Error("Service must have a 'command' field");

  const transport = raw.transport ?? SERVICE_DEFAULTS.transport;
  if (!VALID_TRANSPORTS.includes(transport)) {
    throw new Error(`Invalid transport '${transport}' (expected: ${VALID_TRANSPORTS.join(", ")})`);
  }

  const restart = raw.restart ?? SERVICE_DEFAULTS.restart;
  if (!VALID_RESTART.includes(restart)) {
    throw new Error(`Invalid restart policy '${restart}' (expected: ${VALID_RESTART.join(", ")})`);
  }

  const readinessRaw = raw.readiness ?? {};
  const check = readinessRaw.check ?? SERVICE_DEFAULTS.readiness.check;
  if (!VALID_READINESS_CHECK.includes(check)) {
    throw new Error(`Invalid readiness check '${check}' (expected: ${VALID_READINESS_CHECK.join(", ")})`);
  }

  const readiness: ReadinessConfig = {
    check,
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
    transport,
    url: raw.url,
    env: raw.env,
    cwd: raw.cwd,
    readiness,
    restart,
    keep_alive: raw.keep_alive ?? SERVICE_DEFAULTS.keep_alive,
    exclude_tools: validateStringArray(raw.exclude_tools, "exclude_tools"),
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

/**
 * Recursively substitutes `${key}` patterns in all string values.
 * Supports `${env.VAR}` for environment variables.
 * Unknown variables are left as-is.
 */
export function substituteVariables(
  obj: unknown,
  vars: Record<string, string>,
): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (match, key: string) => {
      if (key.startsWith("env.")) {
        return process.env[key.slice(4)] ?? match;
      }
      return vars[key] ?? match;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => substituteVariables(item, vars));
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = substituteVariables(v, vars);
    }
    return result;
  }
  return obj;
}

export function loadConfig(path?: string): McpdConfig {
  const file = findConfigFile(path);
  if (!file) throw new Error("No mcpd.yml found");

  const text = require("fs").readFileSync(file, "utf-8");
  const raw = Bun.YAML.parse(text) as Record<string, any>;

  if (!raw?.services || typeof raw.services !== "object") {
    throw new Error("Config must have a 'services' map");
  }

  const vars: Record<string, string> = {
    workspaceRoot: findProjectRoot(),
    home: homedir(),
  };
  const substituted = substituteVariables(raw, vars) as Record<string, any>;

  const services: Record<string, ServiceConfig> = {};
  for (const [name, svc] of Object.entries(substituted.services as Record<string, any>)) {
    services[name] = applyServiceDefaults(svc);
  }

  return { services };
}
