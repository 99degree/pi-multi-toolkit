/**
 * pi Session ID — session tracking with error recovery for Mistral.
 *
 * Responsibilities:
 * 1. Send session ID as SYSTEM message as first message to model
 * 2. Convert developer, compactionSummary → system
 * 3. Convert tool/toolResult/bashExecution → assistant (Mistral template supports tool role but pi's format differs)
 * 4. Ensure proper role alternation for Mistral
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
  // developer, compactionSummary → system
  const rolesToSystem = new Set(["developer", "compactionSummary"]);
  for (let i = 0; i < messages.length; i++) {
    if (rolesToSystem.has(messages[i].role)) {
      messages[i] = { ...messages[i], role: "system" };
      modified = true;
    }
  }

  // 3) Convert tool-related messages to assistant role
  // Mistral template supports 'tool' role but pi sends standalone toolResult messages
  // which don't match Mistral's expected format (tool_calls in assistant message)
  // So convert them to assistant for compatibility
  const toolRoles = new Set(["tool", "toolResult", "bashExecution"]);
  for (let i = 0; i < messages.length; i++) {
    if (toolRoles.has(messages[i].role)) {
      messages[i] = { ...messages[i], role: "assistant" };
      modified = true;
    }
  }

  // 4) Ensure proper alternation: user → assistant → user → assistant...
  // Remove any message that breaks this basic pattern
  for (let i = 0; i < messages.length - 1; i++) {
    const current = messages[i];
    const next = messages[i + 1];
    
    // user must be followed by assistant or system
    if (current.role === "user" && next.role !== "assistant" && next.role !== "system") {
      messages.splice(i + 1, 1);
      modified = true;
      i--; // Re-check this position
    }
    // assistant can be followed by user, assistant, or system
    else if (current.role === "assistant" && next.role !== "user" && next.role !== "assistant" && next.role !== "system") {
      messages.splice(i + 1, 1);
      modified = true;
      i--; // Re-check this position
    }
    // system can be followed by user, assistant, or system
    else if (current.role === "system" && next.role !== "user" && next.role !== "assistant" && next.role !== "system") {
      messages.splice(i + 1, 1);
      modified = true;
      i--; // Re-check this position
    }
  }

  return { messages, modified };
}

export default function (pi: ExtensionAPI) {
  let sessionId = "";
  let needsReinject = true;

  // ── Session start: get session ID ──
  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionId = await getOrCreateSessionId();
    ctx.ui.setStatus("session-id", sessionId.slice(0, 16));
    needsReinject = true;
    console.log(`[session-id] Session started: ${sessionId}`);
  });

  // ── After compact: re-inject session ID on next turn ──
  pi.on("session_compact", async () => {
    needsReinject = true;
    console.log(`[session-id] Compact detected, will re-inject session ID`);
  });

  // ── Context: fix messages + inject session ID ──
  pi.on("context", async (event: any, ctx: any) => {
    const msgs = event.messages || [];
    const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
    
    const { messages, modified } = fixMistralMessages(msgs, sessionId, needsReinject);
    
    const rolesAfter = messages.map((m: any) => m.role).join(" → ");
    
    if (rolesBefore !== rolesAfter) {
      console.log(`[session-id] context fix:`);
      console.log(`[session-id]   BEFORE: ${rolesBefore}`);
      console.log(`[session-id]   AFTER:  ${rolesAfter}`);
    }

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
      console.log(`[session-id] model_request fix:`);
      console.log(`[session-id]   BEFORE: ${rolesBefore}`);
      console.log(`[session-id]   AFTER:  ${rolesAfter}`);
    }
    
    return modified ? { messages } : undefined;
  });

  // ── Before model call: final check ──
  pi.on("before_model_call", async (event: any) => {
    if (event.messages) {
      const msgs = event.messages;
      const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
      
      const { messages, modified } = fixMistralMessages(msgs, sessionId, false);
      
      const rolesAfter = messages.map((m: any) => m.role).join(" → ");
      
      if (rolesBefore !== rolesAfter) {
        console.log(`[session-id] before_model_call fix:`);
        console.log(`[session-id]   BEFORE: ${rolesBefore}`);
        console.log(`[session-id]   AFTER:  ${rolesAfter}`);
      }
      
      return modified ? { messages } : undefined;
    }
  });

  // ── Error handling: log 400 errors ──
  pi.on("model_error", async (event: any) => {
    if (event.error && event.error.statusCode === 400) {
      const errorMsg = event.error.message || String(event.error);
      const messages = event.messages || [];
      const roles = messages.map((m: any) => m.role).join(" → ");
      
      console.log(`[session-id] 400 ERROR: ${errorMsg}`);
      console.log(`[session-id] Roles: ${roles}`);
    }
  });
}
