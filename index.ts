import { loadConfig } from "./config.ts";
import { ServiceManager } from "./service-manager.ts";
import { BackendClient } from "./sse-client.ts";
import { ToolAggregator } from "./aggregator.ts";
import { createServer } from "./server.ts";
import { resolveMiddleware, type McpMiddleware } from "./middleware.ts";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";

const PID_FILE = join(process.cwd(), ".mcpd.pid");

async function start(configPath?: string) {
  const config = loadConfig(configPath);
  const manager = new ServiceManager();
  const aggregator = new ToolAggregator();
  const allMiddlewares: McpMiddleware[] = [];

  // Write PID file
  writeFileSync(PID_FILE, String(process.pid));

  // Cleanup on exit
  const cleanup = async () => {
    await manager.stopAll();
    try {
      unlinkSync(PID_FILE);
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  // Start all services and wait for readiness
  await manager.startAll(config);

  // Connect SSE clients to ready backends
  for (const [name, svc] of Object.entries(config.services)) {
    if (svc.transport === "sse" && svc.url) {
      const client = new BackendClient(name);
      await client.connect(svc.url);
      aggregator.addBackend(name, client);
    }

    // Collect middlewares
    if (svc.middleware?.response) {
      allMiddlewares.push(...resolveMiddleware(svc.middleware.response));
    }
  }

  // Start the stdio server facing Claude Code
  await createServer(aggregator, allMiddlewares);
}

function stop() {
  if (!existsSync(PID_FILE)) {
    console.error("mcpd is not running (no PID file found)");
    process.exit(1);
  }
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to mcpd (PID ${pid})`);
  } catch (e: any) {
    if (e.code === "ESRCH") {
      console.error(`mcpd process (PID ${pid}) not found, cleaning up PID file`);
      unlinkSync(PID_FILE);
    } else {
      throw e;
    }
  }
}

function status() {
  if (!existsSync(PID_FILE)) {
    console.log("mcpd is not running");
    return;
  }
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
  try {
    // signal 0 checks if process exists
    process.kill(pid, 0);
    console.log(`mcpd is running (PID ${pid})`);
  } catch {
    console.log("mcpd is not running (stale PID file)");
    unlinkSync(PID_FILE);
  }
}

const command = process.argv[2];
const configFlag = process.argv.indexOf("--config");
const configPath =
  configFlag !== -1 ? process.argv[configFlag + 1] : undefined;

switch (command) {
  case "stop":
    stop();
    break;
  case "status":
    status();
    break;
  case "restart":
    stop();
    // Give time for graceful shutdown, then start
    setTimeout(() => start(configPath), 1000);
    break;
  case "start":
  default:
    start(configPath).catch((err) => {
      console.error("mcpd failed to start:", err.message);
      process.exit(1);
    });
    break;
}
