/**
 * pi Session ID — Mistral compatibility layer
 * 
 * - Persists a session ID for Mistral's x-affinity caching
 * - Fixes Mistral's strict role alternation (tool → assistant → user)
 *   by inserting an assistant message between toolResult → user
 *   directly in the API payload.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";

function sessionIdPath(): string {
  return path.join(process.env.HOME || "/data/data/com.termux/files/home", ".pi/agent/session-id");
}

async function getOrCreateSessionId(): Promise<string> {
  try {
    return (await fs.readFile(sessionIdPath(), "utf-8")).trim();
  } catch {
    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.mkdir(path.dirname(sessionIdPath()), { recursive: true });
    await fs.writeFile(sessionIdPath(), id, "utf-8");
    return id;
  }
}

/**
 * Check if a model ID is Mistral-based (direct or provider-prefixed).
 */
function isMistralModel(modelId?: string): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  const name = id.split("/").pop() || id;
  return /^mistral[-.]/.test(name) || name.startsWith("mistral");
}

/**
 * Insert an assistant message between tool → user in the messages array.
 * Mistral strict-mode APIs reject tool → user; they require tool → assistant → user.
 * Modifies the array in-place and returns true if any change was made.
 */
function ensureToolAssistantUser(msgs: any[]): boolean {
  let modified = false;
  for (let i = 0; i < msgs.length - 1; i++) {
    if (msgs[i]?.role === "tool" && msgs[i + 1]?.role === "user") {
      msgs.splice(i + 1, 0, {
        role: "assistant",
        content: "Continuing",
      });
      modified = true;
      i++; // skip the inserted assistant
    }
  }
  return modified;
}

export default function (pi: ExtensionAPI) {
  let sessionId = "";

  // ── Session start ──
  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionId = await getOrCreateSessionId();
    ctx.ui.setStatus("session-id", sessionId.slice(0, 16));
  });

  // ── Before provider request: fix Mistral role alternation ──
  let mistralFixNotified = false;
  pi.on("before_provider_request", async (event: any, ctx: ExtensionContext) => {
    // Only applies to Mistral-based models
    if (!isMistralModel(ctx?.model?.id)) {
      mistralFixNotified = false;
      return;
    }

    if (!mistralFixNotified) {
      mistralFixNotified = true;
      ctx.ui.notify(`Mistral tool role fix: ${ctx.model?.id || "?"}`, "info");
    }

    const msgs = event?.payload?.messages;
    if (!msgs || !Array.isArray(msgs) || msgs.length < 2) return;

    if (ensureToolAssistantUser(msgs)) {
      return event.payload;
    }
  });
}
