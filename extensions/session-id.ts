/**
 * pi Session ID — Mistral compatibility layer.
 * Debug version with extensive logging.
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

  // 3) Remove ALL tool-related messages
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

  // 5) Validate role sequence and remove invalid
  for (let i = 0; i < messages.length - 1; i++) {
    const current = messages[i];
    const next = messages[i + 1];
    
    const validTransitions: Record<string, Set<string>> = {
      system: new Set(["system", "user", "assistant"]),
      user: new Set(["assistant", "system"]),
      assistant: new Set(["user", "assistant", "system"]),
    };
    
    const allowedNext = validTransitions[current.role];
    if (allowedNext && !allowedNext.has(next.role)) {
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

  // ── Session start: get session ID ──
  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionId = await getOrCreateSessionId();
    ctx.ui.setStatus("session-id", sessionId.slice(0, 16));
    needsReinject = true;
    console.log(`[session-id] === SESSION START ===`);
    console.log(`[session-id] Session ID: ${sessionId}`);
  });

  // ── After compact: re-inject session ID on next turn ──
  pi.on("session_compact", async () => {
    needsReinject = true;
    console.log(`[session-id] === COMPACT ===`);
    console.log(`[session-id] Will re-inject session ID on next context`);
  });

  // ── Context: ALWAYS clean messages for Mistral ──
  pi.on("context", async (event: any, ctx: any) => {
    const msgs = event.messages || [];
    const roles = msgs.map((m: any) => m.role).join(" → ");
    const hasProblems = hasProblematicRoles(msgs);
    
    console.log(`[session-id] context event - msg count: ${msgs.length}, has problems: ${hasProblems}`);
    console.log(`[session-id] roles: ${roles}`);
    console.log(`[session-id] needsReinject: ${needsReinject}`);
    
    const { messages, modified } = cleanForMistral(msgs, sessionId, needsReinject);
    
    const rolesAfter = messages.map((m: any) => m.role).join(" → ");
    
    if (modified) {
      console.log(`[session-id] CLEANED:`);
      console.log(`[session-id]   BEFORE: ${roles}`);
      console.log(`[session-id]   AFTER:  ${rolesAfter}`);
      console.log(`[session-id]   Removed: ${msgs.length - messages.length} messages`);
    } else {
      console.log(`[session-id] No changes needed`);
    }

    if (needsReinject) {
      needsReinject = false;
    }

    return modified ? { messages } : undefined;
  });

  // ── Model request: ALWAYS clean at API level ──
  pi.on("model_request", async (event: any) => {
    const msgs = event.messages || [];
    const roles = msgs.map((m: any) => m.role).join(" → ");
    const hasProblems = hasProblematicRoles(msgs);
    
    console.log(`[session-id] model_request event - msg count: ${msgs.length}, has problems: ${hasProblems}`);
    console.log(`[session-id] roles: ${roles}`);
    
    const { messages, modified } = cleanForMistral(msgs, sessionId, false);
    
    const rolesAfter = messages.map((m: any) => m.role).join(" → ");
    
    if (modified) {
      console.log(`[session-id] API CLEANED:`);
      console.log(`[session-id]   BEFORE: ${roles}`);
      console.log(`[session-id]   AFTER:  ${rolesAfter}`);
    } else {
      console.log(`[session-id] API: No changes needed`);
    }
    
    return modified ? { messages } : undefined;
  });

  // ── Error handling: log 400 errors ──
  pi.on("model_error", async (event: any) => {
    if (event.error && event.error.statusCode === 400) {
      const errorMsg = event.error.message || String(event.error);
      const messages = event.messages || [];
      const roles = messages.map((m: any) => m.role).join(" → ");
      
      console.log(`[session-id] === 400 ERROR ===`);
      console.log(`[session-id] Error: ${errorMsg}`);
      console.log(`[session-id] Roles: ${roles}`);
      console.log(`[session-id] Message count: ${messages.length}`);
    }
  });
}
