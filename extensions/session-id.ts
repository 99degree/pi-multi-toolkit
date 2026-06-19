/**
 * pi Session ID — Mistral compatibility layer.
 * 
 * The issue: pi's convertToLlm() converts internal messages to LLM format:
 * - bashExecution -> user (unless excludeFromContext=true)
 * - compactionSummary -> user
 * - toolResult -> toolResult (kept as-is)
 * 
 * Mistral rejects: tool -> user sequence
 * 
 * Solution: 
 * 1. Mark bashExecution as excludeFromContext=true
 * 2. Convert compactionSummary to system role BEFORE convertToLlm
 * 3. Remove toolResult messages BEFORE convertToLlm
 * 4. Add session ID as system message
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

  // 2) Mark bashExecution messages as excludeFromContext
  // This prevents convertToLlm from converting them to user messages
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "bashExecution") {
      messages[i] = { ...messages[i], excludeFromContext: true };
      modified = true;
    }
  }

  // 3) Convert compactionSummary to system role
  // convertToLlm converts compactionSummary -> user, so we convert it first
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "compactionSummary") {
      messages[i] = { 
        ...messages[i], 
        role: "system",
        content: `Compaction Summary: ${messages[i].summary || ''}`
      };
      modified = true;
    }
  }

  // 4) Convert developer to system
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "developer") {
      messages[i] = { ...messages[i], role: "system" };
      modified = true;
    }
  }

  // 5) Remove toolResult messages entirely
  // convertToLlm keeps toolResult as-is, which Mistral rejects
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "toolResult") {
      messages.splice(i, 1);
      modified = true;
    }
  }

  // 6) Clean up consecutive system messages
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

function hasProblematicRoles(msgs: any[]): boolean {
  const problematic = new Set(["tool", "toolResult", "bashExecution", "compactionSummary", "developer"]);
  return msgs.some((m: any) => problematic.has(m.role));
}

function tryFix(event: any, sessionId: string, needsReinject: boolean, eventName: string): any {
  if (!event || !event.messages) return undefined;
  
  const msgs = event.messages;
  if (!Array.isArray(msgs)) return undefined;
  
  const hasProblems = hasProblematicRoles(msgs);
  if (!hasProblems && !needsReinject) return undefined;
  
  const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
  const { messages, modified } = cleanForMistral(msgs, sessionId, needsReinject && eventName === "context");
  const rolesAfter = messages.map((m: any) => m.role).join(" → ");
  
  if (modified || needsReinject) {
    console.log(`[session-id] ${eventName} FIX (hasProblems=${hasProblems}, needsReinject=${needsReinject}):`);
    console.log(`[session-id]   BEFORE: ${rolesBefore}`);
    console.log(`[session-id]   AFTER:  ${rolesAfter}`);
  }
  
  if (needsReinject && eventName === "context") {
    return { messages, needsReinject: false };
  }
  
  return modified ? { messages } : undefined;
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

  // ── Hook into ALL message events ──
  const messageEvents = [
    "context",
    "model_request", 
    "before_provider_request",
    "before_model_call",
    "session_before_compact",
    "turn_start",
    "turn_end",
  ];

  for (const eventName of messageEvents) {
    pi.on(eventName, async (event: any) => {
      const isContext = eventName === "context";
      const result = tryFix(event, sessionId, needsReinject && isContext, eventName);
      
      if (result && isContext) {
        needsReinject = false;
      }
      
      return result;
    });
  }

  // ── Error handling ──
  pi.on("model_error", async (event: any) => {
    if (event.error && event.error.statusCode === 400) {
      console.log(`[session-id] 400 ERROR: ${event.error.message || String(event.error)}`);
      if (event.messages) {
        const roles = event.messages.map((m: any) => m.role).join(" → ");
        console.log(`[session-id] Roles at error: ${roles}`);
        console.log(`[session-id] Message count: ${event.messages.length}`);
        
        // Check if messages have been converted
        const hasTool = event.messages.some((m: any) => m.role === "tool");
        const hasToolResult = event.messages.some((m: any) => m.role === "toolResult");
        console.log(`[session-id] Has tool: ${hasTool}, Has toolResult: ${hasToolResult}`);
      }
    }
  });
}
