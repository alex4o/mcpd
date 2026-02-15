import type { Subprocess } from "bun";
import type { ServiceConfig, McpdConfig } from "./config.ts";
import { findProjectRoot } from "./config.ts";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import log from "./logger.ts";

export type ServiceState = "stopped" | "starting" | "ready" | "error";

const STATE_FILE = join(findProjectRoot(), ".mcpd-state.json");

export interface ServiceInfo {
  name: string;
  state: ServiceState;
  pid?: number;
  url?: string;
}

interface ManagedService {
  proc: Subprocess;
  config: ServiceConfig;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isReachable(url: string, timeoutMs = 5000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    controller.abort(); // Stop reading body (SSE streams stay open)
    clearTimeout(timer);
    return resp.ok;
  } catch (err) {
    clearTimeout(timer);
    log.debug({ url, error: (err as Error).message }, "reachability check failed");
    return false;
  }
}

/** Resolve the effective port from a URL (handles implicit 80/443). */
function resolvePort(url: string): string | null {
  const parsed = new URL(url);
  if (parsed.port) return parsed.port;
  if (parsed.protocol === "https:") return "443";
  if (parsed.protocol === "http:") return "80";
  return null;
}

/** Get a process command line, preferring /proc and falling back to ps. */
function getCommandLine(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ").trim();
  } catch {
    try {
      return execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8" }).trim();
    } catch {
      return null;
    }
  }
}

/**
 * Try to find the PID of the process listening on the given URL's port.
 * When commandHints are provided, only returns a PID whose command line
 * contains at least one hint — prevents misattributing unrelated processes.
 * Passing both command and args as hints handles wrapper launchers (e.g. uv)
 * where the listener process differs from the configured command.
 */
function findPidByPort(url: string, commandHints?: string[]): number | null {
  try {
    const port = resolvePort(url);
    if (!port) return null;
    const out = execSync(`lsof -ti :${port} -sTCP:LISTEN`, { encoding: "utf-8" }).trim();
    const pids = out.split("\n").map(s => parseInt(s, 10)).filter(Number.isFinite);
    if (pids.length === 0) return null;

    if (!commandHints?.length) return pids[0]!;

    for (const pid of pids) {
      const cmdline = getCommandLine(pid);
      if (cmdline && commandHints.some(hint => cmdline.includes(hint))) return pid;
    }

    // Command verification requested but not proven; fail closed.
    return null; // No PID matched any hint
  } catch {
    return null;
  }
}

export class ServiceManager {
  private services = new Map<string, ManagedService>();
  private states = new Map<string, ServiceState>();
  private pids = new Map<string, number>();
  private urls = new Map<string, string>();

  async start(name: string, config: ServiceConfig): Promise<void> {
    const slog = log.child({ service: name });
    if (config.url) this.urls.set(name, config.url);

    // Check if already running — reuse existing instance
    if (config.transport === "sse" && config.url) {
      const checkUrl = config.readiness?.url ?? config.url;
      const saved = ServiceManager.loadState()[name];

      if (saved?.pid && pidAlive(saved.pid) && await isReachable(checkUrl)) {
        slog.info({ pid: saved.pid }, "reusing existing instance");
        this.pids.set(name, saved.pid);
        this.states.set(name, "ready");
        this.saveState();
        return;
      }

      // No saved pid, but service might still be reachable (started externally)
      if (await isReachable(checkUrl)) {
        // Try to recover the PID via port lookup with command validation
        const pid = findPidByPort(checkUrl, [config.command, ...config.args]);
        if (pid) this.pids.set(name, pid);
        slog.info({ pid: pid ?? undefined }, "reusing externally-started instance");
        this.states.set(name, "ready");
        this.saveState();
        return;
      }
    }

    if (this.services.has(name)) {
      throw new Error(`Service '${name}' is already running`);
    }

    slog.info({ command: config.command, args: config.args }, "starting service");
    this.states.set(name, "starting");

    const proc = Bun.spawn([config.command, ...config.args], {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdout: "ignore",
      stderr: "ignore",
      onExit: (_proc, exitCode) => {
        this.services.delete(name);
        this.pids.delete(name);
        const currentState = this.states.get(name);
        if (currentState === "ready") {
          slog.error({ exitCode }, "service crashed while ready");
          this.states.set(name, "error");
          this.saveState();
          if (config.restart === "on-failure" || config.restart === "always") {
            slog.info("restarting after crash");
            this.start(name, config).catch((e) => slog.error(e, "restart failed"));
          }
          return;
        }
        if (exitCode !== 0 && exitCode !== null) {
          slog.error({ exitCode }, "service exited with error");
          this.states.set(name, "error");
          this.saveState();
          if (config.restart === "on-failure" || config.restart === "always") {
            slog.info("restarting after failure");
            this.start(name, config).catch((e) => slog.error(e, "restart failed"));
          }
        } else {
          if (config.restart === "always") {
            slog.info("restarting (always policy)");
            this.start(name, config).catch((e) => slog.error(e, "restart failed"));
          } else if (currentState !== "starting") {
            slog.info("service stopped cleanly");
            this.states.set(name, "stopped");
            this.saveState();
          }
        }
      },
    });

    this.services.set(name, { proc, config });
    this.pids.set(name, proc.pid);
    slog.info({ pid: proc.pid }, "process spawned");

    if (config.transport === "sse" && config.readiness.check === "http") {
      try {
        await this.waitForReady(name, config);
      } catch (err) {
        slog.error(err as Error, "readiness check failed");
        // Kill the orphaned process before re-throwing
        await this.stop(name);
        this.states.set(name, "error");
        this.saveState();
        throw err;
      }
    }

    slog.info("service ready");
    this.states.set(name, "ready");
    this.saveState();
  }

