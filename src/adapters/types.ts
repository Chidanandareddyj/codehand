import type { AuthState, ErrorKind, Mode, NormalizedEvent } from "../core/types.js";

export type LoginMethod = "chatgpt_device" | "github_copilot" | "api_key_env";

export interface AdapterAuthStatus {
  state: AuthState;
  providers: string[];
  signedInProviders: string[];
  envProviders: string[];
  detail?: string;
}

export interface AdapterFailureInput {
  exitCode: number | null;
  signal?: string | null;
  spawnErrorCode?: string;
  stderrTail: string;
  errorEvents: Extract<NormalizedEvent, { t: "error" }>[];
}

export interface AdapterFailure {
  kind: ErrorKind;
  message: string;
  isProviderError?: boolean;
}

export interface AgentAdapter {
  id: "opencode";
  displayName: string;
  detect(): Promise<{ installed: boolean; version?: string; path?: string; warning?: string }>;
  authStatus(): Promise<AdapterAuthStatus>;
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
  classifyFailure(input: AdapterFailureInput): AdapterFailure;
  isFreeModel?(model?: string): boolean;
}
