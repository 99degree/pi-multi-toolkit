/**
 * /models — pick a logged-in provider, then pick a model, switch.
 *
 * Workaround for pi's /model TUI rendering bug: instead of dumping
 * all 422 models (which chokes the viewport), show only models from
 * logged-in providers — a much shorter list that renders fine.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

function findAuthedProviders(ctx: ExtensionCommandContext): string[] {
  const as = ctx.modelRegistry.authStorage;
  const stored = as.list();
  const storedBases = new Set(stored.map(n => n.replace(/-\d+$/, "")));
  // Also check env-var-based providers from templates
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

      // Step 2: collect models from all auth'd accounts of this provider
      const allModelEntries = ctx.modelRegistry.getAll() as any[];
      const authedNames = [...new Set(allModelEntries.filter((m: any) => {
        const p = m.provider;
        return p === provider || p.startsWith(provider + "-");
      }).map((m: any) => m.provider))];
      const modelList: any[] = [];
      const modelLabels: string[] = [];
      for (const name of authedNames) {
        const models = ctx.modelRegistry.getAll().filter((m: any) => m.provider === name) as any[];
        for (const m of models) {
          modelList.push(m);
          modelLabels.push(`${name}/${m.id}${m.reasoning ? " (reasoning)" : ""}`);
        }
      }
      if (!modelList.length) {
        ctx.ui.notify("No models for this provider.", "info");
        return;
      }

      // Step 3: pick a model
      const modelPick = await ctx.ui.select(`Models for ${provider}:`, modelLabels);
      if (!modelPick) return;
      const mi = modelLabels.indexOf(modelPick);
      const target = mi >= 0 ? modelList[mi] : modelList[0];
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
