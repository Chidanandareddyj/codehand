const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(postgres|mysql|mongodb(\+srv)?):\/\/\S+/g,
  /Bearer [A-Za-z0-9._-]{20,}/g,
];

let secretValues: string[] = [];

export function setSecretValues(values: string[]): void {
  secretValues = values.filter((value) => value.length >= 8);
}

export function redact(text: string): string {
  let out = text;
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
