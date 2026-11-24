import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok, type Result } from "./types.js";

export function installSkill(target = process.cwd()): Result<{ files: string[] }> {
  const source = fileURLToPath(new URL("../../skill/CODEHAND.md", import.meta.url));
  if (!fs.existsSync(source)) return err("unknown", `Missing skill file at ${source}.`);
  fs.mkdirSync(target, { recursive: true });
  const text = fs.readFileSync(source, "utf8");
  const files = ["CODEHAND.md", "SKILL.md", "AGENTS.md"].map((name) => {
    const dest = path.join(target, name);
    fs.writeFileSync(dest, text);
    return dest;
  });
  return ok({ files });
}
