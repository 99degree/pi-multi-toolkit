/**
 * Subscription Manager — add providers & manage clones via /subs.
 *
 * Requires the provider extension for initialization and login helpers.
 *
 * /subs          — interactive menu
 * /subs add <p> — add a new system provider with auth
 * /subs create   — create a clone (after base exists)
 * /subs login    — set/change API key for a clone
 * /subs remove   — remove a sub
 * /subs list     — list all managed subs
 * /subs switch   — switch to a sub's model
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  SubEntry, MultiPassConfig, PROVIDER_TEMPLATES, registerSub,
  subProviderName, loadGlobalConfig, saveGlobalConfig,
  normalizeEntries,
} from "../shared.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveEntry(name: string, cfg: MultiPassConfig): SubEntry | undefined {
  return cfg.subscriptions.find(s => subProviderName(s) === name || s.provider === name);
}

function nextCloneIndex(provider: string, subs: SubEntry[]): number {
  const existing = subs.filter(s => s.provider === provider);
  return existing.length ? Math.max(...existing.map(s => s.index)) + 1 : 1;
}

async function altKeyLogin(ctx: ExtensionCommandContext, subName: string): Promise<boolean> {
  const key = await ctx.ui.input(`Alternative API key for ${subName}:`, "");
  if (!key?.trim()) { ctx.ui.notify("Canceled.", "info"); return false; }
  ctx.modelRegistry.authStorage.set(subName, { type: "api_key", key: key.trim() });
  ctx.modelRegistry.refresh();
  return true;
}

function managedSubs(cfg: MultiPassConfig): SubEntry[] {
  return normalizeEntries(cfg.subscriptions);
}

// ---------------------------------------------------------------------------
// Interactive menu
// ---------------------------------------------------------------------------

async function showMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const choices = [
    "Switch model",
    "Clone",
    "Login (alt API key)",
    "Remove sub",
    "Exit",
  ];

  for (;;) {
    const pick = await ctx.ui.select("\n=== Subscriptions ===", choices);
    if (!pick || pick === "Exit" || pick === choices[4]) break;

    const cfg = loadGlobalConfig();

    switch (pick) {
      // ── Switch model: pick provider → pick model → activate ──
      case choices[0]: {
        const subs = managedSubs(cfg);
        if (!subs.length) {
          ctx.ui.notify("No subs. Use [Add provider] first.", "info");
          break;
        }
        const labels = subs.map(e => {
          const n = subProviderName(e);
          const auth = ctx.modelRegistry.authStorage.hasAuth(n) ? "✓" : "○";
          const k = e.index > 0 ? `clone#${e.index}` : "base";
          return `${auth} ${n}  [${k}]`;
        });
        const picked = await ctx.ui.select("Select provider:", labels);
        if (!picked) break;
        const idx = labels.indexOf(picked);
        if (idx < 0) break;
        const entry = subs[idx];
        const name = subProviderName(entry);

        // Show models under selected provider
        const models = ctx.modelRegistry.getAll().filter((m: any) => m.provider === name) as any[];
        if (!models.length) { ctx.ui.notify(`No models for "${name}".`, "info"); break; }
        const modelLabels = models.map((m: any) => `${m.id}${m.reasoning ? " (reasoning)" : ""}`);
        const pickedModel = await ctx.ui.select(`Models for ${name}:`, modelLabels);
        if (!pickedModel) break;
        const mi = modelLabels.indexOf(pickedModel);
        const target = mi >= 0 ? models[mi] : models[0];
        const ok = await pi.setModel(target);
        if (ok) {
          ctx.ui.notify(`Switched to ${target.provider}/${target.id}`, "info");
          ctx.ui.setStatus("subs-mgr", target.provider);
        } else {
          ctx.ui.notify("Failed.", "error");
        }
        break;
      }

      // ── Clone ──
      case choices[1]: {
        // Find all logged-in providers (by unique base name from auth storage)
        const allAuthNames = ctx.modelRegistry.authStorage.list();
        const baseNames = [...new Set(allAuthNames.map(n => n.replace(/-\d+$/, "")))]
          .filter(n => PROVIDER_TEMPLATES[n])
          .sort();
        if (!baseNames.length) {
          ctx.ui.notify("No logged-in providers to clone. Login to a provider first.", "info");
          break;
        }
        const pick = await ctx.ui.select("Clone which provider?", baseNames);
        if (!pick) break;

        const idx = nextCloneIndex(pick, cfg.subscriptions);
        const entry: SubEntry = { provider: pick, index: idx };
        cfg.subscriptions.push(entry);
        saveGlobalConfig(cfg);
        registerSub(pi, entry, (ctx as any));
        ctx.ui.notify(`Created clone "${subProviderName(entry)}". Use [Login] to set an API key.`, "info");
        break;
      }

      // ── Login (alt API key) ──
      case choices[2]: {
        const clones = managedSubs(cfg).filter(s => s.index > 0);
        if (!clones.length) { ctx.ui.notify("No clones to login.", "info"); break; }
        const names = clones.map(s => subProviderName(s));
        const pick = await ctx.ui.select("Login to which clone?", names);
        if (!pick) break;
        const ok = await altKeyLogin(ctx, pick);
        if (ok) ctx.ui.notify(`API key set for ${pick}.`, "info");
        break;
      }

      // ── Remove (clones only) ──
      case choices[3]: {
        const clones = managedSubs(cfg).filter(s => s.index > 0);
        if (!clones.length) { ctx.ui.notify("No clones to remove.", "info"); break; }
        const names = clones.map(s => subProviderName(s));
        const pick = await ctx.ui.select("Remove which sub?", names);
        if (!pick) break;
        const entry = resolveEntry(pick, cfg);
        if (!entry) break;
        cfg.subscriptions.splice(cfg.subscriptions.indexOf(entry), 1);
        saveGlobalConfig(cfg);
        try { ctx.modelRegistry.authStorage.logout(pick); } catch { /* ignore */ }
        ctx.modelRegistry.refresh();
        ctx.ui.notify(`Removed ${pick}.`, "info");
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Direct command handlers
// ---------------------------------------------------------------------------

