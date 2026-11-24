import { loadConfig, savePreference } from "./config.js";
import type { Preference } from "./types.js";

export function getPreference(): Preference | null {
  return loadConfig().preference;
}

export { savePreference };
