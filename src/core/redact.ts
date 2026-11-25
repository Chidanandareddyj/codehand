const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk_live_[A-Za-z0-9]{16,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z\-_]{30,}/g,
  /glpat-[A-Za-z0-9\-_]{16,}/g,
  /npm_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(postgres|mysql|mongodb(\+srv)?):\/\/\S+/g,
  /Bearer [A-Za-z0-9._-]{20,}/g,
];

const URL_CREDENTIALS_PATTERN = /(https?:\/\/)([^/\s@:]+:[^/\s@]+|[^/\s@]+)@/gi;

let secretValues: string[] = [];

export function setSecretValues(values: string[]): void {
  secretValues = values.filter((value) => value.length >= 8);
}

export function redact(text: string): string {
  let out = text.replace(URL_CREDENTIALS_PATTERN, "$1[REDACTED]@");
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "[redacted]");
  }
  for (const value of secretValues) {
    if (!value) continue;
    out = out.split(value).join("[redacted]");
  }
  return out;
}

function redactValue<T>(value: T, seen: WeakMap<object, unknown>): T {
  if (typeof value === "string") return redact(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date || value instanceof RegExp) return value;
  if (seen.has(value)) return seen.get(value) as T;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) {
      out.push(redactValue(item, seen));
    }
    return out as T;
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, entry] of Object.entries(value)) {
    out[key] = redactValue(entry, seen);
  }
  return out as T;
}

/** Recursively redact all string values inside an object or array. */
export function redactDeep<T>(value: T): T {
  return redactValue(value, new WeakMap());
}
