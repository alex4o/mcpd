import type { Subprocess } from "bun";
import type { ServiceConfig, McpdConfig } from "./config.ts";
import { findProjectRoot } from "./config.ts";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";

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
  } catch {
    clearTimeout(timer);
    return false;
  }
}

export class ServiceManager {
  private services = new Map<string, ManagedService>();
  private states = new Map<string, ServiceState>();
  private pids = new Map<string, number>();
  private urls = new Map<string, string>();

  async start(name: string, config: ServiceConfig): Promise<void> {
    if (config.url) this.urls.set(name, config.url);

    // Check if already running — reuse existing instance
    if (config.transport === "sse" && config.url) {
      const checkUrl = config.readiness?.url ?? config.url;

      // Check state file for existing pid
      const saved = ServiceManager.loadState()[name];
      if (saved?.pid && pidAlive(saved.pid)) {
        if (await isReachable(checkUrl)) {
          this.pids.set(name, saved.pid);
          this.states.set(name, "ready");
          this.saveState();
          return;
        }
      }

      // No saved pid, but service might still be reachable (started externally)
      if (await isReachable(checkUrl)) {
        this.states.set(name, "ready");
        this.saveState();
        return;
      }
    }

    if (this.services.has(name)) {
      throw new Error(`Service '${name}' is already running`);
    }

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
          this.states.set(name, "error");
          this.saveState();
          if (config.restart === "on-failure" || config.restart === "always") {
            this.start(name, config).catch(() => {});
          }
          return;
        }
        if (exitCode !== 0 && exitCode !== null) {
          this.states.set(name, "error");
          this.saveState();
          if (config.restart === "on-failure" || config.restart === "always") {
            this.start(name, config).catch(() => {});
          }
        } else {
          if (config.restart === "always") {
            this.start(name, config).catch(() => {});
          } else if (currentState !== "starting") {
            this.states.set(name, "stopped");
            this.saveState();
          }
        }
      },
    });

    this.services.set(name, { proc, config });
    this.pids.set(name, proc.pid);

    if (config.transport === "sse" && config.readiness.check === "http") {
      try {
        await this.waitForReady(name, config);
      } catch (err) {
        // Kill the orphaned process before re-throwing
        await this.stop(name);
        this.states.set(name, "error");
        this.saveState();
        throw err;
      }
    }

    this.states.set(name, "ready");
    this.saveState();
  }

  async stop(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) return;

    const origRestart = svc.config.restart;
    svc.config.restart = "never";

    svc.proc.kill("SIGTERM");

    const exited = await Promise.race([
      svc.proc.exited.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 5000)),
    ]);

    if (!exited) {
      svc.proc.kill("SIGKILL");
      await svc.proc.exited;
    }

    svc.config.restart = origRestart;
    this.services.delete(name);
    this.pids.delete(name);
    this.states.set(name, "stopped");
    this.saveState();
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

  // -- state persistence --

  private saveState(): void {
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
    } catch {}
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
    } catch {
      return {};
    }
  }

  // -- readiness --

  private async waitForReady(name: string, config: ServiceConfig): Promise<void> {
    const url = config.readiness.url ?? config.url;
    if (!url) throw new Error(`Service '${name}': no URL for readiness check`);

    const deadline = Date.now() + config.readiness.timeout;

    while (Date.now() < deadline) {
      if (await isReachable(url)) return;
      await new Promise((r) => setTimeout(r, config.readiness.interval));
    }

    this.states.set(name, "error");
    throw new Error(
      `Service '${name}' readiness check timed out after ${config.readiness.timeout}ms`
    );
  }
}
