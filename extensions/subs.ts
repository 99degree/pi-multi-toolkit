/**
 * pi Subscription Manager — interactive menu.
 *
 * /subs with no args opens an interactive menu:
 *   List, Add, Remove, Login, Logout, Switch, Models
 *
 * With args, works as direct commands (for automation/LLM use).
 *
 * Two kinds of subscriptions:
 * 1. Additional providers — providers not natively in the system.
 *    Register via /subs add (first time), then login/logout.
 * 2. Clones — duplicate of an existing provider.
 *    /subs add again creates openai-1, openai-2, etc. (auto-increment).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OAuthLoginCallbacks, OAuthPrompt, OAuthAuthInfo, OAuthDeviceCodeInfo, OAuthSelectPrompt } from "@earendil-works/pi-ai/oauth";
import {
  SubEntry, MultiPassConfig, PROVIDER_TEMPLATES, registerSub,
  subProviderName, subDisplayName, loadGlobalConfig, saveGlobalConfig,
  loadEffectiveConfig, parseEnvConfig, mergeConfigs, normalizeEntries,
} from "../shared.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveEntry(name: string, cfg: MultiPassConfig): SubEntry | undefined {
  return cfg.subscriptions.find(s => subProviderName(s) === name || s.provider === name);
}

function managedSubs(cfg: MultiPassConfig): SubEntry[] {
  return normalizeEntries(mergeConfigs(cfg, parseEnvConfig())).filter(s => s.index > 0 || !isSystemProvider(s.provider));
}

function isSystemProvider(name: string): boolean {
  return !!PROVIDER_TEMPLATES[name];
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

/** Login using system auth code — handles both OAuth and API key flows. */
async function systemLogin(ctx: ExtensionCommandContext, subName: string): Promise<boolean> {
  try {
    await ctx.modelRegistry.authStorage.login(subName, buildCallbacks(ctx));
    ctx.modelRegistry.refresh();
    return true;
  } catch {
    // OAuth failed or provider not OAuth — fall back to API key
    const key = await ctx.ui.input(`API key for ${subName}:`, "");
    if (!key?.trim()) { ctx.ui.notify("Canceled.", "info"); return false; }
    ctx.modelRegistry.authStorage.set(subName, { type: "api_key", key: key.trim() });
    ctx.modelRegistry.refresh();
    return true;
  }
}

// ---------------------------------------------------------------------------
// Interactive menu
// ---------------------------------------------------------------------------

