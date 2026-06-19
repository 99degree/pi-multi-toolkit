/**
 * pi Session ID — Deep debugging for Mistral HTTP requests
 * Dumps full HTTP request content to trace the issue
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

function dumpMessage(msg: any, index: number, prefix: string = "") {
  const role = msg.role || "unknown";
  let content: string;
  
  if (typeof msg.content === 'string') {
    content = msg.content.slice(0, 200);
  } else if (Array.isArray(msg.content)) {
    content = msg.content.map((c: any) => 
      c.text ? c.text.slice(0, 100) : JSON.stringify(c).slice(0, 100)
    ).join(" | ").slice(0, 200);
  } else {
    content = JSON.stringify(msg.content).slice(0, 200);
  }
  
  const extra = [];
  if (msg.toolCallId) extra.push(`toolCallId: ${msg.toolCallId}`);
  if (msg.toolName) extra.push(`toolName: ${msg.toolName}`);
  if (msg.summary) extra.push(`summary: ${msg.summary.slice(0, 50)}`);
  if (msg.output) extra.push(`output: ${msg.output.slice(0, 50)}`);
  if (msg.excludeFromContext) extra.push(`excludeFromContext: true`);
  
  const extraStr = extra.length > 0 ? ` [${extra.join(", ")}]` : "";
  console.log(`${prefix}[${index}] ${role}: ${content}${extraStr}`);
}

function dumpAllMessages(msgs: any[], label: string) {
  console.log(`[session-id] === ${label} ===`);
  console.log(`[session-id] Total messages: ${msgs.length}`);
  const roles = msgs.map((m: any) => m.role).join(" → ");
  console.log(`[session-id] Roles: ${roles}`);
  console.log(`[session-id] Message details:`);
  msgs.forEach((msg: any, idx: number) => dumpMessage(msg, idx, "[session-id]   "));
  console.log(`[session-id] === END ${label} ===`);
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
    
    // Convert to system
    if (m.role === "compactionSummary" || m.role === "developer") {
      messages[i] = { 
        ...m, 
        role: "system",
        content: typeof m.content === 'string' ? m.content : 
                 Array.isArray(m.content) ? m.content : 
                 (m.summary || JSON.stringify(m.content))
      };
      modified = true;
    }
    // Convert to assistant
    else if (m.role === "tool" || m.role === "toolResult" || m.role === "bashExecution") {
      messages[i] = { 
        ...m, 
        role: "assistant",
        content: typeof m.content === 'string' ? m.content : 
                 Array.isArray(m.content) ? m.content : 
                 (m.output || m.summary || m.text || JSON.stringify(m.content))
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

  // ── Context: clean and dump ──
  pi.on("context", async (event: any, ctx: any) => {
    const msgs = event.messages || [];
    
    // Dump BEFORE cleaning
    if (msgs.length > 0 && msgs.some((m: any) => 
      m.role === "tool" || m.role === "toolResult" || m.role === "bashExecution" || 
      m.role === "compactionSummary" || m.role === "developer"
    )) {
      dumpAllMessages(msgs, "CONTEXT BEFORE CLEAN");
    }
    
    const { messages, modified } = cleanForMistral(msgs, sessionId, needsReinject);
    
    // Dump AFTER cleaning if modified
    if (modified) {
      dumpAllMessages(messages, "CONTEXT AFTER CLEAN");
    }

    if (needsReinject) {
      needsReinject = false;
    }

    return modified ? { messages } : undefined;
  });

  // ── before_provider_request: clean and dump (CRITICAL) ──
  pi.on("before_provider_request", async (event: any) => {
    const msgs = event.messages || [];
    
    // Dump BEFORE cleaning
    if (msgs.length > 0 && msgs.some((m: any) => 
      m.role === "tool" || m.role === "toolResult" || m.role === "bashExecution" || 
      m.role === "compactionSummary" || m.role === "developer"
    )) {
      dumpAllMessages(msgs, "BEFORE_PROVIDER_REQUEST BEFORE CLEAN");
    }
    
    const { messages, modified } = cleanForMistral(msgs, sessionId, false);
    
    // Dump AFTER cleaning if modified
    if (modified) {
      dumpAllMessages(messages, "BEFORE_PROVIDER_REQUEST AFTER CLEAN");
    }
    
    return modified ? { messages } : undefined;
  });

  // ── model_request: clean and dump ──
  pi.on("model_request", async (event: any) => {
    const msgs = event.messages || [];
    
    // Dump BEFORE cleaning
    if (msgs.length > 0 && msgs.some((m: any) => 
      m.role === "tool" || m.role === "toolResult" || m.role === "bashExecution" || 
      m.role === "compactionSummary" || m.role === "developer"
    )) {
      dumpAllMessages(msgs, "MODEL_REQUEST BEFORE CLEAN");
    }
    
    const { messages, modified } = cleanForMistral(msgs, sessionId, false);
    
    // Dump AFTER cleaning if modified
    if (modified) {
      dumpAllMessages(messages, "MODEL_REQUEST AFTER CLEAN");
    }
    
    return modified ? { messages } : undefined;
  });

  // ── Dump ALL events to see what's happening ──
  const allEvents = [
    "session_start",
    "session_compact", 
    "context",
    "before_provider_request",
    "model_request",
    "model_error",
    "turn_start",
    "turn_end",
    "tool_call",
    "tool_result",
  ];

  for (const eventName of allEvents) {
    pi.on(eventName, async (event: any) => {
      // Only log events with messages
      if (event && event.messages && Array.isArray(event.messages)) {
        const hasProblems = event.messages.some((m: any) => 
          m.role === "tool" || m.role === "toolResult" || m.role === "bashExecution" || 
          m.role === "compactionSummary" || m.role === "developer"
        );
        
        if (hasProblems) {
          console.log(`[session-id] EVENT: ${eventName} - has problematic roles`);
          dumpAllMessages(event.messages, `${eventName} RAW`);
        }
      }
    });
  }

  // ── Error handling: dump everything ──
  pi.on("model_error", async (event: any) => {
    if (event.error && event.error.statusCode === 400) {
      console.log(`[session-id] === 400 ERROR ===`);
      console.log(`[session-id] Error: ${event.error.message || String(event.error)}`);
      console.log(`[session-id] Status: ${event.error.statusCode}`);
      
      if (event.messages) {
        dumpAllMessages(event.messages, "MESSAGES AT ERROR");
      }
      
      if (event.request) {
        console.log(`[session-id] Request URL: ${event.request.url}`);
        console.log(`[session-id] Request method: ${event.request.method}`);
        if (event.request.body) {
          console.log(`[session-id] Request body: ${JSON.stringify(event.request.body).slice(0, 1000)}`);
        }
      }
      
      if (event.response) {
        console.log(`[session-id] Response status: ${event.response.status}`);
        if (event.response.body) {
          console.log(`[session-id] Response body: ${JSON.stringify(event.response.body).slice(0, 500)}`);
        }
      }
    }
  });
}
