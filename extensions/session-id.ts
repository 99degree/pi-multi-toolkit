/**
 * pi Session ID — Two-stage fix for Mistral compatibility
 * 
 * Stage 1: Always inject session ID as first system message
 *   - Trigger: session_start, session_compact
 *   - Purpose: Provide session context to Mistral
 * 
 * Stage 2: Role normalization (only after 400 error)
 *   - Trigger: model_error with statusCode 400
 *   - Purpose: Fix role issues that Mistral rejects
 *   - Actions: 
 *     - Remove tool, toolResult, bashExecution messages (don't convert to assistant)
 *     - Convert compactionSummary, developer to system
 *     - Remove toolCall objects from content arrays
 *     - Ensure conversation doesn't end with assistant message
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

// ============================================================================
// Stage 1: Session ID Injection (always applied)
// ============================================================================

function injectSessionId(msgs: any[], sessionId: string): { messages: any[]; modified: boolean } {
  if (!msgs || !Array.isArray(msgs)) return { messages: msgs || [], modified: false };
  
  // Check if session ID already exists
  const hasSessionId = msgs.some((m: any) => 
    m?.role === "system" && 
    Array.isArray(m.content) && 
    m.content.some((c: any) => c.type === 'text' && c.text?.includes(`[Session-ID: ${sessionId}]`))
  );
  
  if (!hasSessionId) {
    const messages = [
      {
        role: "system",
        content: [{ type: 'text', text: `[Session-ID: ${sessionId}]` }],
      },
      ...msgs,
    ];
    return { messages, modified: true };
  }
  
  return { messages: msgs, modified: false };
}

// ============================================================================
// Stage 2: Role Normalization (only after 400 error)
// ============================================================================

let applyRoleFix = false;

function normalizeRoles(msgs: any[]): { messages: any[]; modified: boolean } {
  if (!applyRoleFix || !msgs || !Array.isArray(msgs)) {
    return { messages: msgs || [], modified: false };
  }
  
  let modified = false;
  let messages = [...msgs];
  
  // 1. Convert compactionSummary and developer to system
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
  
  // 2. Remove tool, toolResult, bashExecution messages entirely
  // Don't convert to assistant - that can cause "last message is assistant" error
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    
    if (m.role === "tool" || m.role === "toolResult" || m.role === "bashExecution") {
      messages.splice(i, 1);
      modified = true;
    }
  }
  
  // 3. Remove toolCall objects from content arrays
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
  
  // 4. Clean up consecutive system messages
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
  
  // 5. Ensure conversation doesn't end with assistant message
  // Mistral error: "Cannot set add_generation_prompt to True when the last message is from the assistant"
  while (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
    messages.pop();
    modified = true;
  }
  
  if (modified) {
    console.log(`[session-id] Role normalization applied`);
    const roles = messages.map((m: any) => m.role).join(' → ');
    console.log(`[session-id] Roles: ${roles}`);
  }
  
  return { messages, modified };
}

// ============================================================================
// Helper functions
// ============================================================================

function ensureContentFormat(content: any): any {
  if (content === undefined || content === null) {
    return [];
  }
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
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

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  let sessionId = "";
  let needsSessionIdInjection = true;

  // ── Session start: get session ID and inject it ──
  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionId = await getOrCreateSessionId();
    ctx.ui.setStatus("session-id", sessionId.slice(0, 16));
    needsSessionIdInjection = true;
    applyRoleFix = false; // Reset role fix flag on new session
    console.log(`[session-id] SESSION START - ID: ${sessionId}`);
  });

  // ── Session compact: mark for session ID re-injection ──
  pi.on("session_compact", async () => {
    needsSessionIdInjection = true;
    console.log(`[session-id] COMPACT - will re-inject session ID`);
  });

  // ── Model error: enable role fix on next request ──
  pi.on("model_error", async (event: any) => {
    if (event?.error?.statusCode === 400) {
      applyRoleFix = true;
      console.log(`[session-id] 400 ERROR - will apply role fix`);
      console.log(`[session-id] Error: ${event.error.message || String(event.error)}`);
    }
  });

  // ── Context: apply both fixes ──
  pi.on("context", async (event: any, ctx: any) => {
    const msgs = event?.messages;
    if (!msgs || !Array.isArray(msgs)) return;
    
    let messages = [...msgs];
    let modified = false;
    
    // Stage 1: Always inject session ID if needed
    if (needsSessionIdInjection) {
      const { messages: newMessages, modified: sessionIdModified } = injectSessionId(messages, sessionId);
      messages = newMessages;
      modified = sessionIdModified;
      needsSessionIdInjection = false;
    }
    
    // Stage 2: Apply role normalization if triggered by 400
    if (applyRoleFix) {
      const { messages: newMessages, modified: roleModified } = normalizeRoles(messages);
      messages = newMessages;
      modified = modified || roleModified;
      applyRoleFix = false; // Reset after applying once
    }
    
    return modified ? { messages } : undefined;
  });

  // ── before_provider_request: apply both fixes ──
  pi.on("before_provider_request", async (event: any) => {
    const msgs = event?.messages;
    if (!msgs || !Array.isArray(msgs)) return;
    
    let messages = [...msgs];
    let modified = false;
    
    // Stage 1: Inject session ID
    if (needsSessionIdInjection) {
      const { messages: newMessages, modified: sessionIdModified } = injectSessionId(messages, sessionId);
      messages = newMessages;
      modified = sessionIdModified;
      needsSessionIdInjection = false;
    }
    
    // Stage 2: Apply role normalization if triggered by 400
    if (applyRoleFix) {
      const { messages: newMessages, modified: roleModified } = normalizeRoles(messages);
      messages = newMessages;
      modified = modified || roleModified;
      applyRoleFix = false; // Reset after applying once
    }
    
    return modified ? { messages } : undefined;
  });

  // ── model_request: apply both fixes ──
  pi.on("model_request", async (event: any) => {
    const msgs = event?.messages;
    if (!msgs || !Array.isArray(msgs)) return;
    
    let messages = [...msgs];
    let modified = false;
    
    if (applyRoleFix) {
      const { messages: newMessages, modified: roleModified } = normalizeRoles(messages);
      messages = newMessages;
      modified = roleModified;
      applyRoleFix = false;
    }
    
    return modified ? { messages } : undefined;
  });
}
