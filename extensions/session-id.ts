/**
 * pi Session ID — session tracking with error recovery.
 *
 * Responsibilities:
 * 1. Send session ID as SYSTEM message as first message to model
 * 2. Always apply Mistral role fix (developer, compactionSummary → system)
 * 3. Remove tool/toolResult messages for Mistral compatibility
 * 4. Log fixes for debugging
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

function fixMistralMessages(msgs: any[], sessionId: string, needsReinject: boolean): { messages: any[]; modified: boolean } {
  let modified = false;
  let messages = [...msgs]; // Work on a copy

  // 1) If we need to inject session ID, add it as FIRST system message
  if (needsReinject) {
    // Check if there's already a session ID message
    const hasSessionIdMsg = messages.some((m: any) => 
      m.role === "system" && 
      typeof m.content === "string" && 
      m.content.includes(`[Session-ID: ${sessionId}]`)
    );
    
    if (!hasSessionIdMsg) {
      // Add session ID as first system message
      messages.unshift({
        role: "system",
        content: `[Session-ID: ${sessionId}]`,
      });
      modified = true;
      console.log(`[session-id] Added session ID as system message`);
    }
  }

  // 2) Role fix: Convert non-Mistral roles to system
  // Mistral only supports: system, user, assistant, tool
  // But tool/toolResult will be removed below, so convert others to system
  const rolesToConvert = new Set(["developer", "compactionSummary"]);
  for (let i = 0; i < messages.length; i++) {
    if (rolesToConvert.has(messages[i].role)) {
      messages[i] = { ...messages[i], role: "system" };
      modified = true;
    }
  }

  // 3) Remove tool and toolResult messages - Mistral doesn't support them
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool" || messages[i].role === "toolResult") {
      messages.splice(i, 1);
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

  // ── Context: fix messages + inject session ID as first system message ──
  pi.on("context", async (event: any, ctx: any) => {
    const msgs = event.messages || [];
    const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
    
    const { messages, modified: rolesModified } = fixMistralMessages(msgs, sessionId, needsReinject);
    let modified = rolesModified;
    
    const rolesAfter = messages.map((m: any) => m.role).join(" → ");
    if (rolesBefore !== rolesAfter) {
      console.log(`[session-id] context fix: ${rolesBefore} → ${rolesAfter}`);
    }

    // Reset needsReinject after processing
    if (needsReinject) {
      needsReinject = false;
    }

    return modified ? { messages } : undefined;
  });

  // ── Model request: also fix messages at the API level ──
  pi.on("model_request", async (event: any) => {
    const msgs = event.messages || [];
    const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
    
    const { messages, modified } = fixMistralMessages(msgs, sessionId, false);
    
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
    }
  });
}
