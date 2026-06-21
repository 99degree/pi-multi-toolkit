/**
 * /models — pick a logged-in provider, then pick a model, switch.
 *
 * Workaround for pi's /model TUI rendering bug: instead of dumping
 * all 422 models (which chokes the viewport), show only models from
 * logged-in providers — a much shorter list that renders fine.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  PROVIDER_TEMPLATES, getModelsForProvider, pickAndSwitchModel,
  loadGlobalConfig, normalizeEntries,
} from "../shared.ts";

/** Return all provider base names from config + templates, with auth status. */
function availableProviders(ctx: ExtensionCommandContext): { name: string; authed: boolean }[] {
  const as = ctx.modelRegistry.authStorage;
  const authNames = new Set(as.list());
  const names = new Set<string>();

  // From subscription config
  const cfg = loadGlobalConfig();
  for (const s of normalizeEntries(cfg.subscriptions)) names.add(s.provider);
  // All template providers
  for (const p of Object.keys(PROVIDER_TEMPLATES)) names.add(p);

  return [...names].filter(Boolean).sort().map(name => ({
    name,
    authed: authNames.has(name) || authNames.has(`${name}-0`) || as.hasAuth(name),
  }));
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("models", {
    description: "Switch model — pick a provider → pick a model → activate",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const provs = availableProviders(ctx);
      if (!provs.length) { ctx.ui.notify("No providers available.", "info"); return; }

      const picked = await ctx.ui.select("Select provider:",
        provs.map(p => `${p.authed ? "✓" : "○"} ${p.name}`));
      if (!picked) return;
      const idx = provs.findIndex(p => `${p.authed ? "✓" : "○"} ${p.name}` === picked);
      if (idx < 0) return;
      const prov = provs[idx];

      if (!prov.authed) {
        ctx.ui.notify(`"${prov.name}" has no API key set. Use env var or login first.`, "warning");
        return;
      }

      // Try all possible subscription names
      for (const c of [prov.name, `${prov.name}-0`, `${prov.name}-1`]) {
        const ok = await pickAndSwitchModel(pi, ctx, c);
        if (ok) return;
      }
      ctx.ui.notify(`No models for "${prov.name}".`, "info");
    },
  });
}