  async stop(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) return;

    const slog = log.child({ service: name, pid: svc.proc.pid });
    const origRestart = svc.config.restart;
    svc.config.restart = "never";

    slog.info("sending SIGTERM");
    svc.proc.kill("SIGTERM");

    const exited = await Promise.race([
      svc.proc.exited.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 5000)),
    ]);

    if (!exited) {
      slog.warn("SIGTERM timeout, escalating to SIGKILL");
      svc.proc.kill("SIGKILL");
      await svc.proc.exited;
    }

    svc.config.restart = origRestart;
    this.services.delete(name);
    this.pids.delete(name);
    this.states.set(name, "stopped");
    this.saveState();
    slog.info("service stopped");
  }

  async restart(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) throw new Error(`Service '${name}' is not running`);
    const config = svc.config;
    await this.stop(name);
    await this.start(name, config);
  }

  async startAll(config: McpdConfig): Promise<void> {
    const entries = Object.entries(config.services);
    const results = await Promise.allSettled(
      entries.map(([name, svc]) => this.start(name, svc))
    );

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      // Roll back: stop any services that started successfully
      await Promise.all(
        entries
          .filter((_, i) => results[i]!.status === "fulfilled")
          .map(([name]) => this.stop(name))
      );
      const reasons = failed.map((r) => (r as PromiseRejectedResult).reason?.message ?? r);
      throw new Error(`Failed to start services: ${reasons.join("; ")}`);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.services.keys()].map((name) => this.stop(name))
    );
    this.cleanupState();
  }

  getState(name: string): ServiceState {
    return this.states.get(name) ?? "stopped";
  }

  getAll(): ServiceInfo[] {
    const all = new Set([...this.services.keys(), ...this.states.keys()]);
    return [...all].map((name) => ({
      name,
      state: this.getState(name),
      pid: this.pids.get(name),
      url: this.urls.get(name),
    }));
  }

  /** Register a PID for a service not directly managed by ServiceManager (e.g. stdio backends). */
  registerPid(name: string, pid: number): void {
    this.pids.set(name, pid);
    this.states.set(name, this.states.get(name) ?? "ready");
    this.saveState();
  }

  // -- state persistence --

  saveState(): void {
    const state: Record<string, Omit<ServiceInfo, "name">> = {};
    const all = new Set([...this.services.keys(), ...this.states.keys()]);
    for (const name of all) {
      state[name] = {
        state: this.getState(name),
        pid: this.pids.get(name),
        url: this.urls.get(name),
      };
    }
    try {
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      log.error(err as Error, "failed to save state");
    }
  }

  private cleanupState(): void {
    try { unlinkSync(STATE_FILE); } catch {}
  }

  static loadState(): Record<string, ServiceInfo> {
    if (!existsSync(STATE_FILE)) return {};
    try {
      const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
      const result: Record<string, ServiceInfo> = {};
      for (const [name, info] of Object.entries(raw as Record<string, any>)) {
        result[name] = { name, ...info };
      }
      return result;
    } catch (err) {
      log.warn(err as Error, "failed to load state");
      return {};
    }
  }

  // -- readiness --

  private async waitForReady(name: string, config: ServiceConfig): Promise<void> {
    const url = config.readiness.url ?? config.url;
    if (!url) throw new Error(`Service '${name}': no URL for readiness check`);

    const slog = log.child({ service: name });
    slog.info({ url, timeout: config.readiness.timeout }, "polling for readiness");

    const deadline = Date.now() + config.readiness.timeout;

    while (Date.now() < deadline) {
      if (await isReachable(url)) return;
      await new Promise((r) => setTimeout(r, config.readiness.interval));
    }

    this.states.set(name, "error");
    slog.error({ url, timeout: config.readiness.timeout }, "readiness check timed out");
    throw new Error(
      `Service '${name}' readiness check timed out after ${config.readiness.timeout}ms`
    );
  }
}
