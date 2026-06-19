/**
 * pi Session ID — session tracking with error recovery.
 *
 * Responsibilities:
 * 1. Inject [Session-ID] into system prompt on first message and after compact
 * 2. Always apply Mistral role fix (developer → system) — Mistral rejects "developer"
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";

function sessionIdPath(): string {
  return path.join(process.env.HOME || "/data/data/com.termux/files/home", ".pi/agent/session-id");
}

async function getOrCreateSessionId(): Promise<string> {
  try { return (await fs.readFile(sessionIdPath(), "utf-8")).trim(); }
  catch {
    const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.mkdir(path.dirname(sessionIdPath()), { recursive: true });
    await fs.writeFile(sessionIdPath(), id, "utf-8");
    return id;
  }
}

export default function (pi: ExtensionAPI) {
  let sessionId = "";
  let needsReinject = true;   // first message or after compact → inject session ID

  // ── Session start: get session ID ──
  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionId = await getOrCreateSessionId();
    ctx.ui.setStatus("session-id", sessionId.slice(0, 16));
    needsReinject = true;
  });

  // ── After compact: re-inject session ID + role fix on next turn ──
  pi.on("session_compact", async () => {
    needsReinject = true;
  });

  // ── Context: fix Mistral alternation + role fix + inject session ID ──
  pi.on("context", async (event: any, _ctx: any) => {
    const msgs = event.messages || [];
    let modified = false;

    // 1) Mistral alternation fix: tool → user is not allowed.
    //    Insert empty assistant message between them.
    //    Need to iterate backwards to avoid index shifting issues.
    for (let i = msgs.length - 2; i >= 0; i--) {
      if (msgs[i].role === "tool" && msgs[i + 1].role === "user") {
        msgs.splice(i + 1, 0, { role: "assistant", content: "" });
        modified = true;
      }
    }

    // 2) Role fix: Mistral doesn't support "developer" → convert to "system"
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === "developer") {
        msgs[i] = { ...msgs[i], role: "system" };
        modified = true;
      }
    }

    // 3) Inject session ID into first system message (first msg or after compact)
    if (needsReinject) {
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].role === "system" || msgs[i].role === "developer") {
          const content = typeof msgs[i].content === "string" ? msgs[i].content : "";
          if (!content.includes("[Session-ID]")) {
            msgs[i] = {
              ...msgs[i],
              content: `[Session-ID: ${sessionId}]\n${content}`,
            };
            modified = true;
          }
          break; // only first system message
        }
      }
      needsReinject = false;
    }

    return modified ? { messages: msgs } : undefined;
  });
}
