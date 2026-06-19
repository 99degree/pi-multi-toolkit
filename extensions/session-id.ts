/**
 * pi Session ID — session tracking with error recovery for Mistral.
 *
 * Strategy:
 * - Only apply fixes if previous response was 400 error
 * - Send session ID as SYSTEM message as first message
 * - Convert compactionSummary, developer → system
 * - Remove tool/toolResult/bashExecution messages
 * - Clean up consecutive system messages
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

function cleanForMistral(msgs: any[], sessionId: string, needsReinject: boolean): { messages: any[]; modified: boolean } {
  let modified = false;
  let messages = [...msgs];

  // 1) Add session ID as FIRST system message if needed
  if (needsReinject) {
    const hasSessionIdMsg = messages.some((m: any) => 
      m.role === "system" && 
      typeof m.content === "string" && 
      m.content.includes(`[Session-ID: ${sessionId}]`)
    );
    
    if (!hasSessionIdMsg) {
      messages.unshift({
        role: "system",
        content: `[Session-ID: ${sessionId}]`,
      });
      modified = true;
    }
  }

  // 2) Convert non-standard roles to standard ones
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "compactionSummary" || messages[i].role === "developer") {
      messages[i] = { ...messages[i], role: "system" };
      modified = true;
    }
  }

  // 3) Remove tool-related messages entirely
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool" || messages[i].role === "toolResult" || messages[i].role === "bashExecution") {
      messages.splice(i, 1);
      modified = true;
    }
  }

  // 4) Clean up consecutive system messages (keep only first)
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === "system" && messages[i-1].role === "system") {
      if (i === 1 && messages[i-1].content && messages[i-1].content.includes("[Session-ID:")) {
        messages.splice(i, 1);
        modified = true;
        i--;
      } else if (messages[i].content && messages[i].content.includes("[Session-ID:")) {
        messages.splice(i-1, 1);
        modified = true;
        i--;
      } else {
        messages.splice(i, 1);
        modified = true;
        i--;
      }
    }
  }

  // 5) Final validation: ensure valid sequence
  for (let i = 0; i < messages.length - 1; i++) {
    const current = messages[i];
    const next = messages[i + 1];
    
    if (current.role === "user" && next.role !== "assistant" && next.role !== "system") {
      messages.splice(i + 1, 1);
      modified = true;
      i--;
    } else if (current.role === "assistant" && next.role !== "user" && next.role !== "assistant" && next.role !== "system") {
      messages.splice(i + 1, 1);
      modified = true;
      i--;
    }
  }

  return { messages, modified };
}

export default function (pi: ExtensionAPI) {
  let sessionId = "";
  let needsReinject = true;
  let lastErrorWas400 = false;

  // ── Session start: get session ID ──
  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionId = await getOrCreateSessionId();
    ctx.ui.setStatus("session-id", sessionId.slice(0, 16));
    needsReinject = true;
    lastErrorWas400 = false;
  });

  // ── After compact: re-inject session ID on next turn ──
  pi.on("session_compact", async () => {
    needsReinject = true;
  });

  // ── Track 400 errors ──
  pi.on("model_error", async (event: any) => {
    if (event.error && event.error.statusCode === 400) {
      lastErrorWas400 = true;
      const errorMsg = event.error.message || String(event.error);
      const messages = event.messages || [];
      const roles = messages.map((m: any) => m.role).join(" → ");
      console.log(`[session-id] 400 ERROR: ${errorMsg}`);
      console.log(`[session-id] Roles: ${roles}`);
      console.log(`[session-id] Will apply fixes on next attempt`);
    } else {
      lastErrorWas400 = false;
    }
  });

  // ── Context: clean messages for Mistral + inject session ID ──
  pi.on("context", async (event: any, ctx: any) => {
    // Only apply fixes if last response was 400 OR if we need to inject session ID
    const shouldFix = lastErrorWas400 || needsReinject;
    
    const msgs = event.messages || [];
    const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
    
    let result = { messages: msgs, modified: false };
    
    if (shouldFix) {
      result = cleanForMistral(msgs, sessionId, needsReinject);
      lastErrorWas400 = false; // Reset after applying fix
    }
    
    const rolesAfter = result.messages.map((m: any) => m.role).join(" → ");
    
    if (rolesBefore !== rolesAfter) {
      console.log(`[session-id] context fix (400 recovery):`);
      console.log(`[session-id]   BEFORE: ${rolesBefore}`);
      console.log(`[session-id]   AFTER:  ${rolesAfter}`);
    }

    if (needsReinject) {
      needsReinject = false;
    }

    return result.modified ? { messages: result.messages } : undefined;
  });

  // ── Model request: also clean messages at the API level if needed ──
  pi.on("model_request", async (event: any) => {
    if (!lastErrorWas400) return undefined;
    
    const msgs = event.messages || [];
    const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
    
    const { messages, modified } = cleanForMistral(msgs, sessionId, false);
    
    const rolesAfter = messages.map((m: any) => m.role).join(" → ");
    
    if (rolesBefore !== rolesAfter) {
      console.log(`[session-id] model_request fix (400 recovery):`);
      console.log(`[session-id]   BEFORE: ${rolesBefore}`);
      console.log(`[session-id]   AFTER:  ${rolesAfter}`);
    }
    
    if (modified) {
      lastErrorWas400 = false; // Reset after applying fix
    }
    
    return modified ? { messages } : undefined;
  });

  // ── Before model call: final cleanup if needed ──
  pi.on("before_model_call", async (event: any) => {
    if (!lastErrorWas400) return undefined;
    
    if (event.messages) {
      const msgs = event.messages;
      const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
      
      const { messages, modified } = cleanForMistral(msgs, sessionId, false);
      
      const rolesAfter = messages.map((m: any) => m.role).join(" → ");
      
      if (rolesBefore !== rolesAfter) {
        console.log(`[session-id] before_model_call fix (400 recovery):`);
        console.log(`[session-id]   BEFORE: ${rolesBefore}`);
        console.log(`[session-id]   AFTER:  ${rolesAfter}`);
      }
      
      if (modified) {
        lastErrorWas400 = false; // Reset after applying fix
      }
      
      return modified ? { messages } : undefined;
    }
  });
}
