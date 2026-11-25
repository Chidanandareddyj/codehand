import { openCodeAdapter } from "../adapters/opencode.js";
import { getFreeQuotaExhausted, getUnavailableModels } from "./agentstate.js";
import { getPreference } from "./prefs.js";
import type { AuthState, Preference } from "./types.js";

export interface AgentDescription {
  id: "opencode";
  name: string;
  installed: boolean;
  version?: string;
  auth: AuthState | "not_installed";
  providers: string[];
  signedInProviders: string[];
  envProviders: string[];
  models: string[];
  freeTier: boolean;
  freeTierStatus: "available" | "exhausted" | "unknown" | "not_installed";
  freeTierDetail?: string;
  unavailableModels?: string[];
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
  const freeQuota = getFreeQuotaExhausted("opencode");
  const unavailableModels = Object.keys(getUnavailableModels("opencode"));

  let freeTier = false;
  let freeTierStatus: AgentDescription["freeTierStatus"] = "not_installed";
  let freeTierDetail: string | undefined;

  if (!detected.installed) {
    freeTier = false;
    freeTierStatus = "not_installed";
  } else if (freeQuota) {
    freeTier = false;
    freeTierStatus = "exhausted";
    freeTierDetail = freeQuota.reason;
  } else if (auth.state === "unknown") {
    freeTier = false;
    freeTierStatus = "unknown";
    freeTierDetail = auth.detail;
  } else {
    freeTier = true;
    freeTierStatus = "available";
    freeTierDetail = auth.detail;
  }

  const warnings = [
    detected.warning,
    freeQuota ? `Free tier quota exhausted: ${freeQuota.reason}` : undefined,
  ].filter(Boolean);

  return {
    agents: [
      {
        id: "opencode",
        name: openCodeAdapter.displayName,
        installed: detected.installed,
        version: detected.version,
        auth: detected.installed ? auth.state : "not_installed",
        providers: detected.installed ? auth.providers : [],
        signedInProviders: detected.installed ? auth.signedInProviders : [],
        envProviders: detected.installed ? auth.envProviders : [],
        models: detected.installed ? models.slice(0, 15) : [],
        freeTier,
        freeTierStatus,
        ...(freeTierDetail ? { freeTierDetail } : {}),
        ...(unavailableModels.length > 0 ? { unavailableModels } : {}),
        ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
      },
    ],
    preference: getPreference(),
  };
}
