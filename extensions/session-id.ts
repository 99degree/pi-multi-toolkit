/**
 * pi Session ID — Mistral compatibility layer.
 * 
 * Strategy: Convert ALL non-standard roles to Mistral-compatible roles
 * Mistral only accepts: system, user, assistant, tool (in specific format)
 * 
 * We convert:
 * - tool, toolResult, bashExecution → assistant (safe, Mistral accepts this)
 * - compactionSummary, developer → system (safe, Mistral accepts this)
 * - Add session ID as first system message
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

  // 2) Convert ALL problematic roles to Mistral-compatible roles
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    
    // Convert to system: compactionSummary, developer
    if (m.role === "compactionSummary" || m.role === "developer") {
      messages[i] = { 
        ...m, 
        role: "system",
        content: typeof m.content === 'string' ? m.content : 
                 Array.isArray(m.content) ? m.content : 
                 JSON.stringify(m.content)
      };
      modified = true;
    }
    // Convert to assistant: tool, toolResult, bashExecution
    else if (m.role === "tool" || m.role === "toolResult" || m.role === "bashExecution") {
      messages[i] = { 
        ...m, 
        role: "assistant",
        content: typeof m.content === 'string' ? m.content : 
                 Array.isArray(m.content) ? m.content : 
                 (m.summary || m.output || m.text || JSON.stringify(m.content))
      };
      modified = true;
    }
  }

  // 3) Clean up consecutive system messages (keep first)
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

  // 4) Clean up consecutive assistant messages
  // Keep only the last one in a sequence (preserves tool output)
  for (let i = messages.length - 2; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i+1].role === "assistant") {
      // Check if either is a converted tool message
      const currentIsTool = messages[i].toolCallId || messages[i].toolName || messages[i].output;
      const nextIsTool = messages[i+1].toolCallId || messages[i+1].toolName || messages[i+1].output;
      
      // Keep tool-related assistant messages, remove others
      if (!currentIsTool && !nextIsTool) {
        messages.splice(i, 1);
        modified = true;
      } else if (!currentIsTool && nextIsTool) {
        messages.splice(i, 1);
        modified = true;
      } else if (currentIsTool && !nextIsTool) {
        messages.splice(i+1, 1);
        modified = true;
        i--; // Re-check this position
      }
      // If both are tool-related, keep both
    }
  }

  return { messages, modified };
}

export default function (pi: ExtensionAPI) {
  let sessionId = "";
  let needsReinject = true;

  // ── Session start ──
  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionId = await getOrCreateSessionId();
    ctx.ui.setStatus("session-id", sessionId.slice(0, 16));
    needsReinject = true;
    console.log(`[session-id] SESSION START - ID: ${sessionId}`);
  });

  // ── Session compact ──
  pi.on("session_compact", async () => {
    needsReinject = true;
    console.log(`[session-id] COMPACT - will re-inject session ID`);
  });

  // ── Context: clean for display ──
  pi.on("context", async (event: any, ctx: any) => {
    const msgs = event.messages || [];
    const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
    
    const { messages, modified } = cleanForMistral(msgs, sessionId, needsReinject);
    
    const rolesAfter = messages.map((m: any) => m.role).join(" → ");
    
    if (modified) {
      console.log(`[session-id] CONTEXT FIX:`);
      console.log(`[session-id]   BEFORE: ${rolesBefore}`);
      console.log(`[session-id]   AFTER:  ${rolesAfter}`);
    }

    if (needsReinject) {
      needsReinject = false;
    }

    return modified ? { messages } : undefined;
  });

  // ── before_provider_request: clean before sending to provider (CRITICAL) ──
  pi.on("before_provider_request", async (event: any) => {
    const msgs = event.messages || [];
    const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
    
    const { messages, modified } = cleanForMistral(msgs, sessionId, false);
    
    const rolesAfter = messages.map((m: any) => m.role).join(" → ");
    
    if (modified) {
      console.log(`[session-id] BEFORE_PROVIDER_REQUEST FIX:`);
      console.log(`[session-id]   BEFORE: ${rolesBefore}`);
      console.log(`[session-id]   AFTER:  ${rolesAfter}`);
    }
    
    return modified ? { messages } : undefined;
  });

  // ── model_request: also clean at API level ──
  pi.on("model_request", async (event: any) => {
    const msgs = event.messages || [];
    const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
    
    const { messages, modified } = cleanForMistral(msgs, sessionId, false);
    
    const rolesAfter = messages.map((m: any) => m.role).join(" → ");
    
    if (modified) {
      console.log(`[session-id] MODEL_REQUEST FIX:`);
      console.log(`[session-id]   BEFORE: ${rolesBefore}`);
      console.log(`[session-id]   AFTER:  ${rolesAfter}`);
    }
    
    return modified ? { messages } : undefined;
  });

  // ── Error handling ──
  pi.on("model_error", async (event: any) => {
    if (event.error && event.error.statusCode === 400) {
      const errorMsg = event.error.message || String(event.error);
      const messages = event.messages || [];
      const roles = messages.map((m: any) => m.role).join(" → ");
      
      console.log(`[session-id] === 400 ERROR ===`);
      console.log(`[session-id] Error: ${errorMsg}`);
      console.log(`[session-id] Roles: ${roles}`);
      
      // Check for any remaining problematic roles
      const hasTool = messages.some((m: any) => m.role === "tool");
      const hasToolResult = messages.some((m: any) => m.role === "toolResult");
      console.log(`[session-id] Has tool: ${hasTool}, Has toolResult: ${hasToolResult}`);
    }
  });
}
