/**
 * pi Session ID — Mistral compatibility layer.
 * hooks into EVERY event that might contain messages
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
  for (const m of msgs) {
    if (problematic.has(m.role)) return true;
    // Also check nested content for tool-related data
    if (m.tool_calls || m.toolCallId || m.toolName) return true;
  }
  return false;
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
    const m = messages[i];
    if (m.role === "tool" || m.role === "toolResult" || m.role === "bashExecution") {
      messages.splice(i, 1);
      modified = true;
    }
    // Also remove messages with tool-related fields
    else if (m.tool_calls || m.toolCallId || m.toolName) {
      messages.splice(i, 1);
      modified = true;
    }
  }

  // 4) Clean up consecutive system messages
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

function tryFix(event: any, sessionId: string, needsReinject: boolean, eventName: string): any {
  if (!event || !event.messages) return undefined;
  
  const msgs = event.messages;
  if (!Array.isArray(msgs)) return undefined;
  
  const hasProblems = hasProblematicRoles(msgs);
  if (!hasProblems) return undefined;
  
  const rolesBefore = msgs.map((m: any) => m.role).join(" → ");
  const { messages, modified } = cleanForMistral(msgs, sessionId, needsReinject);
  const rolesAfter = messages.map((m: any) => m.role).join(" → ");
  
  if (modified) {
    console.log(`[session-id] ${eventName} FIX:`);
    console.log(`[session-id]   BEFORE: ${rolesBefore}`);
    console.log(`[session-id]   AFTER:  ${rolesAfter}`);
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
    console.log(`[session-id] SESSION START]`);
  });

  // ── Session compact ──
  pi.on("session_compact", async () => {
    needsReinject = true;
    console.log(`[session-id] COMPACT]`);
  });

  // ── Hook into ALL possible events that might contain messages ──
  const messageEvents = [
    "context",
    "model_request", 
    "before_provider_request",
    "before_model_call",
    "after_provider_response",
    "turn_start",
    "turn_end",
    "tool_call",
    "tool_result",
  ];

  for (const eventName of messageEvents) {
    pi.on(eventName, async (event: any) => {
      const result = tryFix(event, sessionId, needsReinject && eventName === "context", eventName);
      if (result) {
        if (eventName === "context" && needsReinject) {
          needsReinject = false;
        }
        return result;
      }
    });
  }

  // ── Error handling ──
  pi.on("model_error", async (event: any) => {
    if (event.error && event.error.statusCode === 400) {
      console.log(`[session-id] 400 ERROR: ${event.error.message || String(event.error)}`);
      if (event.messages) {
        const roles = event.messages.map((m: any) => m.role).join(" → ");
        console.log(`[session-id] Roles at error: ${roles}`);
      }
    }
  });
}
