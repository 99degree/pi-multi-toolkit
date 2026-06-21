/**
 * /models — pick a logged-in provider, then pick a model, switch.
 *
 * Workaround for pi's /model TUI rendering bug: instead of dumping
 * all 422 models (which chokes the viewport), show only models from
 * logged-in providers — a much shorter list that renders fine.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { pickAndSwitchModel } from "../shared.ts";

/** Return only logged-in provider base names (short list). */
function authedProviders(ctx: ExtensionCommandContext): string[] {
  const as = ctx.modelRegistry.authStorage;
  const names = new Set<string>();
  for (const a of as.list()) names.add(a.replace(/-\d+$/, ""));
  // Also check models that have auth (env var based)
  const allModels = ctx.modelRegistry.getAll() as any[];
  for (const m of allModels) names.add(m.provider.replace(/-\d+$/, ""));
  return [...names].filter(Boolean).sort();
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("models", {
    description: "Switch model — pick a logged-in provider → pick a model → activate",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const names = authedProviders(ctx);
      if (!names.length) { ctx.ui.notify("No logged-in providers. Set API key or login first.", "warning"); return; }

      const picked = await ctx.ui.select("Select provider:", names);
      if (!picked) return;
      const idx = names.indexOf(picked);
      if (idx < 0) return;

      for (const c of [picked, `${picked}-0`, `${picked}-1`]) {
        const ok = await pickAndSwitchModel(pi, ctx, c);
        if (ok) return;
      }
      ctx.ui.notify(`No models for "${picked}".`, "info");
    },
  });
}