async function showMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const choices = [
    "List subs",
    "Add provider / clone",
    "Remove sub",
    "Login",
    "Logout",
    "Switch provider",
    "Models",
    "Exit",
  ];

  for (;;) {
    const pick = await ctx.ui.select("\n=== Subscriptions Manager ===", choices);
    if (!pick || pick === "Exit" || pick === choices[7]) break;

    const cfg = loadGlobalConfig();

    switch (pick) {
      // ── List ──
      case choices[0]: {
        const subs = managedSubs(cfg);
        if (!subs.length) {
          ctx.ui.notify("No managed subs. Use [Add] to create one.", "info");
        } else {
          ctx.ui.notify(
            subs.map(e => {
              const name = subProviderName(e);
              const auth = ctx.modelRegistry.authStorage.hasAuth(name) ? "auth" : "no auth";
              const kind = e.index > 0 ? `clone#${e.index}` : "additional";
              return `${name}  [${kind}]  (${auth})`;
            }).join("\n"),
            "info",
          );
        }
        break;
      }

      // ── Add ──
      case choices[1]: {
        // Shortlist: system-authenticated providers + already-registered subs
        const authed = ctx.modelRegistry.authStorage.list();
        const registered = new Set(cfg.subscriptions.map(s => s.provider));
        const provisioned = [...new Set([...authed, ...registered])].filter(p => PROVIDER_TEMPLATES[p]).sort();
        if (!provisioned.length) {
          ctx.ui.notify("No provisioned providers found. Login to a system provider first.", "info");
          break;
        }
        const pick = await ctx.ui.select("Choose provisioned provider:", provisioned);
        if (!pick) break;
        const pname = pick.toLowerCase();
        const existing = cfg.subscriptions.filter(s => s.provider === pname);
        if (existing.length === 0) {
          cfg.subscriptions.push({ provider: pname, index: 0 });
          saveGlobalConfig(cfg);
          registerSub(pi, { provider: pname, index: 0 }, (ctx as any));
          ctx.ui.notify(`Registered additional provider "${pname}". Use [Login] to authenticate.`, "info");
        } else {
          const idx = nextCloneIndex(pname, cfg.subscriptions);
          const entry: SubEntry = { provider: pname, index: idx };
          cfg.subscriptions.push(entry);
          saveGlobalConfig(cfg);
          registerSub(pi, entry, (ctx as any));
          ctx.ui.notify(`Added clone ${subProviderName(entry)}.`, "info");
        }
        break;
      }

      // ── Remove ──
      case choices[2]: {
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

      // ── Login ──
      case choices[3]: {
        const subs = managedSubs(cfg);
        if (!subs.length) { ctx.ui.notify("No subs to login.", "info"); break; }
        const names = subs.map(s => subProviderName(s));
        const pick = await ctx.ui.select("Login to which sub?", names);
        if (!pick) break;
        const entry = resolveEntry(pick, cfg);
        if (!entry) break;
        const subName = subProviderName(entry);
        const ok = await systemLogin(ctx, subName);
        if (ok) ctx.ui.notify(`Logged in: ${subName}.`, "info");
        break;
      }

      // ── Logout ──
      case choices[4]: {
        const subs = managedSubs(cfg);
        if (!subs.length) { ctx.ui.notify("No subs to logout.", "info"); break; }
        const authed = subs.filter(s => ctx.modelRegistry.authStorage.hasAuth(subProviderName(s)));
        if (!authed.length) { ctx.ui.notify("No authenticated subs.", "info"); break; }
        const names = authed.map(s => subProviderName(s));
        const pick = await ctx.ui.select("Logout from which sub?", names);
        if (!pick) break;
        try {
          ctx.modelRegistry.authStorage.logout(pick);
          ctx.modelRegistry.refresh();
          ctx.ui.notify(`Logged out of ${pick}.`, "info");
        } catch (err: any) { ctx.ui.notify(`Logout failed: ${err?.message || err}`, "error"); }
        break;
      }

      // ── Switch / Models ──
      case choices[5]:
      case choices[6]: {
        const subs = managedSubs(cfg);
        if (!subs.length) { ctx.ui.notify("No subs.", "info"); break; }
        // Unified model picker like /model: all subs' models in one list
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
          const provName = target.provider || "?";
          ctx.ui.notify(`Switched to ${provName}/${target.id}`, "info");
          ctx.ui.setStatus("multi-subs", provName);
        } else {
          ctx.ui.notify("Failed.", "error");
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Direct command handlers (for args)
// ---------------------------------------------------------------------------

async function cmdList(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const cfg = loadGlobalConfig();
  const subs = managedSubs(cfg);
  if (!subs.length) { ctx.ui.notify("No managed subs. Use /subs add <provider>.", "info"); return; }
  ctx.ui.notify(subs.map(e => {
    const name = subProviderName(e);
    const auth = ctx.modelRegistry.authStorage.hasAuth(name) ? "auth" : "no auth";
    const kind = e.index > 0 ? `clone#${e.index}` : "additional";
    return `${name}  [${kind}]  (${auth})`;
  }).join("\n"), "info");
}

async function cmdAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) { ctx.ui.notify("Usage: /subs add <provider> [label]", "warning"); return; }
  const provider = parts[1];
  const label = parts.slice(2).join(" ") || undefined;
  const template = PROVIDER_TEMPLATES[provider];
  if (!template) { ctx.ui.notify(`Unknown provider "${provider}".`, "error"); return; }
  const cfg = loadGlobalConfig();
  const existing = cfg.subscriptions.filter(s => s.provider === provider);
  if (existing.length === 0) {
    cfg.subscriptions.push({ provider, index: 0, label });
    saveGlobalConfig(cfg);
    registerSub(pi, { provider, index: 0, label }, (ctx as any));
    ctx.ui.notify(`Registered "${provider}". Use /subs login ${provider}.`, "info");
  } else {
    const index = nextCloneIndex(provider, cfg.subscriptions);
    const entry: SubEntry = { provider, index, label };
    cfg.subscriptions.push(entry);
    saveGlobalConfig(cfg);
    registerSub(pi, entry, (ctx as any));
    ctx.ui.notify(`Added clone ${subProviderName(entry)}.`, "info");
  }
}

async function cmdRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
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

async function cmdLogin(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) { ctx.ui.notify("Usage: /subs login <name>", "warning"); return; }
  const name = parts[1];
  const cfg = loadGlobalConfig();
  const entry = resolveEntry(name, cfg);
  if (!entry) { ctx.ui.notify(`Not found: "${name}". Add it first.`, "error"); return; }
  const subName = subProviderName(entry);
  const ok = await systemLogin(ctx, subName);
  if (ok) ctx.ui.notify(`Logged in: ${subName}.`, "info");
}

async function cmdLogout(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) { ctx.ui.notify("Usage: /subs logout <name>", "warning"); return; }
  try {
    ctx.modelRegistry.authStorage.logout(parts[1]);
    ctx.modelRegistry.refresh();
    ctx.ui.notify(`Logged out of ${parts[1]}.`, "info");
  } catch (err: any) { ctx.ui.notify(`Logout failed: ${err?.message || err}`, "error"); }
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
  if (ok) ctx.ui.setStatus("multi-subs", name);
}

