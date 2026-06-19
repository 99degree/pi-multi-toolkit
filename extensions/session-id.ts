/**
 * pi Session ID — Mistral compatibility with proper content format
 * Ensures all message content is in the correct array format
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

function safeString(value: any, maxLength: number = 200): string {
  if (value === null || value === undefined) return "";
  if (typeof value === 'string') return value.slice(0, maxLength);
  if (Array.isArray(value)) {
    return value.map(v => safeString(v, maxLength / 2)).join(", ").slice(0, maxLength);
  }
  try {
    const str = JSON.stringify(value);
    return str.slice(0, maxLength);
  } catch {
    return "";
  }
}

function dumpMessage(msg: any, index: number, prefix: string = "") {
  if (!msg) {
    console.log(`${prefix}[${index}] null/undefined`);
    return;
  }
  
  const role = msg.role || "unknown";
  let content: string = "";
  
  try {
    if (typeof msg.content === 'string') {
      content = msg.content.slice(0, 200);
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map((c: any) => 
        safeString(c.text || c, 100)
      ).join(" | ").slice(0, 200);
    } else {
      content = safeString(msg.content, 200);
    }
  } catch (e) {
    content = `[error: ${e}]`;
  }
  
  const extra = [];
  try {
    if (msg.toolCallId) extra.push(`toolCallId: ${safeString(msg.toolCallId, 30)}`);
    if (msg.toolName) extra.push(`toolName: ${safeString(msg.toolName, 30)}`);
    if (msg.summary) extra.push(`summary: ${safeString(msg.summary, 50)}`);
    if (msg.output) extra.push(`output: ${safeString(msg.output, 50)}`);
    if (msg.excludeFromContext) extra.push(`excludeFromContext: true`);
    if (msg.command) extra.push(`command: ${safeString(msg.command, 30)}`);
    if (msg.exitCode !== undefined) extra.push(`exitCode: ${msg.exitCode}`);
  } catch (e) {
    extra.push(`[error: ${e}]`);
  }
  
  const extraStr = extra.length > 0 ? ` [${extra.join(", ")}]` : "";
  console.log(`${prefix}[${index}] ${role}: ${content}${extraStr}`);
}

function dumpAllMessages(msgs: any[], label: string) {
  if (!msgs || !Array.isArray(msgs)) {
    console.log(`[session-id] ${label}: not an array`);
    return;
  }
  
  console.log(`[session-id] === ${label} (${msgs.length} msgs) ===`);
  const roles = msgs.map((m: any) => m?.role || "null").join(" → ");
  console.log(`[session-id] Roles: ${roles}`);
  msgs.forEach((msg: any, idx: number) => dumpMessage(msg, idx, "[session-id]   "));
  console.log(`[session-id] === END ${label} ===`);
}

// Ensure content is always in the correct format for pi
function ensureContentFormat(content: any): any {
  if (content === undefined || content === null) {
    return [];
  }
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    // Ensure each item has type and text
    return content.map(item => {
      if (typeof item === 'string') {
        return { type: 'text', text: item };
      }
      if (item && item.text !== undefined) {
        return { type: 'text', text: String(item.text) };
      }
      return { type: 'text', text: JSON.stringify(item) };
    });
  }
  // For objects, try to extract text
  if (typeof content === 'object') {
    if (content.text !== undefined) {
      return [{ type: 'text', text: String(content.text) }];
    }
    if (content.summary !== undefined) {
      return [{ type: 'text', text: String(content.summary) }];
    }
    if (content.output !== undefined) {
      return [{ type: 'text', text: String(content.output) }];
    }
  }
  return [{ type: 'text', text: JSON.stringify(content) }];
}

function cleanForMistral(msgs: any[], sessionId: string, needsReinject: boolean): { messages: any[]; modified: boolean } {
  if (!msgs || !Array.isArray(msgs)) return { messages: msgs || [], modified: false };
  
  let modified = false;
  let messages = [...msgs];

  // 1) Add session ID as FIRST system message if needed
  if (needsReinject) {
    const hasSessionIdMsg = messages.some((m: any) => 
      m?.role === "system" && 
      Array.isArray(m.content) && 
      m.content.some((c: any) => c.text && c.text.includes(`[Session-ID: ${sessionId}]`))
    );
    
    if (!hasSessionIdMsg) {
      messages.unshift({
        role: "system",
        content: [{ type: 'text', text: `[Session-ID: ${sessionId}]` }],
      });
      modified = true;
    }
  }

  // 2) Convert ALL problematic roles to Mistral-compatible roles
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    
    // Convert to system
    if (m.role === "compactionSummary" || m.role === "developer") {
      messages[i] = { 
        ...m, 
        role: "system",
        content: ensureContentFormat(m.content || m.summary || ""),
      };
      modified = true;
    }
    // Convert to assistant
    else if (m.role === "tool" || m.role === "toolResult" || m.role === "bashExecution") {
      messages[i] = { 
        ...m, 
        role: "assistant",
        content: ensureContentFormat(m.content || m.output || m.summary || m.text || ""),
      };
      modified = true;
    }
  }

  // 3) Clean up consecutive system messages (keep first)
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]?.role === "system" && messages[i-1]?.role === "system") {
      const prevHasSessionId = Array.isArray(messages[i-1].content) && 
        messages[i-1].content.some((c: any) => c.text && c.text.includes("[Session-ID:"));
      const currHasSessionId = Array.isArray(messages[i].content) && 
        messages[i].content.some((c: any) => c.text && c.text.includes("[Session-ID:"));
      
      if (prevHasSessionId) {
        messages.splice(i, 1);
        modified = true;
        i--;
      } else if (currHasSessionId) {
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
    console.log(`[session-id] COMPACT`);
  });

  // ── Context: clean and dump ──
  pi.on("context", async (event: any, ctx: any) => {
    const msgs = event?.messages;
    if (!msgs || !Array.isArray(msgs)) return;
    
    const hasProblems = msgs.some((m: any) => 
      m?.role === "tool" || m?.role === "toolResult" || m?.role === "bashExecution" || 
      m?.role === "compactionSummary" || m?.role === "developer"
    );
    
    if (hasProblems) {
      dumpAllMessages(msgs, "CONTEXT BEFORE CLEAN");
    }
    
    const { messages, modified } = cleanForMistral(msgs, sessionId, needsReinject);
    
    if (modified) {
      dumpAllMessages(messages, "CONTEXT AFTER CLEAN");
    }

    if (needsReinject) {
      needsReinject = false;
    }

    return modified ? { messages } : undefined;
  });

  // ── before_provider_request: clean and dump ──
  pi.on("before_provider_request", async (event: any) => {
    const msgs = event?.messages;
    if (!msgs || !Array.isArray(msgs)) return;
    
    const hasProblems = msgs.some((m: any) => 
      m?.role === "tool" || m?.role === "toolResult" || m?.role === "bashExecution" || 
      m?.role === "compactionSummary" || m?.role === "developer"
    );
    
    if (hasProblems) {
      dumpAllMessages(msgs, "BEFORE_PROVIDER_REQUEST BEFORE CLEAN");
    }
    
    const { messages, modified } = cleanForMistral(msgs, sessionId, false);
    
    if (modified) {
      dumpAllMessages(messages, "BEFORE_PROVIDER_REQUEST AFTER CLEAN");
    }
    
    return modified ? { messages } : undefined;
  });

  // ── model_request: clean and dump ──
  pi.on("model_request", async (event: any) => {
    const msgs = event?.messages;
    if (!msgs || !Array.isArray(msgs)) return;
    
    const hasProblems = msgs.some((m: any) => 
      m?.role === "tool" || m?.role === "toolResult" || m?.role === "bashExecution" || 
      m?.role === "compactionSummary" || m?.role === "developer"
    );
    
    if (hasProblems) {
      dumpAllMessages(msgs, "MODEL_REQUEST BEFORE CLEAN");
    }
    
    const { messages, modified } = cleanForMistral(msgs, sessionId, false);
    
    if (modified) {
      dumpAllMessages(messages, "MODEL_REQUEST AFTER CLEAN");
    }
    
    return modified ? { messages } : undefined;
  });

  // ── Error handling: dump everything ──
  pi.on("model_error", async (event: any) => {
    if (event?.error?.statusCode === 400) {
      console.log(`[session-id] === 400 ERROR ===`);
      console.log(`[session-id] Error: ${event.error.message || String(event.error)}`);
      
      if (event.messages) {
        dumpAllMessages(event.messages, "MESSAGES AT ERROR");
      }
      
      if (event.request) {
        console.log(`[session-id] Request URL: ${event.request.url || 'N/A'}`);
        console.log(`[session-id] Request method: ${event.request.method || 'N/A'}`);
        if (event.request.body) {
          console.log(`[session-id] Request body: ${safeString(event.request.body, 2000)}`);
        }
      }
    }
  });
}