async function cmdList(ctx: ExtensionCommandContext): Promise<void> {
  const cfg = loadGlobalConfig();
  const subs = managedSubs(cfg);
  if (!subs.length) { ctx.ui.notify("No managed subs.", "info"); return; }
  ctx.ui.notify(subs.map(e => {
    const name = subProviderName(e);
    const auth = ctx.modelRegistry.authStorage.hasAuth(name) ? "auth" : "no auth";
    const kind = e.index > 0 ? `clone#${e.index}` : "base";
    return `${name}  [${kind}]  (${auth})`;
  }).join("\n"), "info");
}

async function cmdClone(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) { ctx.ui.notify("Usage: /subs clone <provider>", "warning"); return; }
  const provider = parts[1];
  if (!PROVIDER_TEMPLATES[provider]) { ctx.ui.notify(`Unknown provider "${provider}".`, "error"); return; }

  const cfg = loadGlobalConfig();
  // Check if any auth entry exists for this provider (name or name-N)
  const allAuth = ctx.modelRegistry.authStorage.list();
  const hasAnyAuth = allAuth.some(a => a === provider || a.startsWith(provider + "-"));
  if (!hasAnyAuth) {
    ctx.ui.notify(`"${provider}" is not logged in. Login to it first.`, "warning");
    return;
  }

  const idx = nextCloneIndex(provider, cfg.subscriptions);
  const entry: SubEntry = { provider, index: idx };
  cfg.subscriptions.push(entry);
  saveGlobalConfig(cfg);
  registerSub(pi, entry, (ctx as any));
  ctx.ui.notify(`Created clone "${subProviderName(entry)}". Use /subs login ${subProviderName(entry)} to set an API key.`, "info");
}

async function cmdLogin(ctx: ExtensionCommandContext, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) { ctx.ui.notify("Usage: /subs login <name>", "warning"); return; }
  const name = parts[1];
  const ok = await altKeyLogin(ctx, name);
  if (ok) ctx.ui.notify(`API key set for ${name}.`, "info");
}

async function cmdRemove(ctx: ExtensionCommandContext, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) { ctx.ui.notify("Usage: /subs remove <name>", "warning"); return; }
  const name = parts[1];
  const cfg = loadGlobalConfig();
  const entry = resolveEntry(name, cfg);
  if (!entry) { ctx.ui.notify(`Not found: "${name}".`, "error"); return; }
  if (entry.index === 0) { ctx.ui.notify(`"${name}" is a base provider. Only clones can be removed.`, "warning"); return; }
  const subName = subProviderName(entry);
  cfg.subscriptions.splice(cfg.subscriptions.indexOf(entry), 1);
  saveGlobalConfig(cfg);
  try { ctx.modelRegistry.authStorage.logout(subName); } catch { /* ignore */ }
  ctx.modelRegistry.refresh();
  ctx.ui.notify(`Removed ${subName}.`, "info");
}

async function cmdSwitch(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) { ctx.ui.notify("Usage: /subs switch <name> [modelId]", "warning"); return; }
  const name = parts[1], modelId = parts[2];
  const models = ctx.modelRegistry.getAll().filter((m: any) => m.provider === name) as any[];
  if (!models.length) { ctx.ui.notify(`No models for "${name}".`, "error"); return; }
  const target = modelId ? models.find((m: any) => m.id === modelId) || models[0] : models[0];
  const ok = await pi.setModel(target);
  ctx.ui.notify(ok ? `Switched to ${name} / ${target.id}` : "Failed.", ok ? "info" : "error");
  if (ok) ctx.ui.setStatus("subs-mgr", name);
}

// ---------------------------------------------------------------------------
// Extension entry — registers /subs command
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerCommand("subs", {
    description: "Manage subscriptions — /subs (menu) | clone | login | remove | list | switch",
    getArgumentCompletions: (prefix: string) => {
      const cmds = ["clone", "login", "remove", "list", "switch"];
      return cmds.filter(c => c.startsWith(prefix)).map(c => ({ value: c, label: c }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      if (!sub) { await showMenu(pi, ctx); return; }

      switch (sub) {
        case "list":   await cmdList(ctx); break;
        case "clone": await cmdClone(pi, ctx, args); break;
        case "login":  await cmdLogin(ctx, args); break;
        case "remove": await cmdRemove(ctx, args); break;
        case "switch": await cmdSwitch(pi, ctx, args); break;
        default: ctx.ui.notify(`Unknown: "${sub}". /subs clone|login|remove|list|switch`, "warning");
      }
    },
  });
}
