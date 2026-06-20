/**
 * Provider Initializer — registers subs from config on startup.
 * No command. Export helpers used by the clone/subs extension.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OAuthLoginCallbacks, OAuthPrompt, OAuthAuthInfo, OAuthDeviceCodeInfo, OAuthSelectPrompt } from "@earendil-works/pi-ai/oauth";
import {
  SubEntry, MultiPassConfig, PROVIDER_TEMPLATES, registerSub,
  subProviderName, loadGlobalConfig, loadEffectiveConfig,
  parseEnvConfig, mergeConfigs, normalizeEntries, saveGlobalConfig,
} from "../shared.ts";

// ---------------------------------------------------------------------------
// Exported helpers for the clone extension
// ---------------------------------------------------------------------------

export function isSystemProvider(name: string): boolean {
  return !!PROVIDER_TEMPLATES[name];
}

export function resolveEntry(name: string, cfg: MultiPassConfig): SubEntry | undefined {
  return cfg.subscriptions.find(s => subProviderName(s) === name || s.provider === name);
}

export function nextCloneIndex(provider: string, subs: SubEntry[]): number {
  const existing = subs.filter(s => s.provider === provider);
  return existing.length ? Math.max(...existing.map(s => s.index)) + 1 : 1;
}

export function buildCallbacks(ctx: ExtensionCommandContext): OAuthLoginCallbacks {
  return {
    onAuth: (info: OAuthAuthInfo) => ctx.ui.notify(`Open:\n${info.url}${info.instructions ? `\n${info.instructions}` : ""}`, "info"),
    onDeviceCode: (info: OAuthDeviceCodeInfo) => ctx.ui.notify(`Code: ${info.userCode}\nOpen ${info.verificationUri}`, "info"),
    onPrompt: async (p: OAuthPrompt) => (await ctx.ui.input(p.message, p.placeholder || "")) || "",
    onProgress: (m: string) => ctx.ui.notify(m, "info"),
    onManualCodeInput: async () => (await ctx.ui.input("Auth code:", "")) || "",
    onSelect: async (p: OAuthSelectPrompt) => ctx.ui.select(p.message, p.options.map(o => o.label)),
  };
}

/** Full login: tries OAuth, falls back to API key prompt. */
export async function systemLogin(ctx: ExtensionCommandContext, subName: string): Promise<boolean> {
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

/** Alternative-key login: always prompts (no OAuth attempt). */
export async function altKeyLogin(ctx: ExtensionCommandContext, subName: string): Promise<boolean> {
  const key = await ctx.ui.input(`Alternative API key for ${subName}:`, "");
  if (!key?.trim()) { ctx.ui.notify("Canceled.", "info"); return false; }
  ctx.modelRegistry.authStorage.set(subName, { type: "api_key", key: key.trim() });
  ctx.modelRegistry.refresh();
  return true;
}

/** Format available models from a provider template for display. */
export function describeModels(provider: string): string {
  const t = PROVIDER_TEMPLATES[provider];
  if (!t) return "(unknown)";
  const models = t.models || [];
  const builtin = t.builtinModels?.();
  const all = [...models, ...(builtin || [])];
  if (!all.length) return "(no model data)";
  return all.slice(0, 5).map(m => `  ${m.id}${m.reasoning ? " (reasoning)" : ""}`).join("\n")
    + (all.length > 5 ? `\n  … and ${all.length - 5} more` : "");
}

// ---------------------------------------------------------------------------
// Extension entry — no command, just startup registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Load global config and register managed subs on startup
  const cfg = loadGlobalConfig();
  for (const sub of normalizeEntries(mergeConfigs(cfg, parseEnvConfig())).filter(s => s.index > 0 || !isSystemProvider(s.provider))) {
    registerSub(pi, sub);
  }

  // Re-register on each session (project config may differ)
  pi.on("session_start", async (_event: any, ctx: any) => {
    const eff = loadEffectiveConfig(ctx.cwd);
    for (const sub of eff.subscriptions.filter((s: SubEntry) => s.index > 0 || !isSystemProvider(s.provider))) {
      registerSub(pi, sub, ctx);
    }
  });
}
