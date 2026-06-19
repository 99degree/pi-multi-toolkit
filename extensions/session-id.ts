/**
 * pi Session ID — Mistral compatibility layer
 * 
 * Always applied fixes:
 * 1. Inject session ID as first system message
 * 2. Normalize roles: toolResult→tool, bashExecution→tool, compactionSummary→system, developer→system
 * 3. Remove toolCall objects from content arrays
 * 4. Clean up empty/duplicate messages
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

function ensureContentFormat(content: any): any {
  if (content === undefined || content === null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) {
    return content.map(item => {
      if (typeof item === 'string') return { type: 'text', text: item };
      if (item?.text !== undefined) return { type: 'text', text: String(item.text) };
      return { type: 'text', text: JSON.stringify(item) };
    });
  }
  if (typeof content === 'object') {
    if (content.text !== undefined) return [{ type: 'text', text: String(content.text) }];
    if (content.summary !== undefined) return [{ type: 'text', text: String(content.summary) }];
    if (content.output !== undefined) return [{ type: 'text', text: String(content.output) }];
  }
  return [{ type: 'text', text: JSON.stringify(content) }];
}

function cleanForMistral(msgs: any[], sessionId: string, needsReinject: boolean): { messages: any[]; modified: boolean } {
  if (!msgs || !Array.isArray(msgs)) return { messages: msgs || [], modified: false };
  
  let modified = false;
  let messages = [...msgs];

  // 1. Add session ID as first system message if needed
  if (needsReinject) {
    const hasSessionId = messages.some((m: any) =>
      m?.role === "system" && 
      Array.isArray(m.content) && 
      m.content.some((c: any) => c.type === 'text' && c.text?.includes(`[Session-ID: ${sessionId}]`))
    );
    
    if (!hasSessionId) {
      messages.unshift({
        role: "system",
        content: [{ type: 'text', text: `[Session-ID: ${sessionId}]` }],
      });
      modified = true;
    }
  }

  // 2. Convert compactionSummary and developer to system
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    
    if (m.role === "compactionSummary" || m.role === "developer") {
      messages[i] = { 
        ...m, 
        role: "system",
        content: ensureContentFormat(m.content || m.summary || ""),
      };
      modified = true;
    }
  }

  // 3. Convert toolResult and bashExecution to tool (Mistral supports 'tool', not 'toolResult')
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    
    if (m.role === "toolResult" || m.role === "bashExecution") {
      messages[i] = { 
        ...m, 
        role: "tool",
        content: ensureContentFormat(m.content || m.output || m.summary || ""),
      };
      modified = true;
    }
  }

  // 4. Remove toolCall objects from content arrays
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || !Array.isArray(m.content)) continue;
    
    const hasToolCall = m.content.some((c: any) => c.type === 'toolCall');
    if (hasToolCall) {
      messages[i] = { 
        ...m, 
        content: m.content.filter((c: any) => c.type !== 'toolCall'),
      };
      modified = true;
    }
  }

  // 5. Clean up consecutive system messages
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]?.role === "system" && messages[i-1]?.role === "system") {
      const prevHasSessionId = Array.isArray(messages[i-1].content) && 
        messages[i-1].content.some((c: any) => c.type === 'text' && c.text?.includes('[Session-ID:'));
      if (prevHasSessionId) {
        messages.splice(i, 1);
        modified = true;
        i--;
      }
    }
  }

  // 6. Remove empty assistant messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") {
      const content = m.content;
      if (!content || (Array.isArray(content) && content.length === 0)) {
        messages.splice(i, 1);
        modified = true;
      } else if (Array.isArray(content) && content.every((c: any) => 
        !c.text || c.text.trim() === ""
      )) {
        messages.splice(i, 1);
        modified = true;
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
  });

  // ── Session compact ──
  pi.on("session_compact", async () => {
    needsReinject = true;
  });

  // ── Apply fixes at all relevant events ──
  const messageEvents = ["context", "before_provider_request", "model_request"];

  for (const eventName of messageEvents) {
    pi.on(eventName, async (event: any) => {
      const msgs = event?.messages;
      if (!msgs || !Array.isArray(msgs)) return;
      
      const isContext = eventName === "context";
      const { messages, modified } = cleanForMistral(msgs, sessionId, needsReinject && isContext);
      
      if (isContext && needsReinject) {
        needsReinject = false;
      }
      
      return modified ? { messages } : undefined;
    });
  }

  // ── Error logging ──
  pi.on("model_error", async (event: any) => {
    if (event?.error?.statusCode === 400) {
      console.log(`[session-id] 400 ERROR: ${event.error.message || String(event.error)}`);
    }
  });
}
