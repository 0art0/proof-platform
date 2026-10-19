/**
 * Whether suggestions are ranked by the model automatically (architecture §4). It is a per-browser
 * convenience, on by default: every storage access is guarded, and without storage the choice
 * simply applies to the current page only.
 */
export const AUTO_RANK_KEY = "proof-platform.ai-auto-rank.v1";

export function readAutoRankPreference(): boolean {
  try {
    return window.localStorage.getItem(AUTO_RANK_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeAutoRankPreference(automatic: boolean): void {
  try {
    window.localStorage.setItem(AUTO_RANK_KEY, automatic ? "on" : "off");
  } catch {
    // Storage can be unavailable or full; the choice then lasts for this page only.
  }
}
