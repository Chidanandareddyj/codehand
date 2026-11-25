import { openCodeAdapter } from "../adapters/opencode.js";
import { getPreference } from "./prefs.js";
import type { Preference } from "./types.js";

export interface AgentDescription {
  id: "opencode";
  name: string;
  installed: boolean;
  version?: string;
  auth: "ready" | "anonymous" | "unknown" | "not_installed";
  providers: string[];
  models: string[];
  freeTier: boolean;
  warning?: string;
}

export async function describeAgents(): Promise<{
  agents: AgentDescription[];
  preference: Preference | null;
}> {
  const [detected, auth, models] = await Promise.all([
    openCodeAdapter.detect(),
    openCodeAdapter.authStatus(),
    openCodeAdapter.listModels().catch(() => [] as string[]),
  ]);
  return {
    agents: [
      {
        id: "opencode",
        name: openCodeAdapter.displayName,
        installed: detected.installed,
        version: detected.version,
        auth: detected.installed ? auth.state : "not_installed",
        providers: detected.installed ? auth.providers : [],
        models: models.slice(0, 15),
        freeTier: detected.installed && auth.state !== "unknown",
        warning: detected.warning,
      },
    ],
    preference: getPreference(),
  };
}
