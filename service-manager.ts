import type { Subprocess } from "bun";
import type { ServiceConfig, McpdConfig } from "./config.ts";

export type ServiceState = "stopped" | "starting" | "ready" | "error";

interface ManagedService {
  proc: Subprocess;
  config: ServiceConfig;
}

export class ServiceManager {
  private services = new Map<string, ManagedService>();
  private states = new Map<string, ServiceState>();

  async start(name: string, config: ServiceConfig): Promise<void> {
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
        const currentState = this.states.get(name);
        // Don't overwrite "ready" state — the launcher script may exit
        // while the actual backend keeps running (e.g., backgrounded process)
        if (currentState === "ready") return;
        if (exitCode !== 0 && exitCode !== null) {
          this.states.set(name, "error");
          if (config.restart === "on-failure" || config.restart === "always") {
            this.start(name, config).catch(() => {});
          }
        } else {
          if (config.restart === "always") {
            this.start(name, config).catch(() => {});
          } else if (currentState !== "starting") {
            // Only set stopped if we're not still in the readiness check phase
            this.states.set(name, "stopped");
          }
        }
      },
    });

    this.services.set(name, { proc, config });

    if (config.transport === "sse" && config.readiness.check === "http") {
      await this.waitForReady(name, config);
    }

    this.states.set(name, "ready");
  }

  async stop(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) return;

    // Temporarily set restart to never so onExit doesn't restart
    const origRestart = svc.config.restart;
    svc.config.restart = "never";

    svc.proc.kill("SIGTERM");

    // Wait up to 5s for graceful exit
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
    this.states.set(name, "stopped");
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
    await Promise.all(
      entries.map(([name, svc]) => this.start(name, svc))
    );
  }

  async stopAll(): Promise<void> {
    const names = [...this.services.keys()];
    await Promise.all(names.map((name) => this.stop(name)));
  }

  getState(name: string): ServiceState {
    return this.states.get(name) ?? "stopped";
  }

  getAll(): Array<{ name: string; state: ServiceState; pid?: number }> {
    const all = new Set([...this.services.keys(), ...this.states.keys()]);
    return [...all].map((name) => ({
      name,
      state: this.getState(name),
      pid: this.services.get(name)?.proc.pid,
    }));
  }

  private async waitForReady(
    name: string,
    config: ServiceConfig
  ): Promise<void> {
    const url = config.readiness.url ?? config.url;
    if (!url) throw new Error(`Service '${name}': no URL for readiness check`);

    const deadline = Date.now() + config.readiness.timeout;

    while (Date.now() < deadline) {
      try {
        const controller = new AbortController();
        const resp = await fetch(url, { signal: controller.signal });
        // Abort immediately — we only need the status code, not the body
        // (SSE endpoints would keep the connection open forever)
        controller.abort();
        if (resp.ok) return;
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, config.readiness.interval));
    }

    this.states.set(name, "error");
    throw new Error(
      `Service '${name}' readiness check timed out after ${config.readiness.timeout}ms`
    );
  }
}
