/**
 * pi Route Manager — interactive menu.
 *
 * /route with no args opens interactive menu:
 *   List, Create, Remove, Toggle, Reset
 *
 * Two routing modes:
 * 1. Clone auto-route: multiple subs of same provider (openai-1, openai-2)
 *    auto-rotate on failure, same model, next clone. Auto-detected.
 * 2. Explicit routes: user-defined provider/model chains for failover.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRateLimitError } from "../shared.ts";

interface RouteHop { provider: string; model: string; }
interface RouteDef {
  name: string;
  hops: RouteHop[];
  cursor: number;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
}
interface RouteDB { version: number; explicit: Record<string, RouteDef>; }

function dbPath(): string {
  return path.join(process.env.HOME || "/data/data/com.termux/files/home", ".pi/agent/pi-routes.json");
}
async function loadDB(): Promise<RouteDB> {
  try { return JSON.parse(await fs.readFile(dbPath(), "utf-8")); }
  catch { return { version: 1, explicit: {} }; }
}
async function saveDB(db: RouteDB): Promise<void> {
  const p = dbPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(db, null, 2), "utf-8");
}

function now(): number { return Date.now(); }
function baseProvider(name: string): string { return name.replace(/-\d+$/, ""); }

function getCloneGroups(getAuthList: () => string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const p of getAuthList()) {
    const base = baseProvider(p);
    if (!map.has(base)) map.set(base, []);
    map.get(base)!.push(p);
  }
  for (const [k, v] of map) if (v.length < 2 || k === v[0]) map.delete(k);
  return map;
}

function findCloneModel(provider: string, model: string, getAuthList: () => string[], skip?: string): { provider: string; model: string } | null {
  const base = baseProvider(provider);
  if (base === provider) return null;
  const clones = getCloneGroups(getAuthList).get(base);
  if (!clones) return null;
  for (const c of clones) if (c !== (skip ?? provider)) return { provider: c, model };
  return null;
}

class RouteManager {
  private db: RouteDB;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  getAuthList: () => string[] = () => [];

  constructor(init: RouteDB) { this.db = init; }

  list(): RouteDef[] { return Object.values(this.db.explicit).sort((a, b) => a.name.localeCompare(b.name)); }
  get(name: string): RouteDef | undefined { return this.db.explicit[name]; }

  create(name: string, hops: RouteHop[]): RouteDef | string {
    if (this.db.explicit[name]) return `Route "${name}" exists.`;
    if (hops.length < 2) return "Need >= 2 hops.";
    const t = now();
    const r: RouteDef = { name, hops, cursor: 0, paused: false, createdAt: t, updatedAt: t };
    this.db.explicit[name] = r;
    this.markDirty();
    return r;
  }
  remove(name: string): boolean {
    if (!this.db.explicit[name]) return false;
    delete this.db.explicit[name];
    this.markDirty();
    return true;
  }
  toggle(name: string): RouteDef | string {
    const r = this.db.explicit[name];
    if (!r) return `Not found: "${name}"`;
    r.paused = !r.paused; r.updatedAt = now(); this.markDirty();
    return r;
  }
  reset(name: string): RouteDef | string {
    const r = this.db.explicit[name];
    if (!r) return `Not found: "${name}"`;
    r.cursor = 0; r.updatedAt = now(); this.markDirty();
    return r;
  }

  /**
   * Match a hop against a provider/model pair.
   * Empty model string matches any model (wildcard).
   */
  private matchHop(hop: RouteHop, provider: string, model: string): boolean {
    return hop.provider === provider && (hop.model === "" || hop.model === model);
  }

  /**
   * Find the next hop in a route after the current provider/model fails.
   * Returns null if no failover is available.
   * Empty model in a hop acts as wildcard (keeps same model).
   * @param skipIf Optional function to skip certain provider names (e.g., cooldown check).
   */
  nextHop(
    currentProvider: string,
    currentModel: string,
    skipIf?: (provider: string) => boolean,
  ): { provider: string; model: string; route?: string } | null {
    // Try explicit routes first
    for (const r of this.list()) {
      if (r.paused) continue;
      const idx = r.hops.findIndex(h => this.matchHop(h, currentProvider, currentModel));
      if (idx === -1) continue;
      // Try subsequent hops, wrapping around
      for (let i = 1; i < r.hops.length; i++) {
        const ni = (idx + i) % r.hops.length;
        const hop = r.hops[ni];
        // Skip if same as current (wrapped all the way around)
        if (this.matchHop(hop, currentProvider, currentModel)) continue;
        // Skip if this provider is on cooldown or otherwise disallowed
        if (skipIf?.(hop.provider)) continue;
        // Empty model means keep same model from current provider
        const model = hop.model || currentModel;
        r.cursor = ni; r.updatedAt = now(); this.markDirty();
        return { provider: hop.provider, model, route: r.name };
      }
    }
    // Fallback to clone auto-routing: same model, next clone of same base provider
    // (also respects skipIf via the skip parameter)
    const cloneResult = findCloneModel(currentProvider, currentModel, () => this.getAuthList(), currentProvider);
    if (cloneResult && skipIf?.(cloneResult.provider)) return null;
    return cloneResult;
  }

  renderSummary(): string {
    const parts: string[] = [];
    const exp = this.list();
    if (exp.length) {
      parts.push("Explicit routes:");
      parts.push(exp.map(r => {
        const cur = r.hops[r.cursor] || { provider: "?", model: "?" };
        return `  ${r.paused ? "paused" : "active"}  ${r.name.padEnd(20)} ${cur.provider}/${cur.model}  (cursor=${r.cursor})`;
      }).join("\n"));
    }
    const clones = [...getCloneGroups(() => this.getAuthList()).entries()];
    if (clones.length) {
      parts.push("Clone auto-route groups:");
      parts.push(clones.map(([b, c]) => `  ${b}: ${c.join(", ")}`).join("\n"));
    }
    return parts.length ? parts.join("\n\n") : "No routes.";
  }

  markDirty(): void {
    if (this.dirty) return;
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 2000);
  }
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    await saveDB(this.db);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return all provider names that have auth (stored, env, runtime). */
function allAuthedProviders(ctx: ExtensionCommandContext): string[] {
  const as = ctx.modelRegistry.authStorage;
  const stored = as.list();
  const allModels = ctx.modelRegistry.getAll() as any[];
  const allProvs = [...new Set(allModels.map((m: any) => m.provider))];
  const envAuthed = allProvs.filter(p => !stored.includes(p) && as.hasAuth(p));
  return [...new Set([...stored, ...envAuthed])].filter(Boolean).sort();
}

