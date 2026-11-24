import fs from "node:fs";
import { codehandHome, logPath } from "./config.js";
import { redact } from "./redact.js";

export function log(level: "info" | "error", message: string): void {
  const line = redact(`${new Date().toISOString()} ${level} ${message}`);
  try {
    fs.mkdirSync(codehandHome(), { recursive: true });
    fs.appendFileSync(logPath(), `${line}\n`);
  } catch {
    /* a log failure must not break a task */
  }
  process.stderr.write(`${line}\n`);
}
