import fs from "node:fs";
import path from "node:path";

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function atomicWriteText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function appendLine(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line.endsWith("\n") ? line : `${line}\n`);
}

export async function withFileLock<T>(lockFile: string, fn: () => Promise<T> | T): Promise<T> {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      try {
        return await fn();
      } finally {
        fs.rmSync(lockFile, { force: true });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (Date.now() - started > 15_000) {
        try {
          const age = Date.now() - fs.statSync(lockFile).mtimeMs;
          if (age > 15_000) fs.rmSync(lockFile, { force: true });
        } catch {
          /* another waiter removed it */
        }
      }
      if (Date.now() - started > 30_000) {
        throw new Error(`Timed out waiting for lock ${path.basename(lockFile)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
}