// ---------------------------------------------------------------------------
// Edit route — add/remove/change hops
// ---------------------------------------------------------------------------

async function editRoute(mgr: RouteManager, route: RouteDef, ctx: ExtensionCommandContext): Promise<void> {
  const rn = route.name;
  const editOpts = ["Add hop", "Remove hop", "Change a hop", "Cancel"];
  for (;;) {
    const act = await ctx.ui.select(`\nEditing "${rn}" — ${route.hops.map(h => `${h.provider}/${h.model || "*"}`).join(" -> ")}`, editOpts);
    if (!act || act === "Cancel") break;
    switch (act) {
      case "Add hop": {
        const authList = ctx.modelRegistry.authStorage.list();
        const providers = [...new Set(authList)].filter(p => p).sort();
        if (!providers.length) { ctx.ui.notify("No providers.", "info"); break; }
        const provPick = await ctx.ui.select("Pick provider:", providers);
        if (!provPick) break;
        const models = ctx.modelRegistry.getAll().filter((m: any) => m.provider === provPick) as any[];
        const modelOpts = ["(same model)", ...models.map((m: any) => `${m.id}${m.reasoning ? " (reasoning)" : ""}`)];
        const modelPick = await ctx.ui.select("Pick model:", modelOpts);
        if (!modelPick) break;
        const mi = modelOpts.indexOf(modelPick);
        const model = mi > 0 ? (models[mi - 1]?.id || "") : "";
        route.hops.push({ provider: provPick, model });
        route.updatedAt = now();
        mgr.markDirty();
        ctx.ui.notify(`Added hop: ${provPick}/${model || "*"}`, "info");
        break;
      }
      case "Remove hop": {
        if (route.hops.length <= 2) { ctx.ui.notify("Need at least 2 hops.", "warning"); break; }
        const hopLabels = route.hops.map((h, i) => `${i}: ${h.provider}/${h.model || "*"}`);
        const hp = await ctx.ui.select("Remove which hop?", hopLabels);
        if (!hp) break;
        const idx = parseInt(hp.split(":")[0]);
        route.hops.splice(idx, 1);
        if (route.cursor >= route.hops.length) route.cursor = 0;
        route.updatedAt = now();
        mgr.markDirty();
        ctx.ui.notify(`Removed hop ${idx}.`, "info");
        break;
      }
      case "Change a hop": {
        const hopLabels = route.hops.map((h, i) => `${i}: ${h.provider}/${h.model || "*"}`);
        const hp = await ctx.ui.select("Change which hop?", hopLabels);
        if (!hp) break;
        const idx = parseInt(hp.split(":")[0]);
        const providers = allAuthedProviders(ctx);
        const provPick = await ctx.ui.select("New provider:", providers);
        if (!provPick) break;
        const models = ctx.modelRegistry.getAll().filter((m: any) => m.provider === provPick) as any[];
        const modelOpts = ["(same model)", ...models.map((m: any) => `${m.id}${m.reasoning ? " (reasoning)" : ""}`)];
        const modelPick = await ctx.ui.select("New model:", modelOpts);
        if (!modelPick) break;
        const mi = modelOpts.indexOf(modelPick);
        const model = mi > 0 ? (models[mi - 1]?.id || "") : "";
        route.hops[idx] = { provider: provPick, model };
        route.updatedAt = now();
        mgr.markDirty();
        ctx.ui.notify(`Changed hop ${idx} to ${provPick}/${model || "*"}.`, "info");
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Interactive menu
// ---------------------------------------------------------------------------

async function showMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext, mgr: RouteManager): Promise<void> {
  const choices = ["List", "Create route", "Edit route", "Remove route", "Toggle pause", "Reset cursor", "Exit"];

  for (;;) {
    const pick = await ctx.ui.select("\n=== Route Manager ===", choices);
    if (!pick || pick === "Exit" || pick === choices[6]) break;

    switch (pick) {
      case choices[0]: { // List → pick route → action
        const routes = mgr.list();
        if (!routes.length) { ctx.ui.notify("No routes.", "info"); break; }
        const routeLabels = routes.map(r => {
          const cur = r.hops[r.cursor] || { provider: "?", model: "?" };
          return `${r.paused ? "⏸" : "▶"} ${r.name}  → ${cur.provider}/${cur.model}  [cursor=${r.cursor}]`;
        });
        const picked = await ctx.ui.select("Select route:", routeLabels);
        if (!picked) break;
        const ri = routeLabels.indexOf(picked);
        if (ri < 0) break;
        const route = routes[ri];
        const actions = ["Edit route", "Remove route", "Toggle pause", "Reset cursor", "Cancel"];
        const act = await ctx.ui.select(`Route: ${route.name}`, actions);
        if (!act || act === "Cancel") break;
        if (act === "Edit route") { await editRoute(mgr, route, ctx); break; }
        if (act === "Remove route") {
          mgr.removeRoute(route.name);
          ctx.ui.notify(`Removed "${route.name}".`, "info");
          break;
        }
        if (act === "Toggle pause") {
          route.paused = !route.paused;
          route.updatedAt = now();
          mgr.markDirty();
          ctx.ui.notify(`${route.paused ? "Paused" : "Unpaused"} "${route.name}".`, "info");
          break;
        }
        if (act === "Reset cursor") {
          route.cursor = 0;
          route.updatedAt = now();
          mgr.markDirty();
          ctx.ui.notify(`Reset cursor for "${route.name}".`, "info");
          break;
        }
        break;
      }

      case choices[1]: { // Create
        const name = await ctx.ui.input("Route name:", "e.g. fallback, primary");
        if (!name?.trim()) break;
        // Get list of provisioned providers for picking
        const providers = allAuthedProviders(ctx);
        if (!providers.length) { ctx.ui.notify("No provisioned providers found. Login to a provider first.", "info"); break; }
        // Collect hops
        const hops: RouteHop[] = [];
        for (;;) {
          const provPick = await ctx.ui.select(`Hop ${hops.length + 1}: pick provider:`, ["(finish — create route)", ...providers]);
          if (!provPick || provPick === "(finish — create route)") break;
          // Optional model pick — skip for same-model auto-route
          const models = ctx.modelRegistry.getAll().filter((m: any) => m.provider === provPick) as any[];
          const modelOpts = ["(same model — auto failover)", ...models.map((m: any) => `${m.id}${m.reasoning ? " (reasoning)" : ""}`)];
          const modelPick = await ctx.ui.select(`Hop ${hops.length + 1}: pick model for ${provPick}:`, modelOpts);
          if (!modelPick || modelPick === "(same model — auto failover)") {
            hops.push({ provider: provPick, model: "" });
          } else {
            const mi = modelOpts.indexOf(modelPick);
            hops.push({ provider: provPick, model: mi >= 1 ? models[mi - 1].id : "" });
          }
        }
        if (hops.length < 2) { ctx.ui.notify("Need at least 2 hops.", "warning"); break; }
        const r = mgr.create(name.trim(), hops);
        if (typeof r === "string") ctx.ui.notify(r, "error");
        else ctx.ui.notify(`Route "${name}": ${hops.map(h => `${h.provider}/${h.model || "(same model)"}`).join(" -> ")}`, "info");
        break;
      }

      case choices[2]: { // Edit
        const routes = mgr.list();
        if (!routes.length) { ctx.ui.notify("No routes to edit.", "info"); break; }
        const rn = await ctx.ui.select("Edit which route?", routes.map(r => r.name));
        if (!rn) break;
        const route = mgr.get(rn)!;
        await editRoute(mgr, route, ctx);
        break;
      }

      case choices[3]: { // Remove
        const routes = mgr.list();
        if (!routes.length) { ctx.ui.notify("No routes.", "info"); break; }
        const names = routes.map(r => r.name);
        const pick = await ctx.ui.select("Remove which route?", names);
        if (!pick) break;
        mgr.remove(pick);
        ctx.ui.notify(`Removed "${pick}".`, "info");
        break;
      }

      case choices[4]: { // Toggle
        const routes = mgr.list();
        if (!routes.length) { ctx.ui.notify("No routes.", "info"); break; }
        const names = routes.map(r => `${r.name}  (${r.paused ? "paused" : "active"})`);
        const pick = await ctx.ui.select("Toggle which route?", names);
        if (!pick) break;
        const rn = pick.split("  ")[0]; // extract name
        const r = mgr.toggle(rn);
        ctx.ui.notify(typeof r === "string" ? r : `"${rn}" ${r.paused ? "paused" : "resumed"}.`, "info");
        break;
      }

      case choices[5]: { // Reset
        const routes = mgr.list();
        if (!routes.length) { ctx.ui.notify("No routes.", "info"); break; }
        const names = routes.map(r => r.name);
        const pick = await ctx.ui.select("Reset which route?", names);
        if (!pick) break;
        const r = mgr.reset(pick);
        ctx.ui.notify(typeof r === "string" ? r : `"${pick}" cursor reset.`, "info");
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-failover on 429 (rate limit) — hooks into after_provider_response
// ---------------------------------------------------------------------------

/**
 * Find a Model object for the given provider and model ID.
 * If modelId is empty/undefined, returns the first available model for that provider.
 */
function resolveModel(ctx: ExtensionContext, provider: string, modelId: string, fallbackModelId?: string): Model<Api> | undefined {
  const models = ctx.modelRegistry.getAll().filter((m: any) => m.provider === provider) as Model<Api>[];
  if (!models.length) return undefined;
  // Empty modelId means "same model" — try to find matching fallback ID first
  const id = modelId || fallbackModelId || "";
  if (!id) return models[0];
  return models.find(m => m.id === id) || models[0];
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let mgr: RouteManager | null = null;
  let initP: Promise<void> | null = null;
  let pendingSwitch: { routeName: string; provider: string; model: string } | null = null;

  async function init(): Promise<RouteManager> {
    if (mgr) return mgr;
    if (!initP) initP = loadDB().then(db => { mgr = new RouteManager(db); });
    await initP;
    return mgr!;
  }

  /** Ensure mgr is initialized before handling events */
  async function ensureInit(ctx: ExtensionContext): Promise<RouteManager> {
    const m = await init();
    m.getAuthList = () => {
      const stored = ctx.modelRegistry.authStorage.list();
      const allModels = ctx.modelRegistry.getAll() as any[];
      const allProvs = [...new Set(allModels.map((m: any) => m.provider))];
      const envAuthed = allProvs.filter(p => ctx.modelRegistry.authStorage.hasAuth(p));
      return [...new Set([...stored, ...envAuthed])];
    };
    return m;
  }

  /** Cooldown map: provider → timestamp when it can be retried */
  const cooldowns = new Map<string, number>();
  const COOLDOWN_MS = 30_000; // 30 seconds

  /** Debounce: prevent multiple failover attempts for the same error cascade */
  let lastFailoverAt = 0;
  const FAILOVER_DEBOUNCE_MS = 5_000;

  /** Check if a provider is on cooldown */
  function isOnCooldown(provider: string): boolean {
    const until = cooldowns.get(provider);
    return until !== undefined && Date.now() < until;
  }

  /** Mark a provider as cooldown (should not be retried for a while) */
  function markCooldown(provider: string): void {
    cooldowns.set(provider, Date.now() + COOLDOWN_MS);
  }

  /**
   * Attempt failover: find next hop and switch to it.
   * Returns true if failover succeeded, false otherwise.
   */
  async function tryFailover(ctx: ExtensionContext, errorMsg?: string): Promise<boolean> {
    // Debounce: if we just did a failover, skip to avoid double-triggering
    const now = Date.now();
    if (now - lastFailoverAt < FAILOVER_DEBOUNCE_MS) return false;
    lastFailoverAt = now;

    const currentModel = ctx.model;
    if (!currentModel) return false;

    const m = await ensureInit(ctx);

    // Mark current provider as cooldown so nextHop can skip it
    markCooldown(currentModel.provider);

    const next = m.nextHop(currentModel.provider, currentModel.id, isOnCooldown);
    if (!next) {
      if (errorMsg) {
        ctx.ui.notify(`Rate limited on ${currentModel.provider}/${currentModel.id} — no failover route found.`, "warning");
      }
      return false;
    }

    const targetModel = resolveModel(ctx, next.provider, next.model, currentModel.id);
    if (!targetModel) {
      ctx.ui.notify(`Failover: next hop ${next.provider}/${next.model} has no registered model.`, "error");
      return false;
    }

    // Check if target provider has auth; if not, prompt for login
    const authedProviders = allAuthedProviders(ctx);
    if (!authedProviders.includes(next.provider)) {
      ctx.ui.notify(`Failover target ${next.provider} needs auth — login required`, "warning");
      // Try to auto-login via subs extension
      try {
        await ctx.modelRegistry.authStorage.login(next.provider, {
          onAuth: (info) => ctx.ui.notify(`Open: ${info.url}${info.instructions ? `
${info.instructions}` : ""}`, "info"),
          onDeviceCode: (info) => ctx.ui.notify(`Code: ${info.userCode}
Open ${info.verificationUri}`, "info"),
          onPrompt: async (p) => (await ctx.ui.input(p.message, p.placeholder || "")) || "",
          onProgress: (msg) => ctx.ui.notify(msg, "info"),
          onManualCodeInput: async () => (await ctx.ui.input("Auth code:", "")) || "",
          onSelect: async (p) => ctx.ui.select(p.message, p.options.map(o => o.label)),
        });
        ctx.modelRegistry.refresh();
        ctx.ui.notify(`Logged in to ${next.provider}`, "info");
      } catch {
        // OAuth failed, fall back to API key
        const key = await ctx.ui.input(`API key for ${next.provider}:`, "");
        if (key?.trim()) {
          ctx.modelRegistry.authStorage.set(next.provider, { type: "api_key", key: key.trim() });
          ctx.modelRegistry.refresh();
          ctx.ui.notify(`API key set for ${next.provider}`, "info");
        } else {
          ctx.ui.notify(`No auth provided for ${next.provider} — API calls may fail`, "warning");
        }
      }
    }

    const ok = await pi.setModel(targetModel);
    if (ok) {
      const routeInfo = next.route ? ` (route: ${next.route})` : "";
      ctx.ui.notify(`Switched: ${currentModel.provider}/${currentModel.id} → ${next.provider}/${next.model}${routeInfo}`, "info");
      return true;
    } else {
      ctx.ui.notify(`Failover: failed to switch to ${next.provider}/${next.model}.`, "error");
      return false;
    }
  }

  // ── Before provider request: apply pending route switch ──
  pi.on("before_provider_request", async (_event: any, ctx: ExtensionContext) => {
    if (!pendingSwitch) return;
    const ps = pendingSwitch;
    pendingSwitch = null;

    const targetModel = resolveModel(ctx, ps.provider, ps.model, ctx.model?.id);
    if (!targetModel) {
      ctx.ui.notify(`Pending switch: no model found for ${ps.provider}/${ps.model || "*"}.`, "error");
      return;
    }
    const ok = await pi.setModel(targetModel);
    if (ok) {
      ctx.ui.notify(`Pending route "${ps.routeName}" applied: ${targetModel.provider}/${targetModel.id}`, "info");
      ctx.ui.setStatus("route", targetModel.provider);
    } else {
      ctx.ui.notify(`Pending route "${ps.routeName}" failed.`, "error");
    }
  });

  // ── Fast path: detect 429 HTTP responses ──
  pi.on("after_provider_response", async (event: any, ctx: ExtensionContext) => {
    if (event.status !== 429) return;
    ctx.ui.notify(`HTTP 429 detected — attempting failover`, "warning");
    await tryFailover(ctx);
  });

  // ── Main path: catch rate limit errors from agent_end (matches error messages) ──
  pi.on("agent_end", async (event: any, ctx: ExtensionContext) => {
    if (!event.messages?.length) return;
    const lastMsg = event.messages[event.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;
    if (lastMsg.stopReason !== "error") return;
    if (!lastMsg.errorMessage) return;

    // Only trigger failover on rate-limit-like errors
    if (!isRateLimitError(lastMsg.errorMessage)) return;

    ctx.ui.notify(`Rate limit error detected in agent_end — attempting failover`, "warning");
    await tryFailover(ctx, lastMsg.errorMessage);
  });

  pi.registerCommand("route", {
    description: "Manage failover routing — interactive menu (no args) or direct commands.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const m = await init();
      m.getAuthList = () => {
        const stored = ctx.modelRegistry.authStorage.list();
        const allModels = ctx.modelRegistry.getAll() as any[];
        const allProvs = [...new Set(allModels.map((m: any) => m.provider))];
        const envAuthed = allProvs.filter(p => ctx.modelRegistry.authStorage.hasAuth(p));
        return [...new Set([...stored, ...envAuthed])];
      };

      const parts = _args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      // No args → interactive menu
      if (!sub) { await showMenu(pi, ctx, m); return; }

      if (sub === "help") {
        ctx.ui.notify(
          "/route commands:\n" +
          "  list               Show all routes + clone groups\n" +
          "  create <name> <p/m> [<p/m> ...]  Create explicit route\n" +
          "  remove <name>\n" +
          "  toggle <name>      Pause/resume\n" +
          "  reset <name>       Reset cursor to first hop\n" +
          "  switch [name]     Schedule switch to a route (pick list if no name) on next API call\n" +
          "Clone auto-route: providers with clones auto-rotate on failure.",
          "info");
        return;
      }

      switch (sub) {
        case "list":
          ctx.ui.notify(m.renderSummary(), "info");
          break;
        case "create": {
          const name = parts[1], hps = parts.slice(2);
          if (!name || hps.length < 2) { ctx.ui.notify("Usage: /route create <name> <p1/m1> [<p2/m2> ...]", "warning"); return; }
          const hops: RouteHop[] = [];
          for (const hp of hps) {
            const s = hp.indexOf("/");
            if (s === -1) { ctx.ui.notify(`Invalid "${hp}" — need provider/model.`, "error"); return; }
            hops.push({ provider: hp.slice(0, s), model: hp.slice(s + 1) });
          }
          const r = m.create(name, hops);
          if (typeof r === "string") ctx.ui.notify(r, "error");
          else ctx.ui.notify(`Route "${name}": ${hops.map(h => `${h.provider}/${h.model}`).join(" -> ")}`, "info");
          break;
        }
        case "remove": {
          const n = parts[1];
          if (!n) { ctx.ui.notify("Usage: /route remove <name>", "warning"); return; }
          ctx.ui.notify(m.remove(n) ? `Removed "${n}".` : `Not found: "${n}".`, "info");
          break;
        }
        case "toggle": {
          const n = parts[1];
          if (!n) { ctx.ui.notify("Usage: /route toggle <name>", "warning"); return; }
          const r = m.toggle(n);
          ctx.ui.notify(typeof r === "string" ? r : `"${n}" ${r.paused ? "paused" : "resumed"}.`, "info");
          break;
        }
        case "reset": {
          const n = parts[1];
          if (!n) { ctx.ui.notify("Usage: /route reset <name>", "warning"); return; }
          const r = m.reset(n);
          ctx.ui.notify(typeof r === "string" ? r : `"${n}" reset.`, "info");
          break;
        }
        case "switch": {
          const n = parts[1];
          if (!n) {
            // Default: pick the first unpaused route's current hop
            const routes = m.list().filter(r => !r.paused);
            if (!routes.length) { ctx.ui.notify("No unpaused routes to switch to.", "info"); break; }
            const labels = routes.map(r => {
              const cur = r.hops[r.cursor] || { provider: "?", model: "?" };
              return `${r.name}  → ${cur.provider}/${cur.model}`;
            });
            const pick = await ctx.ui.select("Switch to which route?", labels);
            if (!pick) break;
            const ri = labels.indexOf(pick);
            if (ri < 0) break;
            const pickedRoute = routes[ri];
            const hop = pickedRoute.hops[pickedRoute.cursor];
            if (!hop) { ctx.ui.notify(`Route "${pickedRoute.name}" has no hops.`, "error"); break; }
            pendingSwitch = { routeName: pickedRoute.name, provider: hop.provider, model: hop.model };
            ctx.ui.notify(`Pending switch to route "${pickedRoute.name}" (${hop.provider}/${hop.model || "*"}) — will apply on next API call.`, "info");
          } else {
            const r = m.get(n);
            if (!r) { ctx.ui.notify(`Route "${n}" not found.`, "error"); break; }
            if (r.paused) { ctx.ui.notify(`Route "${n}" is paused. Resume it first.`, "warning"); break; }
            const hop = r.hops[r.cursor];
            if (!hop) { ctx.ui.notify(`Route "${n}" has no hops.`, "error"); break; }
            pendingSwitch = { routeName: n, provider: hop.provider, model: hop.model };
            ctx.ui.notify(`Pending switch to route "${n}" (${hop.provider}/${hop.model || "*"}) — will apply on next API call.`, "info");
          }
          break;
        }
        default:
          ctx.ui.notify(`Unknown: "${sub}". Try /route help.`, "warning");
      }
    },
  });
}
