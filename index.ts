import { parseArgs } from "util";
import { loadConfig } from "./config.ts";
import { ServiceManager, pidAlive } from "./service-manager.ts";
import { BackendClient } from "./sse-client.ts";
import { ToolAggregator } from "./aggregator.ts";
import { createServer } from "./server.ts";
import { resolveMiddleware, type McpMiddleware } from "./middleware.ts";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";

const PID_FILE = join(process.cwd(), ".mcpd.pid");

// -- commands --

async function cmdStart(configPath?: string) {
  const config = loadConfig(configPath);
  const manager = new ServiceManager();
  const aggregator = new ToolAggregator();
  const allMiddlewares: McpMiddleware[] = [];

  const cleanup = async () => {
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

  await manager.startAll(config);

  // Write PID file only after successful startup
  writeFileSync(PID_FILE, String(process.pid));

  for (const [name, svc] of Object.entries(config.services)) {
    if (svc.transport === "sse" && svc.url) {
      const client = new BackendClient(name);
      await client.connect(svc.url);
      aggregator.addBackend(name, client);
    }
    if (svc.middleware?.response) {
      allMiddlewares.push(...resolveMiddleware(svc.middleware.response));
    }
  }

  await createServer(aggregator, allMiddlewares);
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

  const toKill = killAll ? state : { [target!]: state[target!] };

  for (const [name, info] of Object.entries(toKill)) {
    if (!info?.pid) {
      console.log(`${name}: no pid tracked`);
      continue;
    }
    if (!pidAlive(info.pid)) {
      console.log(`${name}: pid ${info.pid} already dead`);
      continue;
    }
    try {
      process.kill(info.pid, "SIGTERM");
      console.log(`${name}: killed ${info.pid}`);
    } catch (e: any) {
      console.log(`${name}: ${e.code === "ESRCH" ? "already gone" : e.message}`);
    }
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
    const info = state[name];
    if (info?.pid && pidAlive(info.pid)) {
      try {
        process.kill(info.pid, "SIGTERM");
        console.log(`${name}: killed pid ${info.pid}`);
      } catch {}
    }
  }

  // Brief wait for processes to exit
  await new Promise((r) => setTimeout(r, 1000));

  // Start services through ServiceManager (with readiness checks + state persistence)
  const manager = new ServiceManager();
  for (const name of toRestart) {
    const svc = config.services[name];
    if (!svc?.command) continue;
    console.log(`${name}: starting...`);
    await manager.start(name, svc);
    console.log(`${name}: started (${manager.getState(name)})`);
  }
}

// -- CLI --

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    config: { type: "string", short: "c" },
  },
  allowPositionals: true,
});

const [command, target] = positionals;
const configPath = values.config;

switch (command) {
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
