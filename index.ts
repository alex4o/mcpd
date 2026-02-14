import { parseArgs } from "util";
import { loadConfig, findProjectRoot } from "./config.ts";
import { ServiceManager, pidAlive } from "./service-manager.ts";
import { BackendClient } from "./sse-client.ts";
import { ToolAggregator } from "./aggregator.ts";
import { createServer } from "./server.ts";
import { resolveMiddleware, type McpMiddleware } from "./middleware.ts";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";

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
  const manager = new ServiceManager();
  const aggregator = new ToolAggregator();
  const serviceMiddlewares = new Map<string, McpMiddleware[]>();
  const clients: BackendClient[] = [];

  const cleanup = async () => {
    // Disconnect all backend clients (stdio clients kill their child process)
    await Promise.all(clients.map((c) => c.disconnect().catch(() => {})));
    // Only stop services that don't have keep_alive set
    for (const [name, svc] of Object.entries(config.services)) {
      if (!svc.keep_alive) {
        await manager.stop(name);
      }
    }
    try { unlinkSync(PID_FILE); } catch {}
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
  writeFileSync(PID_FILE, String(process.pid));

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
        manager.registerPid(name, client.pid);
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

function cmdPs() {
  // mcpd itself
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    console.log(`mcpd         pid=${pid}  ${pidAlive(pid) ? "running" : "dead (stale pid)"}`);
  } else {
    console.log("mcpd         not running");
  }

  // services from saved state
  const state = ServiceManager.loadState();
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

function cmdKill(target?: string) {
  const state = ServiceManager.loadState();

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
  if (killAll && existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    try { process.kill(pid, "SIGTERM"); console.log(`mcpd: killed ${pid}`); } catch {}
    try { unlinkSync(PID_FILE); } catch {}
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
  const state = ServiceManager.loadState();
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
  ps, list, ls       List running services with PIDs
  kill [name|all]    Kill a service or all services
  restart [name|all] Restart a service or all services
  stop               Kill everything (mcpd + all services)
  help               Show this help message

Options:
  -c, --config <path>  Path to config file (default: mcpd.yml)
  --help               Show this help message`);
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    config: { type: "string", short: "c" },
    help: { type: "boolean" },
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
  case "ps":
  case "list":
  case "ls":
    cmdPs();
    break;
  case "kill":
    cmdKill(target);
    break;
  case "restart":
    cmdRestart(target, configPath).catch((err) => {
      console.error("restart failed:", err.message);
      process.exit(1);
    });
    break;
  case "stop":
    cmdKill("all");
    break;
  case "start":
  default:
    cmdStart(configPath).catch((err) => {
      console.error("mcpd failed to start:", err.message);
      process.exit(1);
    });
    break;
}
