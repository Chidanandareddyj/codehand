import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/mcp/server.js";
import { INSTRUCTIONS } from "../../src/mcp/instructions.js";
import { isolate, stopJobs, useFake } from "../support.js";

const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const cli = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const TOOLS = [
  "check_coding_task",
  "coding_agents",
  "finish_coding_task",
  "get_coding_task_output",
  "reply_to_coding_task",
  "setup_coding_agent",
  "start_coding_task",
];

afterEach(() => {
  stopJobs();
});

async function rpc(
  client: { onmessage?: (message: unknown) => void; send: (message: unknown) => Promise<void> },
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no response for ${id}`)), 20_000);
    client.onmessage = (message: unknown) => {
      if (message && typeof message === "object" && "id" in message && message.id === id) {
        clearTimeout(timer);
        client.onmessage = undefined;
        resolve(message as Record<string, unknown>);
      }
    };
  });
  await client.send({ jsonrpc: "2.0", id, method, params });
  return reply;
}

describe("MCP server", () => {
  it("lists the seven tools and the bot instructions", async () => {
    const [client, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    await client.start();

    const initialized = await rpc(client, 1, "initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "codehand-test", version: "0.0.0" },
    });
    const initResult = initialized.result as { instructions?: string } | undefined;
    expect(initResult?.instructions).toBe(INSTRUCTIONS);
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const tools = await rpc(client, 2, "tools/list");
    const names = ((tools.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map(
      (tool) => tool.name,
    );
    expect(names.sort()).toEqual([...TOOLS].sort());
    await server.close();
  });

  it("returns an envelope with next from coding_agents", async () => {
    isolate();
    useFake();
    const [client, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    await client.start();
    await rpc(client, 1, "initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "codehand-test", version: "0.0.0" },
    });
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const called = await rpc(client, 2, "tools/call", { name: "coding_agents", arguments: {} });
    const result = called.result as {
      content?: { type: string; text: string }[];
      structuredContent?: { ok?: boolean; next?: string };
    };
    expect(result.content?.[0]?.type).toBe("text");
    expect(result.structuredContent?.ok).toBe(true);
    expect(result.structuredContent?.next).toBeTruthy();
    expect((result.content?.[0]?.text ?? "").length).toBeLessThanOrEqual(1200);
    await server.close();
  });

  it("writes only JSON-RPC on stdout", async () => {
    const { home, work } = isolate();
    useFake();
    const child = spawn(process.execPath, [tsx, cli], {
      env: { ...process.env, CODEHAND_HOME: home, CODEHAND_WORK: work },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const waitForId = (id: number) =>
      new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          const hit = stdout.split(/\r?\n/).some((line) => {
            if (!line.trim()) return false;
            try {
              const parsed = JSON.parse(line) as { id?: number };
              return parsed.id === id;
            } catch {
              return false;
            }
          });
          if (hit) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - started > 15_000) {
            clearInterval(timer);
            reject(new Error(`stdout never contained id ${id}: ${stdout}`));
          }
        }, 50);
      });
    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "codehand-test", version: "0.0.0" },
        },
      })}\n`,
    );
    await waitForId(1);
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await waitForId(2);
    const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      expect(parsed.jsonrpc).toBe("2.0");
    }
    child.kill();
  }, 20_000);
});

describe("CLI", () => {
  it("lists the verbs from the plan", () => {
    const result = spawnSync(process.execPath, [tsx, cli, "--help"], { encoding: "utf8", windowsHide: true });
    const text = `${result.stdout}\n${result.stderr}`;
    for (const verb of [
      "agents",
      "setup",
      "start",
      "check",
      "reply",
      "output",
      "finish",
      "gc",
      "install-skill",
    ]) {
      expect(text).toContain(verb);
    }
  });
});
