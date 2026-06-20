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
import type { OAuthLoginCallbacks, OAuthPrompt, OAuthAuthInfo, OAuthDeviceCodeInfo, OAuthSelectPrompt } from "@earendil-works/pi-ai/oauth";
import {
  SubEntry, MultiPassConfig, PROVIDER_TEMPLATES, registerSub,
  subProviderName, loadGlobalConfig, saveGlobalConfig,
  normalizeEntries,
} from "../shared.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSystemProvider(name: string): boolean {
  return !!PROVIDER_TEMPLATES[name];
}

function resolveEntry(name: string, cfg: MultiPassConfig): SubEntry | undefined {
  return cfg.subscriptions.find(s => subProviderName(s) === name || s.provider === name);
}

function nextCloneIndex(provider: string, subs: SubEntry[]): number {
  const existing = subs.filter(s => s.provider === provider);
  return existing.length ? Math.max(...existing.map(s => s.index)) + 1 : 1;
}

function buildCallbacks(ctx: ExtensionCommandContext): OAuthLoginCallbacks {
  return {
    onAuth: (info: OAuthAuthInfo) => ctx.ui.notify(`Open:\n${info.url}${info.instructions ? `\n${info.instructions}` : ""}`, "info"),
    onDeviceCode: (info: OAuthDeviceCodeInfo) => ctx.ui.notify(`Code: ${info.userCode}\nOpen ${info.verificationUri}`, "info"),
    onPrompt: async (p: OAuthPrompt) => (await ctx.ui.input(p.message, p.placeholder || "")) || "",
    onProgress: (m: string) => ctx.ui.notify(m, "info"),
    onManualCodeInput: async () => (await ctx.ui.input("Auth code:", "")) || "",
    onSelect: async (p: OAuthSelectPrompt) => ctx.ui.select(p.message, p.options.map(o => o.label)),
  };
}

async function systemLogin(ctx: ExtensionCommandContext, subName: string): Promise<boolean> {
  try {
    await ctx.modelRegistry.authStorage.login(subName, buildCallbacks(ctx));
    ctx.modelRegistry.refresh();
    return true;
  } catch {
    const key = await ctx.ui.input(`API key for ${subName}:`, "");
    if (!key?.trim()) { ctx.ui.notify("Canceled.", "info"); return false; }
    ctx.modelRegistry.authStorage.set(subName, { type: "api_key", key: key.trim() });
    ctx.modelRegistry.refresh();
    return true;
  }
}

async function altKeyLogin(ctx: ExtensionCommandContext, subName: string): Promise<boolean> {
  const key = await ctx.ui.input(`Alternative API key for ${subName}:`, "");
  if (!key?.trim()) { ctx.ui.notify("Canceled.", "info"); return false; }
  ctx.modelRegistry.authStorage.set(subName, { type: "api_key", key: key.trim() });
  ctx.modelRegistry.refresh();
  return true;
}

function describeProvider(provider: string): string {
  const t = PROVIDER_TEMPLATES[provider];
  if (!t) return `Unknown provider "${provider}".`;
  const lines: string[] = [];
  lines.push(`Provider: ${t.displayName || provider}`);
  if (t.useOAuth === false || t.builtinOAuth?.name?.includes?.("API key")) {
    lines.push("Auth:     API key");
  } else if (t.builtinOAuth) {
    lines.push("Auth:     OAuth");
  } else {
    lines.push("Auth:     ?");
  }
  if (t.sourceProvider) lines.push(`Source:   ${t.sourceProvider}`);
  const models = t.models || [];
  const builtin = t.builtinModels?.() || [];
  const all = [...models, ...builtin];
  if (all.length > 0) {
    const reasonCount = all.filter((m: any) => m.reasoning).length;
    lines.push(`Models:   ${all.length} available${reasonCount > 0 ? ` (${reasonCount} with reasoning)` : ""}`);
    const baseUrl = all.find((m: any) => m.baseUrl)?.baseUrl;
    if (baseUrl) lines.push(`API:      ${baseUrl}`);
    lines.push("");
    lines.push(all.slice(0, 5).map((m: any) => `  ${m.id}${m.reasoning ? " (reasoning)" : ""}`).join("\n")
      + (all.length > 5 ? `\n  … and ${all.length - 5} more` : ""));
  } else {
    lines.push("Models:   (loaded from system — not pre-defined)");
  }
  return lines.join("\n");
}

