/**
 * Provider Initializer — registers managed subscriptions on startup.
 *
 * Loads the multi-pass config and registers each subscription
 * with its models from the provider template.
 *
 * Also scans auth.json for orphaned API keys (providers with stored
 * credentials but no subscription entry) and auto-registers them
 * so they appear in /login, /models, and /route.
 *
 * Login, clone management, and interactive workflows are in subs.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SubEntry, PROVIDER_TEMPLATES, registerSub,
  loadGlobalConfig, loadEffectiveConfig,
  parseEnvConfig, mergeConfigs, normalizeEntries,
  subProviderName, getBaseProvider, authConfigPath,
} from "../shared.ts";
import { existsSync, readFileSync } from "node:fs";

/** Parse auth.json and return SubEntry[] for providers that have
 *  stored credentials but no subscription (orphaned auth keys). */
function orphanedAuthEntries(): SubEntry[] {
  if (!existsSync(authConfigPath())) return [];
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(authConfigPath(), "utf-8"));
  } catch {
    return [];
  }
  const subs = new Set(loadGlobalConfig().subscriptions.map(s => subProviderName(s)));
  const entries: SubEntry[] = [];

  for (const key of Object.keys(raw)) {
    const base = getBaseProvider(key);
    if (!base) continue;                // not a multi-toolkit provider
    if (!PROVIDER_TEMPLATES[base]) continue; // not in our templates

    // Extract index from key name (e.g. "siliconflow-2" → 2)
    const m = key.match(/^(.+)-(\d+)$/);
    const index = m ? parseInt(m[2], 10) : 0;
    const subName = `${base}-${index}`;

    if (subs.has(subName)) continue;    // already has a subscription → skip
    entries.push({ provider: base, index });
  }
  return entries;
}

export default function (pi: ExtensionAPI) {
  // 1. Register subscriptions from multi-pass.json
  const cfg = loadGlobalConfig();
  for (const sub of normalizeEntries(mergeConfigs(cfg, parseEnvConfig()))) {
    registerSub(pi, sub);
  }

  // 2. Auto-register orphaned auth entries (API key in auth.json,
  //    no matching subscription in multi-pass.json)
  for (const entry of orphanedAuthEntries()) {
    registerSub(pi, entry);
  }

  // 3. On session start, re-apply subscriptions + auth entries
  //    with full context (for modelRegistry duplicate check)
  pi.on("session_start", async (_event: any, ctx: any) => {
    const eff = loadEffectiveConfig(ctx.cwd);
    for (const sub of eff.subscriptions) {
      registerSub(pi, sub, ctx);
    }

    // Also register orphaned auth entries with context
    for (const entry of orphanedAuthEntries()) {
      registerSub(pi, entry, ctx);
    }
  });
}
