import { parseArgs } from "util";
import { loadConfig, findProjectRoot } from "./config.ts";
import { ServiceManager, pidAlive } from "./service-manager.ts";
import { BackendClient } from "./sse-client.ts";
import { ToolAggregator } from "./aggregator.ts";
import { createServer } from "./server.ts";
import { resolveMiddleware, type McpMiddleware } from "./middleware.ts";
import { startProxy } from "./proxy.ts";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";
import log from "./logger.ts";

const PID_FILE = join(findProjectRoot(), ".mcpd.pid");

// -- helpers --

function killServiceByPid(name: string, info: { pid?: number }): void {
  if (!info?.pid) {
    console.log(`${name}: no pid tracked`);
    return;
  }
  if (!pidAlive(info.pid)) {
    console.log(`${name}: pid ${info.pid} already dead`);
    return;
  }
  try {
    process.kill(info.pid, "SIGTERM");
    console.log(`${name}: killed ${info.pid}`);
  } catch (e: any) {
    console.log(`${name}: ${e.code === "ESRCH" ? "already gone" : e.message}`);
  }
}

// -- commands --

async function cmdStart(configPath?: string) {
  const config = loadConfig(configPath);
  log.info({ services: Object.keys(config.services) }, "config loaded");
  const manager = new ServiceManager();
  const aggregator = new ToolAggregator();
  const serviceMiddlewares = new Map<string, McpMiddleware[]>();
  const clients: BackendClient[] = [];

  const cleanup = async () => {
    log.info("shutting down");
    // Disconnect all backend clients (stdio clients kill their child process)
    await Promise.all(clients.map((c) => c.disconnect().catch(() => {})));
    // Only stop services that don't have keep_alive set
    for (const [name, svc] of Object.entries(config.services)) {
      if (!svc.keep_alive) {
        await manager.stop(name);
      }
    }
    await unlink(PID_FILE).catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  // Only SSE services need process management; stdio is owned by StdioClientTransport
  const sseOnlyConfig = {
    services: Object.fromEntries(
      Object.entries(config.services).filter(([, svc]) => svc.transport === "sse")
    ),
  };
  await manager.startAll(sseOnlyConfig);

  // Write PID file only after successful startup
  await writeFile(PID_FILE, String(process.pid));

  for (const [name, svc] of Object.entries(config.services)) {
    const client = new BackendClient(name);

    if (svc.transport === "sse" && svc.url) {
      await client.connect(svc.url);
    } else if (svc.transport === "stdio") {
      await client.connectStdio(svc.command, svc.args, {
        cwd: svc.cwd,
        env: svc.env,
      });
      // Track stdio process PID in service state
      if (client.pid) {
        await manager.registerPid(name, client.pid);
      }
    } else {
      continue;
    }

    clients.push(client);
    aggregator.addBackend(name, client, svc.exclude_tools);

    if (svc.middleware?.response) {
      serviceMiddlewares.set(name, resolveMiddleware(svc.middleware.response));
    }
  }

  await createServer(aggregator, serviceMiddlewares);
}

async function cmdPs() {
  // mcpd itself
  try {
    const pidStr = await readFile(PID_FILE, "utf-8");
    const pid = parseInt(pidStr.trim());
    console.log(`mcpd         pid=${pid}  ${pidAlive(pid) ? "running" : "dead (stale pid)"}`);
  } catch {
    console.log("mcpd         not running");
  }

  // services from saved state
  const state = await ServiceManager.loadState();
  if (Object.keys(state).length === 0) {
    console.log("(no services tracked)");
    return;
  }
  for (const [name, info] of Object.entries(state)) {
    const alive = info.pid ? pidAlive(info.pid) : false;
    const pidStr = info.pid ? `pid=${info.pid}` : "no pid";
    const urlStr = info.url ? `url=${info.url}` : "";
    const status = alive ? "running" : info.state === "ready" ? "dead (stale)" : info.state;
    console.log(`${name.padEnd(13)}${pidStr}  ${urlStr}  ${status}`);
  }
}

async function cmdKill(target?: string) {
  const state = await ServiceManager.loadState();

  if (Object.keys(state).length === 0) {
    console.log("No services tracked");
    return;
  }

  const killAll = !target || target === "all";

  if (!killAll && !state[target!]) {
    console.error(`Unknown service: ${target}`);
    process.exit(1);
  }

  const toKill = killAll ? state : { [target!]: state[target!]! };

  for (const [name, info] of Object.entries(toKill)) {
    killServiceByPid(name, info);
  }

  // Kill mcpd itself when killing all
  if (killAll) {
    try {
      const pidStr = await readFile(PID_FILE, "utf-8");
      const pid = parseInt(pidStr.trim());
      try { process.kill(pid, "SIGTERM"); console.log(`mcpd: killed ${pid}`); } catch {}
      await unlink(PID_FILE).catch(() => {});
    } catch {}
  }
}

async function cmdRestart(target: string | undefined, configPath?: string) {
  const config = loadConfig(configPath);
  const killAll = !target || target === "all";

  if (!killAll && !config.services[target!]) {
    console.error(`Unknown service: ${target}`);
    process.exit(1);
  }

  // Kill existing processes from saved state
  const state = await ServiceManager.loadState();
  const toRestart = killAll
    ? Object.keys(config.services)
    : [target!];

  for (const name of toRestart) {
    if (state[name]) killServiceByPid(name, state[name]!);
  }

  // Brief wait for processes to exit
  await new Promise((r) => setTimeout(r, 1000));

  // Start services through ServiceManager (with readiness checks + state persistence)
  // Stdio services are owned by the transport in the running mcpd instance —
  // they restart automatically when mcpd reconnects.
  const manager = new ServiceManager();
  for (const name of toRestart) {
    const svc = config.services[name];
    if (!svc?.command) continue;
    if (svc.transport === "stdio") {
      console.log(`${name}: stdio service — restart mcpd to reconnect`);
      continue;
    }
    console.log(`${name}: starting...`);
    await manager.start(name, svc);
    console.log(`${name}: started (${manager.getState(name)})`);
  }
}

// -- CLI --

function printHelp() {
  console.log(`mcpd — MCP service daemon

Usage: mcpd [command] [options]

Commands:
  start              Start mcpd and all configured services (default)
  proxy              Bridge a stdio MCP server to HTTP/SSE
  ps, list, ls       List running services with PIDs
  kill [name|all]    Kill a service or all services
  restart [name|all] Restart a service or all services
  stop               Kill everything (mcpd + all services)
  help               Show this help message

Options:
  -c, --config <path>  Path to config file (default: mcpd.yml)
  --help               Show this help message

Proxy options:
  -p, --port <port>    Port to listen on (0 for random)
  -n, --name <name>    Service name for state tracking (default: derived from command)
  --restart <policy>   Restart policy: on-failure, always, never (default: on-failure)
  --                   Separator between mcpd flags and the child command

Example:
  mcpd proxy -p 8766 -- uvx run serena serena-mcp-server`);
}

// Split argv at "--" to separate mcpd flags from child command (for proxy)
const rawArgs = Bun.argv.slice(2);
const ddIndex = rawArgs.indexOf("--");
const mcpdArgs = ddIndex === -1 ? rawArgs : rawArgs.slice(0, ddIndex);
const childArgs = ddIndex === -1 ? [] : rawArgs.slice(ddIndex + 1);

const { values, positionals } = parseArgs({
  args: mcpdArgs,
  options: {
    config: { type: "string", short: "c" },
    help: { type: "boolean" },
    port: { type: "string", short: "p" },
    name: { type: "string", short: "n" },
    restart: { type: "string" },
  },
  allowPositionals: true,
});

const [command, target] = positionals;
const configPath = values.config;

if (values.help) {
  printHelp();
  process.exit(0);
}

switch (command) {
  case "help":
    printHelp();
    break;
  case "proxy": {
    if (!childArgs.length) {
      console.error("Usage: mcpd proxy -p <port> -- <command> [args...]");
      process.exit(1);
    }
    const port = parseInt(values.port ?? "0", 10);
    if (isNaN(port) || port < 0 || port > 65535) {
      console.error(`Invalid port: ${values.port}`);
      process.exit(1);
    }
    const validRestartPolicies = ["on-failure", "always", "never"] as const;
    const restartPolicy = values.restart as typeof validRestartPolicies[number] | undefined;
    if (restartPolicy && !validRestartPolicies.includes(restartPolicy)) {
      console.error(`Invalid restart policy: ${values.restart} (must be on-failure, always, or never)`);
      process.exit(1);
    }
    startProxy({
      port,
      name: values.name,
      command: childArgs[0]!,
      args: childArgs.slice(1),
      restart: restartPolicy,
    }).catch((err) => {
      log.error(err, "proxy failed");
      console.error("proxy failed:", err.message);
      process.exit(1);
    });
    break;
  }
  case "ps":
  case "list":
  case "ls":
    cmdPs().catch((err) => {
      log.error(err, "ps failed");
      console.error("ps failed:", err.message);
      process.exit(1);
    });
    break;
  case "kill":
    cmdKill(target).catch((err) => {
      log.error(err, "kill failed");
      console.error("kill failed:", err.message);
      process.exit(1);
    });
    break;
  case "restart":
    cmdRestart(target, configPath).catch((err) => {
      log.error(err, "restart failed");
      console.error("restart failed:", err.message);
      process.exit(1);
    });
    break;
  case "stop":
    cmdKill("all").catch((err) => {
      log.error(err, "stop failed");
      console.error("stop failed:", err.message);
      process.exit(1);
    });
    break;
  case "start":
  default:
    cmdStart(configPath).catch((err) => {
      log.error(err, "mcpd failed to start");
      console.error("mcpd failed to start:", err.message);
      process.exit(1);
    });
    break;
}
