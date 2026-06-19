/**
 * pi Session ID — HTTP-level interception for Mistral
 * Monkey-patches fetch to intercept and fix HTTP requests to Mistral
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

// Store original fetch
let originalFetch: typeof fetch;

function sanitizeMistralMessages(body: any): any {
  if (!body || typeof body !== 'object') return body;
  
  // Clone to avoid modifying original
  const newBody = { ...body };
  
  // Check if body has messages array
  if (newBody.messages && Array.isArray(newBody.messages)) {
    const messages = newBody.messages;
    let modified = false;
    
    // 1. Add session ID as first system message if not present
    const sessionId = getOrCreateSessionId();
    const hasSessionId = messages.some((m: any) => 
      m.role === 'system' && 
      Array.isArray(m.content) && 
      m.content.some((c: any) => c.type === 'text' && c.text?.includes(`[Session-ID: ${sessionId}]`))
    );
    
    if (!hasSessionId) {
      messages.unshift({
        role: 'system',
        content: [{ type: 'text', text: `[Session-ID: ${sessionId}]` }],
      });
      modified = true;
    }
    
    // 2. Remove ALL tool-related messages and toolCall objects
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m) continue;
      
      // Remove messages with tool-related roles
      if (m.role === 'tool' || m.role === 'toolResult') {
        messages.splice(i, 1);
        modified = true;
        continue;
      }
      
      // Remove toolCall objects from content arrays
      if (Array.isArray(m.content)) {
        m.content = m.content.filter((c: any) => c.type !== 'toolCall');
        if (m.content.length === 0) {
          m.content = [{ type: 'text', text: '' }];
        }
        modified = true;
      }
      
      // Convert compactionSummary and developer to system
      if (m.role === 'compactionSummary' || m.role === 'developer') {
        m.role = 'system';
        modified = true;
      }
      
      // Convert bashExecution to assistant
      if (m.role === 'bashExecution') {
        m.role = 'assistant';
        modified = true;
      }
    }
    
    // 3. Clean up consecutive system messages
    for (let i = 1; i < messages.length; i++) {
      if (messages[i]?.role === 'system' && messages[i-1]?.role === 'system') {
        const prevHasSessionId = Array.isArray(messages[i-1].content) && 
          messages[i-1].content.some((c: any) => c.type === 'text' && c.text?.includes('[Session-ID:'));
        if (prevHasSessionId) {
          messages.splice(i, 1);
          modified = true;
          i--;
        }
      }
    }
    
    if (modified) {
      console.log(`[session-id] HTTP FIX APPLIED`);
      console.log(`[session-id] Messages: ${messages.length}`);
      const roles = messages.map((m: any) => m.role).join(' → ');
      console.log(`[session-id] Roles: ${roles}`);
    }
    
    newBody.messages = messages;
  }
  
  return newBody;
}

function createPatchedFetch(): typeof fetch {
  return async function(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const urlStr = typeof url === 'string' ? url : url.toString();
    
    // Only intercept Mistral API calls
    if (urlStr.includes('mistral') || urlStr.includes('nvidia')) {
      console.log(`[session-id] HTTP REQUEST to: ${urlStr}`);
      
      // Check if it's a POST request with JSON body
      if (init && init.method === 'POST' && init.body) {
        try {
          // Try to parse the body
          let body: any;
          if (typeof init.body === 'string') {
            body = JSON.parse(init.body);
          } else if (init.body instanceof ReadableStream) {
            // Can't easily read stream, skip
            console.log(`[session-id] Body is stream, cannot modify`);
            return originalFetch(url, init);
          } else {
            body = init.body;
          }
          
          // Check if body has messages
          if (body && body.messages && Array.isArray(body.messages)) {
            const rolesBefore = body.messages.map((m: any) => m.role).join(' → ');
            console.log(`[session-id] HTTP BEFORE FIX: ${rolesBefore}`);
            
            // Fix the body
            const fixedBody = sanitizeMistralMessages(body);
            
            const rolesAfter = fixedBody.messages?.map((m: any) => m.role).join(' → ');
            console.log(`[session-id] HTTP AFTER FIX: ${rolesAfter}`);
            
            // Create new request with fixed body
            const newInit: RequestInit = { ...init };
            if (typeof init.body === 'string') {
              newInit.body = JSON.stringify(fixedBody);
            } else {
              newInit.body = fixedBody;
            }
            
            console.log(`[session-id] Sending fixed request`);
            return originalFetch(url, newInit);
          }
        } catch (e) {
          console.log(`[session-id] Error parsing body: ${e}`);
        }
      }
    }
    
    // For non-Mistral requests or if we couldn't modify, use original fetch
    return originalFetch(url, init);
  };
}

export default function (pi: ExtensionAPI) {
  let sessionId: string;
  let needsReinject = true;

  // ── Session start ──
  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionId = await getOrCreateSessionId();
    ctx.ui.setStatus("session-id", sessionId.slice(0, 16));
    needsReinject = true;
    
    // Monkey-patch fetch for HTTP-level interception
    if (!originalFetch) {
      originalFetch = globalThis.fetch;
      globalThis.fetch = createPatchedFetch();
      console.log(`[session-id] Fetch patched for HTTP interception`);
    }
    
    console.log(`[session-id] SESSION START - ID: ${sessionId}`);
  });

  // ── Session compact ──
  pi.on("session_compact", async () => {
    needsReinject = true;
    console.log(`[session-id] COMPACT`);
  });

  // ── Clean at context level too (belt and suspenders) ──
  pi.on("context", async (event: any, ctx: any) => {
    const msgs = event?.messages;
    if (!msgs || !Array.isArray(msgs)) return;
    
    // Check for toolCall objects in content
    const hasToolCalls = msgs.some((m: any) => 
      Array.isArray(m.content) && m.content.some((c: any) => c.type === 'toolCall')
    );
    
    if (hasToolCalls) {
      console.log(`[session-id] CONTEXT has toolCall objects`);
    }
    
    // Clean toolCall objects from assistant messages
    let modified = false;
    const messages = msgs.map((m: any) => {
      if (m && Array.isArray(m.content)) {
        const hasToolCall = m.content.some((c: any) => c.type === 'toolCall');
        if (hasToolCall) {
          modified = true;
          return {
            ...m,
            content: m.content.filter((c: any) => c.type !== 'toolCall')
          };
        }
      }
      return m;
    }).filter(Boolean);
    
    if (modified) {
      console.log(`[session-id] CONTEXT cleaned toolCall objects`);
    }
    
    if (needsReinject) {
      needsReinject = false;
    }

    return modified ? { messages } : undefined;
  });

  // ── before_provider_request ──
  pi.on("before_provider_request", async (event: any) => {
    const msgs = event?.messages;
    if (!msgs || !Array.isArray(msgs)) return;
    
    // Clean toolCall objects
    let modified = false;
    const messages = msgs.map((m: any) => {
      if (m && Array.isArray(m.content)) {
        const hasToolCall = m.content.some((c: any) => c.type === 'toolCall');
        if (hasToolCall) {
          modified = true;
          return {
            ...m,
            content: m.content.filter((c: any) => c.type !== 'toolCall')
          };
        }
      }
      return m;
    }).filter(Boolean);
    
    if (modified) {
      console.log(`[session-id] BEFORE_PROVIDER_REQUEST cleaned toolCall objects`);
    }
    
    return modified ? { messages } : undefined;
  });

  // ── model_request ──
  pi.on("model_request", async (event: any) => {
    const msgs = event?.messages;
    if (!msgs || !Array.isArray(msgs)) return;
    
    // Clean toolCall objects
    let modified = false;
    const messages = msgs.map((m: any) => {
      if (m && Array.isArray(m.content)) {
        const hasToolCall = m.content.some((c: any) => c.type === 'toolCall');
        if (hasToolCall) {
          modified = true;
          return {
            ...m,
            content: m.content.filter((c: any) => c.type !== 'toolCall')
          };
        }
      }
      return m;
    }).filter(Boolean);
    
    if (modified) {
      console.log(`[session-id] MODEL_REQUEST cleaned toolCall objects`);
    }
    
    return modified ? { messages } : undefined;
  });

  // ── Error handling ──
  pi.on("model_error", async (event: any) => {
    if (event?.error?.statusCode === 400) {
      console.log(`[session-id] 400 ERROR: ${event.error.message || String(event.error)}`);
      
      if (event.request) {
        console.log(`[session-id] Request URL: ${event.request.url || 'N/A'}`);
        if (event.request.body) {
          try {
            const body = typeof event.request.body === 'string' 
              ? JSON.parse(event.request.body) 
              : event.request.body;
            if (body.messages) {
              const roles = body.messages.map((m: any) => m.role).join(' → ');
              console.log(`[session-id] Request body roles: ${roles}`);
              console.log(`[session-id] Request body: ${JSON.stringify(body).slice(0, 1000)}`);
            }
          } catch (e) {
            console.log(`[session-id] Error parsing request body: ${e}`);
          }
        }
      }
    }
  });
}