async function cmdModels(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) { ctx.ui.notify("Usage: /subs models <name>", "warning"); return; }
  const name = parts[1];
  const models = ctx.modelRegistry.getAll().filter((m: any) => m.provider === name) as any[];
  if (!models.length) { ctx.ui.notify(`No models for "${name}".`, "warning"); return; }
  ctx.ui.notify(models.map((m: any) => `${m.id}${m.reasoning ? " (reasoning)" : ""}`).join("\n"), "info");
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const cfg = loadGlobalConfig();
  for (const sub of normalizeEntries(mergeConfigs(cfg, parseEnvConfig())).filter(s => s.index > 0 || !isSystemProvider(s.provider))) {
    registerSub(pi, sub);
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    const eff = loadEffectiveConfig(ctx.cwd);
    for (const sub of eff.subscriptions.filter((s: SubEntry) => s.index > 0 || !isSystemProvider(s.provider))) {
      registerSub(pi, sub, ctx);
    }
  });

  pi.registerCommand("subs", {
    description: "Manage subscriptions — interactive menu (no args) or direct commands.",
    getArgumentCompletions: (prefix: string) => {
      const cmds = ["list", "add", "remove", "login", "logout", "switch", "models"];
      return cmds.filter(c => c.startsWith(prefix)).map(c => ({ value: c, label: c }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      // No args → interactive menu
      if (!sub) { await showMenu(pi, ctx); return; }

      // With args → direct command
      switch (sub) {
        case "list": await cmdList(pi, ctx); break;
        case "add": await cmdAdd(pi, ctx, args); break;
        case "remove": await cmdRemove(pi, ctx, args); break;
        case "login": await cmdLogin(pi, ctx, args); break;
        case "logout": await cmdLogout(pi, ctx, args); break;
        case "switch": await cmdSwitch(pi, ctx, args); break;
        case "models": await cmdModels(pi, ctx, args); break;
        default: ctx.ui.notify(`Unknown: "${sub}". /subs (no args) for interactive menu.`, "warning");
      }
    },
  });
}
