/**
 * pi Session ID — session tracking with error recovery.
 *
 * Responsibilities:
 * 1. Inject [Session-ID] into system prompt on first message and after compact
 * 2. Always apply Mistral role fix (developer → system) — Mistral rejects "developer"
 * 3. Remove tool/toolResult messages for Mistral compatibility
 * 4. Log 400 errors with message history for debugging
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

function fixMistralMessages(msgs: any[]): { messages: any[]; modified: boolean } {
  let modified = false;
  const messages = [...msgs]; // Work on a copy

  // 1) Remove tool and toolResult messages - Mistral doesn't support them
  // These are internal pi messages for tool calls, not part of the conversation
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool" || messages[i].role === "toolResult") {
      messages.splice(i, 1);
      modified = true;
    }
  }

  // 2) Role fix: Mistral doesn't support "developer" → convert to "system"
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "developer") {
      messages[i] = { ...messages[i], role: "system" };
      modified = true;
    }
  }

  return { messages, modified };
}

function logRoles(msgs: any[], label: string) {
  const roles = msgs.map((m: any) => m.role).join(" → ");
  console.log(`[session-id] ${label}: ${roles}`);
}

export default function (pi: ExtensionAPI) {
  let sessionId = "";
  let needsReinject = true;

  // ── Session start: get session ID ──
  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionId = await getOrCreateSessionId();
    ctx.ui.setStatus("session-id", sessionId.slice(0, 16));
    needsReinject = true;
  });

  // ── After compact: re-inject session ID on next turn ──
  pi.on("session_compact", async () => {
    needsReinject = true;
  });

  // ── Context: fix messages + inject session ID ──
  pi.on("context", async (event: any, ctx: any) => {
    const msgs = event.messages || [];
    const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
    
    const { messages, modified: rolesModified } = fixMistralMessages(msgs);
    let modified = rolesModified;
    
    const rolesAfter = messages.map((m: any) => m.role).join(" → ");
    if (rolesBefore !== rolesAfter) {
      console.log(`[session-id] context fix: ${rolesBefore} → ${rolesAfter}`);
    }

    // 3) Inject session ID into first system message (first msg or after compact)
    if (needsReinject) {
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === "system" || messages[i].role === "developer") {
          const content = typeof messages[i].content === "string" ? messages[i].content : "";
          if (!content.includes("[Session-ID]")) {
            messages[i] = {
              ...messages[i],
              content: `[Session-ID: ${sessionId}]\n${content}`,
            };
            modified = true;
          }
          break; // only first system message
        }
      }
      needsReinject = false;
    }

    return modified ? { messages } : undefined;
  });

  // ── Model request: also fix messages at the API level ──
  pi.on("model_request", async (event: any) => {
    const msgs = event.messages || [];
    const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
    
    const { messages, modified } = fixMistralMessages(msgs);
    
    const rolesAfter = messages.map((m: any) => m.role).join(" → ");
    if (rolesBefore !== rolesAfter) {
      console.log(`[session-id] model_request fix: ${rolesBefore} → ${rolesAfter}`);
    }
    
    return modified ? { messages } : undefined;
  });

  // ── Error handling: log 400 errors with message history ──
  pi.on("model_error", async (event: any) => {
    if (event.error && event.error.statusCode === 400) {
      const errorMsg = event.error.message || String(event.error);
      const messages = event.messages || [];
      const roles = messages.map((m: any) => m.role).join(" → ");
      
      console.log(`[session-id] 400 ERROR: ${errorMsg}`);
      console.log(`[session-id] Message roles: ${roles}`);
      console.log(`[session-id] Full messages:`);
      messages.forEach((msg: any, idx: number) => {
        console.log(`[session-id] [${idx}] ${msg.role}: ${typeof msg.content === 'string' ? msg.content.slice(0, 100) : JSON.stringify(msg.content).slice(0, 100)}...`);
      });
    }
  });
}
