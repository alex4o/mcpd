import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ServiceManager } from "./service-manager.ts";
import log from "./logger.ts";

export interface ProxyOptions {
  port: number;
  name?: string;
  command: string;
  args: string[];
  restart?: "on-failure" | "always" | "never";
}

export async function startProxy(opts: ProxyOptions): Promise<void> {
  const { port, command, args, restart = "on-failure" } = opts;
  const name = opts.name ?? command.split("/").pop() ?? "proxy";
  const plog = log.child({ proxy: name });

  // 1. Spawn the stdio backend and connect as MCP client
  const stdioTransport = new StdioClientTransport({
    command,
    args,
    stderr: "ignore",
  });
  const client = new Client({ name: `proxy-${name}`, version: "1.0.0" });
  await client.connect(stdioTransport);
  plog.info({ command, args }, "stdio backend connected");

  // Detect backend capabilities for forwarding
  const caps = client.getServerCapabilities?.() ?? {};

  // 2. Track active SSE sessions
  const sessions = new Map<string, SSEServerTransport>();

  // 3. Per-session MCP Server wired to the shared client
  function createSessionServer(): Server {
    const serverCaps: Record<string, object> = {};
    if (caps.tools) serverCaps.tools = {};
    if (caps.resources) serverCaps.resources = {};
    if (caps.prompts) serverCaps.prompts = {};
    // If no caps detected, at least expose tools
    if (Object.keys(serverCaps).length === 0) serverCaps.tools = {};

    const server = new Server(
      { name: `mcpd-proxy-${name}`, version: "1.0.0" },
      { capabilities: serverCaps }
    );

    // Always forward tools
    server.setRequestHandler(ListToolsRequestSchema, () => client.listTools());
    server.setRequestHandler(CallToolRequestSchema, (req) =>
      client.callTool({
        name: req.params.name,
        arguments: req.params.arguments ?? {},
      })
    );

    // Forward resources if supported
    if (caps.resources) {
      server.setRequestHandler(ListResourcesRequestSchema, () =>
        client.listResources()
      );
      server.setRequestHandler(ListResourceTemplatesRequestSchema, () =>
        client.listResourceTemplates()
      );
      server.setRequestHandler(ReadResourceRequestSchema, (req) =>
        client.readResource({ uri: req.params.uri })
      );
    }

    // Forward prompts if supported
    if (caps.prompts) {
      server.setRequestHandler(ListPromptsRequestSchema, () =>
        client.listPrompts()
      );
      server.setRequestHandler(GetPromptRequestSchema, (req) =>
        client.getPrompt({
          name: req.params.name,
          arguments: req.params.arguments,
        })
      );
    }

    return server;
  }

  // 4. Start HTTP server
  const httpServer = createHttpServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      // Health check
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200).end("ok");
        return;
      }

      // SSE endpoint — new session
      if (req.method === "GET" && url.pathname === "/sse") {
        const transport = new SSEServerTransport("/message", res);
        sessions.set(transport.sessionId, transport);
        plog.info({ sessionId: transport.sessionId }, "new SSE session");

        transport.onclose = () => {
          sessions.delete(transport.sessionId);
          plog.info({ sessionId: transport.sessionId }, "SSE session closed");
        };

        const server = createSessionServer();
        await server.connect(transport);
        return;
      }

      // Message endpoint — route POST to correct session
      if (req.method === "POST" && url.pathname === "/message") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId || !sessions.has(sessionId)) {
          res.writeHead(404).end("Session not found");
          return;
        }
        await sessions.get(sessionId)!.handlePostMessage(req, res);
        return;
      }

      res.writeHead(404).end("Not found");
    }
  );

  // Determine actual port (supports port 0 for random assignment)
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
  const actualPort =
    (httpServer.address() as { port: number })?.port ?? port;

  plog.info({ port: actualPort }, "proxy HTTP server listening");
  console.log(
    `proxy '${name}' listening on http://localhost:${actualPort}/sse`
  );

  // 5. Register in .mcpd-state.json
  const manager = new ServiceManager();
  await manager.registerProxy(name, process.pid, `http://localhost:${actualPort}/sse`);

  // 6. Cleanup on exit
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    plog.info("shutting down proxy");
    for (const [, transport] of sessions) {
      await transport.close().catch(() => {});
    }
    await client.close().catch(() => {});
    httpServer.close();
    await manager.removeProxy(name);
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  // 7. Handle child process crash + restart
  function attachRestartHandler(transport: StdioClientTransport): void {
    transport.onclose = () => {
      plog.warn("stdio backend disconnected");
      if (restart === "never") {
        plog.info("restart policy: never, exiting proxy");
        cleanup();
        return;
      }
      attemptReconnect(1000);
    };
  }

  function attemptReconnect(delayMs: number): void {
    const MAX_DELAY = 30_000;
    setTimeout(async () => {
      plog.info({ delayMs }, "restarting stdio backend");
      const newTransport = new StdioClientTransport({
        command,
        args,
        stderr: "ignore",
      });
      try {
        await client.connect(newTransport);
        attachRestartHandler(newTransport);
        plog.info("stdio backend reconnected");
      } catch (err) {
        plog.error(err, "failed to restart stdio backend");
        if (restart === "on-failure") {
          cleanup();
        } else if (restart === "always") {
          const nextDelay = Math.min(delayMs * 2, MAX_DELAY);
          plog.info({ nextDelay }, "will retry reconnect");
          attemptReconnect(nextDelay);
        }
      }
    }, delayMs);
  }

  attachRestartHandler(stdioTransport);
}
