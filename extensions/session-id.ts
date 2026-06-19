/**
 * pi Session ID — Mistral compatibility layer.
 * Fixes messages at ALL possible levels to ensure Mistral compatibility.
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

function hasProblematicRoles(msgs: any[]): boolean {
  const problematic = new Set(["tool", "toolResult", "bashExecution", "compactionSummary", "developer"]);
  return msgs.some((m: any) => problematic.has(m.role));
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

  // 2) Convert non-standard roles to system
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "compactionSummary" || messages[i].role === "developer") {
      messages[i] = { ...messages[i], role: "system" };
      modified = true;
    }
  }

  // 3) Remove ALL tool-related messages (Mistral doesn't support pi's standalone tool messages)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool" || messages[i].role === "toolResult" || messages[i].role === "bashExecution") {
      messages.splice(i, 1);
      modified = true;
    }
  }

  // 4) Clean up consecutive system messages (keep first)
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === "system" && messages[i-1].role === "system") {
      if (messages[i-1].content && messages[i-1].content.includes("[Session-ID:")) {
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
    console.log(`[session-id] SESSION START - ID: ${sessionId}`);
  });

  // ── After compact: re-inject session ID on next turn ──
  pi.on("session_compact", async () => {
    needsReinject = true;
    console.log(`[session-id] COMPACT - will re-inject session ID`);
  });

  // ── Context: clean for display ──
  pi.on("context", async (event: any, ctx: any) => {
    const msgs = event.messages || [];
    const hasProblems = hasProblematicRoles(msgs);
    
    if (hasProblems) {
      const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
      const { messages, modified } = cleanForMistral(msgs, sessionId, needsReinject);
      const rolesAfter = messages.map((m: any) => m.role).join(" → ");
      
      if (modified) {
        console.log(`[session-id] CONTEXT FIX:`);
        console.log(`[session-id]   BEFORE: ${rolesBefore}`);
        console.log(`[session-id]   AFTER:  ${rolesAfter}`);
      }
      
      if (needsReinject) needsReinject = false;
      return modified ? { messages } : undefined;
    }
    
    if (needsReinject) needsReinject = false;
  });

  // ── before_provider_request: clean before sending to provider (THIS IS KEY) ──
  pi.on("before_provider_request", async (event: any) => {
    if (!event.messages) return;
    
    const msgs = event.messages;
    const hasProblems = hasProblematicRoles(msgs);
    
    if (hasProblems) {
      const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
      const { messages, modified } = cleanForMistral(msgs, sessionId, false);
      const rolesAfter = messages.map((m: any) => m.role).join(" → ");
      
      if (modified) {
        console.log(`[session-id] BEFORE_PROVIDER_REQUEST FIX:`);
        console.log(`[session-id]   BEFORE: ${rolesBefore}`);
        console.log(`[session-id]   AFTER:  ${rolesAfter}`);
      }
      
      return modified ? { messages } : undefined;
    }
  });

  // ── model_request: also clean at API level ──
  pi.on("model_request", async (event: any) => {
    if (!event.messages) return;
    
    const msgs = event.messages;
    const hasProblems = hasProblematicRoles(msgs);
    
    if (hasProblems) {
      const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
      const { messages, modified } = cleanForMistral(msgs, sessionId, false);
      const rolesAfter = messages.map((m: any) => m.role).join(" → ");
      
      if (modified) {
        console.log(`[session-id] MODEL_REQUEST FIX:`);
        console.log(`[session-id]   BEFORE: ${rolesBefore}`);
        console.log(`[session-id]   AFTER:  ${rolesAfter}`);
      }
      
      return modified ? { messages } : undefined;
    }
  });

  // ── tool_call: log tool calls ──
  pi.on("tool_call", async (event: any) => {
    console.log(`[session-id] TOOL_CALL: ${JSON.stringify(event).slice(0, 200)}`);
  });

  // ── tool_result: log tool results ──
  pi.on("tool_result", async (event: any) => {
    console.log(`[session-id] TOOL_RESULT: ${JSON.stringify(event).slice(0, 200)}`);
  });

  // ── turn_start: log turn start ──
  pi.on("turn_start", async (event: any) => {
    console.log(`[session-id] TURN_START`);
  });

  // ── turn_end: log turn end ──
  pi.on("turn_end", async (event: any) => {
    console.log(`[session-id] TURN_END`);
  });

  // ── Error handling ──
  pi.on("model_error", async (event: any) => {
    if (event.error && event.error.statusCode === 400) {
      const errorMsg = event.error.message || String(event.error);
      const messages = event.messages || [];
      const roles = messages.map((m: any) => m.role).join(" → ");
      const hasProblems = hasProblematicRoles(messages);
      
      console.log(`[session-id] === 400 ERROR ===`);
      console.log(`[session-id] Error: ${errorMsg}`);
      console.log(`[session-id] Roles: ${roles}`);
      console.log(`[session-id] Has problems: ${hasProblems}`);
      console.log(`[session-id] Message count: ${messages.length}`);
    }
  });
}
