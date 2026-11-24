import fs from "node:fs";
import { secretsPath } from "./config.js";
import { setSecretValues } from "./redact.js";

export function readSecrets(): Record<string, string> {
  let text = "";
  try {
    text = fs.readFileSync(secretsPath(), "utf8");
  } catch {
    setSecretValues([]);
    return {};
  }
  const secrets: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value) secrets[key] = value;
  }
  setSecretValues(Object.values(secrets));
  return secrets;
}

export function buildChildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...readSecrets(), ...extra };
}
