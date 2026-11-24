import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { registerTools } from "./tools.js";
import { INSTRUCTIONS } from "./instructions.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({ name: "codehand", version: pkg.version }, { instructions: INSTRUCTIONS });
  registerTools(server);
  return server;
}

export async function startMcp(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
