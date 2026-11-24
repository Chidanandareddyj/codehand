const providerKeys = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
];

for (const key of providerKeys) delete process.env[key];

process.env.CODEHAND_USE_TSX = "1";
process.env.CODEHAND_CACHE_MS = "0";
process.env.CODEHAND_HEARTBEAT_MS = "200";
