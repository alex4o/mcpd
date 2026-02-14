// A tiny MCP server over stdio for integration testing.
// Registers simple "echo" and "greet" tools.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const mcpServer = new McpServer({ name: "test-backend", version: "1.0.0" });

mcpServer.tool(
  "echo",
  "Echoes input back",
  { message: z.string() },
  async ({ message }) => ({
    content: [{ type: "text", text: message }],
  })
);

mcpServer.tool(
  "greet",
  "Greets by name",
  { name: z.string() },
  async ({ name }) => ({
    content: [{ type: "text", text: `Hello, ${name}!` }],
  })
);

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
