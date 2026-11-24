#!/usr/bin/env node
import { log } from "../core/log.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "__run") {
    const { runTurn } = await import("../core/runner.js");
    const code = await runTurn(args[1] ?? "", Number(args[2] ?? "1"));
    process.exit(code);
  }
  if (args.length === 0) {
    const { startMcp } = await import("../mcp/server.js");
    await startMcp();
    return;
  }
  const { runCli } = await import("./commands.js");
  await runCli();
}

main().catch((error: unknown) => {
  log("error", error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
