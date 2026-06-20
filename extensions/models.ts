/**
 * /models — pick a logged-in provider, then pick a model, switch.
 *
 * Workaround for pi's /model TUI rendering bug: instead of dumping
 * all 422 models (which chokes the viewport), show only models from
 * logged-in providers — a much shorter list that renders fine.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("models", {
    description: "Switch model — pick a logged-in provider → pick a model → activate",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const allAuth = ctx.modelRegistry.authStorage.list();
      if (!allAuth.length) {
        ctx.ui.notify("No logged-in providers. Login to one first.", "warning");
        return;
      }

      // Unique base provider names (strip -N suffix)
      const bases = [...new Set(allAuth.map(n => n.replace(/-\d+$/, "")))]
        .filter(n => ctx.modelRegistry.getAll().some((m: any) =>
          m.provider === n || m.provider === `${n}-0`
        ))
        .sort();

      if (!bases.length) {
        ctx.ui.notify("No providers with models available.", "info");
        return;
      }

      // Step 1: pick a provider
      const providerLabels = bases.map(b => {
        const authed = allAuth.filter(a => a === b || a.startsWith(b + "-"));
        const accounts = authed.map(a => ctx.modelRegistry.authStorage.hasAuth(a) ? "✓" : "○").join("");
        return `${accounts} ${b}`;
      });
      const picked = await ctx.ui.select("Select provider:", providerLabels);
      if (!picked) return;
      const idx = providerLabels.indexOf(picked);
      if (idx < 0) return;
      const provider = bases[idx];

      // Step 2: collect models from all auth'd accounts of this provider
      const authedNames = allAuth.filter(a => a === provider || a.startsWith(provider + "-"));
      const allModels: any[] = [];
      const allLabels: string[] = [];
      for (const name of authedNames) {
        const models = ctx.modelRegistry.getAll().filter((m: any) => m.provider === name) as any[];
        for (const m of models) {
          allModels.push(m);
          allLabels.push(`${name}/${m.id}${m.reasoning ? " (reasoning)" : ""}`);
        }
      }
      if (!allModels.length) {
        ctx.ui.notify("No models for this provider.", "info");
        return;
      }

      // Step 3: pick a model
      const modelPick = await ctx.ui.select(`Models for ${provider}:`, allLabels);
      if (!modelPick) return;
      const mi = allLabels.indexOf(modelPick);
      const target = mi >= 0 ? allModels[mi] : allModels[0];
      const ok = await pi.setModel(target);
      if (ok) {
        ctx.ui.notify(`Switched to ${target.provider}/${target.id}`, "info");
        ctx.ui.setStatus("models", target.provider);
      } else {
        ctx.ui.notify("Failed.", "error");
      }
    },
  });
}