function managedSubs(cfg: MultiPassConfig): SubEntry[] {
  return normalizeEntries(cfg.subscriptions).filter(s => s.index > 0 || !isSystemProvider(s.provider));
}

// ---------------------------------------------------------------------------
// Interactive menu
// ---------------------------------------------------------------------------

async function showMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const choices = [
    "List subs",
    "Add provider",
    "Create clone",
    "Login (alt API key)",
    "Remove sub",
    "Switch model",
    "Exit",
  ];

  for (;;) {
    const pick = await ctx.ui.select("\n=== Subscription Manager ===", choices);
    if (!pick || pick === "Exit" || pick === choices[6]) break;

    const cfg = loadGlobalConfig();

    switch (pick) {
      // ── List ──
      case choices[0]: {
        const subs = managedSubs(cfg);
        if (!subs.length) {
          ctx.ui.notify("No managed subs. Use [Add provider] to create one.", "info");
        } else {
          ctx.ui.notify(
            subs.map(e => {
              const name = subProviderName(e);
              const auth = ctx.modelRegistry.authStorage.hasAuth(name) ? "auth" : "no auth";
              const kind = e.index > 0 ? `clone#${e.index}` : "base";
              return `${name}  [${kind}]  (${auth})`;
            }).join("\n"),
            "info",
          );
        }
        break;
      }

      // ── Add provider (system provider, always index 0) ──
      case choices[1]: {
        const allProviders = Object.keys(PROVIDER_TEMPLATES).sort();
        const authed = new Set(ctx.modelRegistry.authStorage.list());
        const labelMap = new Map<string, string>();
        const labels = allProviders.map(p => {
          const hasAuth = authed.has(p) ? "✓" : " ";
          const label = `${hasAuth} ${p}`;
          labelMap.set(label, p);
          return label;
        });
        const pickedLabel = await ctx.ui.select("Choose provider:", labels);
        if (!pickedLabel) break;
        const pname = labelMap.get(pickedLabel) || pickedLabel.trim();

        const existing = cfg.subscriptions.filter(s => s.provider === pname);
        if (existing.length > 0) {
          ctx.ui.notify(`"${pname}" already registered. Use [Create clone] for duplicates.`, "info");
          break;
        }

        // Show provider info before adding
        ctx.ui.notify(describeProvider(pname), "info");

        const entry: SubEntry = { provider: pname, index: 0 };
        cfg.subscriptions.push(entry);
        saveGlobalConfig(cfg);
        registerSub(pi, entry, (ctx as any));

        const ok = await systemLogin(ctx, subProviderName(entry));
        if (!ok) {
          cfg.subscriptions.splice(cfg.subscriptions.indexOf(entry), 1);
          saveGlobalConfig(cfg);
          try { ctx.modelRegistry.authStorage.logout(subProviderName(entry)); } catch { /* ignore */ }
          ctx.modelRegistry.refresh();
          ctx.ui.notify(`Canceled: "${pname}" not registered.`, "warning");
        } else {
          ctx.ui.notify(`Added and logged in: "${subProviderName(entry)}".`, "info");
        }
        break;
      }

      // ── Create clone ──
      case choices[2]: {
        const parents = [...new Set(cfg.subscriptions.filter(s => s.index === 0).map(s => s.provider))].sort();
        if (!parents.length) {
          ctx.ui.notify("No base providers. Use [Add provider] first.", "info");
          break;
        }
        const pick = await ctx.ui.select("Clone which provider?", parents);
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
      case choices[3]: {
        const clones = managedSubs(cfg).filter(s => s.index > 0);
        if (!clones.length) { ctx.ui.notify("No clones to login.", "info"); break; }
        const names = clones.map(s => subProviderName(s));
        const pick = await ctx.ui.select("Login to which clone?", names);
        if (!pick) break;
        const ok = await altKeyLogin(ctx, pick);
        if (ok) ctx.ui.notify(`API key set for ${pick}.`, "info");
        break;
      }

      // ── Remove ──
      case choices[4]: {
        const subs = managedSubs(cfg);
        if (!subs.length) { ctx.ui.notify("Nothing to remove.", "info"); break; }
        const names = subs.map(s => subProviderName(s));
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

      // ── Switch model ──
      case choices[5]: {
        const subs = managedSubs(cfg);
        if (!subs.length) { ctx.ui.notify("No subs.", "info"); break; }
        const allModels: any[] = [];
        const allLabels: string[] = [];
        for (const s of subs) {
          const name = subProviderName(s);
          const models = ctx.modelRegistry.getAll().filter((m: any) => m.provider === name) as any[];
          for (const m of models) {
            allModels.push(m);
            allLabels.push(`${name}/${m.id}${m.reasoning ? " (reasoning)" : ""}`);
          }
        }
        if (!allModels.length) { ctx.ui.notify("No models available.", "info"); break; }
        const pick = await ctx.ui.select("Select model:", allLabels);
        if (!pick) break;
        const mi = allLabels.indexOf(pick);
        const target = mi >= 0 ? allModels[mi] : allModels[0];
        const ok = await pi.setModel(target);
        if (ok) {
          ctx.ui.notify(`Switched to ${target.provider}/${target.id}`, "info");
          ctx.ui.setStatus("subs-mgr", target.provider);
        } else {
          ctx.ui.notify("Failed.", "error");
        }
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

async function cmdAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) { ctx.ui.notify("Usage: /subs add <provider>", "warning"); return; }
  const provider = parts[1];
  const template = PROVIDER_TEMPLATES[provider];
  if (!template) { ctx.ui.notify(`Unknown provider "${provider}".`, "error"); return; }

  ctx.ui.notify(describeProvider(provider), "info");

  const cfg = loadGlobalConfig();
  const existing = cfg.subscriptions.filter(s => s.provider === provider);
  if (existing.length > 0) {
    ctx.ui.notify(`"${provider}" already registered. Use /subs create ${provider} for clones.`, "info");
    return;
  }

  const entry: SubEntry = { provider, index: 0 };
  cfg.subscriptions.push(entry);
  saveGlobalConfig(cfg);
  registerSub(pi, entry, (ctx as any));

  const ok = await systemLogin(ctx, subProviderName(entry));
  if (!ok) {
    cfg.subscriptions.splice(cfg.subscriptions.indexOf(entry), 1);
    saveGlobalConfig(cfg);
    try { ctx.modelRegistry.authStorage.logout(subProviderName(entry)); } catch { /* ignore */ }
    ctx.modelRegistry.refresh();
    ctx.ui.notify(`Canceled: "${provider}" not registered.`, "warning");
    return;
  }
  ctx.ui.notify(`Added and logged in: "${subProviderName(entry)}".`, "info");
}

async function cmdCreate(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) { ctx.ui.notify("Usage: /subs create <provider>", "warning"); return; }
  const provider = parts[1];
  if (!PROVIDER_TEMPLATES[provider]) { ctx.ui.notify(`Unknown provider "${provider}".`, "error"); return; }

  const cfg = loadGlobalConfig();
  const parent = cfg.subscriptions.find(s => s.provider === provider && s.index === 0);
  if (!parent) {
    ctx.ui.notify(`"${provider}" has no base registration. Use /subs add ${provider} first.`, "info");
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
    description: "Manage subscriptions — /subs (menu) | add | create | login | remove | list | switch",
    getArgumentCompletions: (prefix: string) => {
      const cmds = ["add", "create", "login", "remove", "list", "switch"];
      return cmds.filter(c => c.startsWith(prefix)).map(c => ({ value: c, label: c }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      if (!sub) { await showMenu(pi, ctx); return; }

      switch (sub) {
        case "list":   await cmdList(ctx); break;
        case "add":    await cmdAdd(pi, ctx, args); break;
        case "create": await cmdCreate(pi, ctx, args); break;
        case "login":  await cmdLogin(ctx, args); break;
        case "remove": await cmdRemove(ctx, args); break;
        case "switch": await cmdSwitch(pi, ctx, args); break;
        default: ctx.ui.notify(`Unknown: "${sub}". /subs add|create|login|remove|list|switch`, "warning");
      }
    },
  });
}
