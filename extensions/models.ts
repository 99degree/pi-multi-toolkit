/**
 * /models — pick a logged-in provider, then pick a model, switch.
 *
 * Workaround for pi's /model TUI rendering bug: instead of dumping
 * all 422 models (which chokes the viewport), show only models from
 * logged-in providers — a much shorter list that renders fine.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getModelsForProvider, pickAndSwitchModel } from "../shared.ts";

function findAuthedProviders(ctx: ExtensionCommandContext): string[] {
  const as = ctx.modelRegistry.authStorage;
  const stored = as.list();
  const storedBases = new Set(stored.map(n => n.replace(/-\d+$/, "")));
  const allModels = ctx.modelRegistry.getAll() as any[];
  const allProvs = [...new Set(allModels.map((m: any) => m.provider))];
  const envAuthed = allProvs.filter(p => {
    const base = p.replace(/-\d+$/, "");
    return !storedBases.has(base) && as.hasAuth(p);
  }).map(p => p.replace(/-\d+$/, ""));
  return [...new Set([...storedBases, ...envAuthed])].filter(Boolean).sort();
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("models", {
    description: "Switch model — pick a logged-in provider → pick a model → activate",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const as = ctx.modelRegistry.authStorage;
      const bases = findAuthedProviders(ctx);
      if (!bases.length) {
        ctx.ui.notify("No logged-in providers. Set an API key in env or login first.", "warning");
        return;
      }

      // Step 1: pick a provider
      const providerLabels = bases.map(b => {
        const hasStored = as.list().some(a => a === b || a.startsWith(b + "-"));
        return `${hasStored ? "✓" : "○"} ${b}`;
      });
      const picked = await ctx.ui.select("Select provider:", providerLabels);
      if (!picked) return;
      const idx = providerLabels.indexOf(picked);
      if (idx < 0) return;
      const provider = bases[idx];

      // Step 2: pick model + switch (using shared helper)
      await pickAndSwitchModel(pi, ctx, provider);
    },
  });
}
