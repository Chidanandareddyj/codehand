import fs from "node:fs";
import path from "node:path";
import { isAlive } from "./proc.js";

const STALE_MS = 15_000;
const ANCIENT_MS = 5 * 60_000;

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function replaceFile(tmp: string, file: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "EEXIST") {
        fs.rmSync(tmp, { force: true });
        throw error;
      }
      try {
        fs.copyFileSync(tmp, file);
        fs.rmSync(tmp, { force: true });
        return;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
  }
  fs.rmSync(tmp, { force: true });
  throw lastError;
}

export function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  replaceFile(tmp, file);
}

export function atomicWriteText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  replaceFile(tmp, file);
}

export function appendLine(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line.endsWith("\n") ? line : `${line}\n`);
}

export async function withFileLock<T>(lockFile: string, fn: () => Promise<T> | T): Promise<T> {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const started = Date.now();
  for (;;) {
    const lockToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(fd, lockToken);
      fs.closeSync(fd);
      try {
        return await fn();
      } finally {
        try {
          if (fs.readFileSync(lockFile, "utf8") === lockToken) {
            fs.rmSync(lockFile, { force: true });
          }
        } catch {
          /* lock already gone or held by someone else */
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const contents = fs.readFileSync(lockFile, "utf8");
        const ownerPid = Number(contents.split(":")[0]);
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        const steal = (age > STALE_MS && !isAlive(ownerPid)) || age > ANCIENT_MS;
        if (steal) fs.rmSync(lockFile, { force: true });
      } catch {
        /* another waiter removed it */
      }
      if (Date.now() - started > 30_000) {
        throw new Error(`Timed out waiting for lock ${path.basename(lockFile)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
}
