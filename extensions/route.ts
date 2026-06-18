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

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";

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

  nextHop(currentProvider: string, currentModel: string): { provider: string; model: string; route?: string } | null {
    for (const r of this.list()) {
      if (r.paused) continue;
      const idx = r.hops.findIndex(h => h.provider === currentProvider && h.model === currentModel);
      if (idx === -1) continue;
      for (let i = 1; i < r.hops.length; i++) {
        const ni = (idx + i) % r.hops.length;
        const hop = r.hops[ni];
        if (hop.provider === currentProvider && hop.model === currentModel) return null;
        r.cursor = ni; r.updatedAt = now(); this.markDirty();
        return { provider: hop.provider, model: hop.model, route: r.name };
      }
    }
    return findCloneModel(currentProvider, currentModel, () => this.getAuthList(), currentProvider);
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
// Interactive menu
// ---------------------------------------------------------------------------

async function showMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext, mgr: RouteManager): Promise<void> {
  const choices = ["List", "Create route", "Edit route", "Remove route", "Toggle pause", "Reset cursor", "Exit"];

  for (;;) {
    const pick = await ctx.ui.select("\n=== Route Manager ===", choices);
    if (!pick || pick === "Exit" || pick === choices[6]) break;

    switch (pick) {
      case choices[0]: // List
        ctx.ui.notify(mgr.renderSummary(), "info");
        break;

      case choices[1]: { // Create
        const name = await ctx.ui.input("Route name:", "e.g. fallback, primary");
        if (!name?.trim()) break;
        // Get list of provisioned providers for picking
        const authList = ctx.modelRegistry.authStorage.list();
        const subs = new Set(authList);
        const providers = [...subs].filter(p => p).sort();
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
              const model = modelPick === "(same model)" ? "" : (models.find((m: any) => modelOpts.slice(1).includes(`${m.id}${m.reasoning ? " (reasoning)" : ""}`))?.id || "");
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
              const authList = ctx.modelRegistry.authStorage.list();
              const providers = [...new Set(authList)].filter(p => p).sort();
              const provPick = await ctx.ui.select("New provider:", providers);
              if (!provPick) break;
              const models = ctx.modelRegistry.getAll().filter((m: any) => m.provider === provPick) as any[];
              const modelOpts = ["(same model)", ...models.map((m: any) => `${m.id}${m.reasoning ? " (reasoning)" : ""}`)];
              const modelPick = await ctx.ui.select("New model:", modelOpts);
              if (!modelPick) break;
              const model = modelPick === "(same model)" ? "" : (models.find((m: any) => modelOpts.slice(1).includes(`${m.id}${m.reasoning ? " (reasoning)" : ""}`))?.id || "");
              route.hops[idx] = { provider: provPick, model };
              route.updatedAt = now();
              mgr.markDirty();
              ctx.ui.notify(`Changed hop ${idx} to ${provPick}/${model || "*"}.`, "info");
              break;
            }
          }
        }
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
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let mgr: RouteManager | null = null;
  let initP: Promise<void> | null = null;

  async function init(): Promise<RouteManager> {
    if (mgr) return mgr;
    if (!initP) initP = loadDB().then(db => { mgr = new RouteManager(db); });
    await initP;
    return mgr!;
  }

  pi.registerCommand("route", {
    description: "Manage failover routing — interactive menu (no args) or direct commands.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const m = await init();
      m.getAuthList = () => ctx.modelRegistry.authStorage.list();

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
        default:
          ctx.ui.notify(`Unknown: "${sub}". Try /route help.`, "warning");
      }
    },
  });
}
