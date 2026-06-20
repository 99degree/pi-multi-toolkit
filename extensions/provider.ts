/**
 * Provider Initializer — registers managed subscriptions on startup.
 *
 * Loads the multi-pass config and registers each subscription
 * with its models from the provider template. That's it.
 *
 * Login, clone management, and interactive workflows are in subs.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SubEntry, PROVIDER_TEMPLATES, registerSub,
  loadGlobalConfig, loadEffectiveConfig,
  parseEnvConfig, mergeConfigs, normalizeEntries,
} from "../shared.ts";

export default function (pi: ExtensionAPI) {
  const cfg = loadGlobalConfig();
  for (const sub of normalizeEntries(mergeConfigs(cfg, parseEnvConfig()))) {
    registerSub(pi, sub);
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    const eff = loadEffectiveConfig(ctx.cwd);
    for (const sub of eff.subscriptions) {
      registerSub(pi, sub, ctx);
    }
  });
}
