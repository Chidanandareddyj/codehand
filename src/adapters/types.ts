import type { ErrorKind, Mode, NormalizedEvent } from "../core/types.js";

export type LoginMethod = "chatgpt_device" | "github_copilot" | "api_key_env";

export interface AgentAdapter {
  id: "opencode";
  displayName: string;
  detect(): Promise<{ installed: boolean; version?: string; path?: string; warning?: string }>;
  authStatus(): Promise<{
    state: "ready" | "needs_login" | "unknown";
    providers: string[];
    detail?: string;
  }>;
  listModels(): Promise<string[]>;
  installCommand(): { cmd: string; args: string[] };
  loginCommand(method: LoginMethod): { cmd: string; args: string[] } | null;
  preamble(workdir: string, branch: string): string;
  buildRun(opts: {
    message: string;
    cwd: string;
    mode: Mode;
    model?: string;
    sessionId?: string;
    promptPath: string;
  }): { cmd: string; args: string[]; env: Record<string, string> };
  parseLine(line: string): NormalizedEvent[];
  classifyFailure(exitCode: number | null, stderrTail: string): ErrorKind;
}
