/**
 * pi Compact Enhancement — smarter context compaction.
 *
 * Features:
 * - `/compact [style]` — trigger manual compaction with a summarization style
 *   Styles: concise | detailed | bugfix | feature | refactor | explore
 *   (no arg = auto-detect activity type and pick best style)
 * - `session_before_compact` — auto-injects smart custom instructions per activity type
 * - `session_compact` — shows stats notification after compaction
 * - `/compact-stats` — shows history of past compactions
 *
 * The extension influences the LLM summarizer via custom instructions injected
 * into the `session_before_compact` event. The actual summary generation still
 * runs through pi's built-in compact() flow.
 */
import type { ExtensionAPI, ExtensionCommandContext, SessionBeforeCompactEvent, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Activity detection
// ---------------------------------------------------------------------------

type ActivityType = "bugfix" | "feature" | "refactor" | "explore" | "unknown";

function detectActivityType(entries: any[]): ActivityType {
  const seen = new Set<string>();
  const keywords: [RegExp, ActivityType][] = [
    [/bug|fix|error|crash|fail|exception|panic/i, "bugfix"],
    [/refactor|restructure|cleanup|simplif/i, "refactor"],
    [/implement|add|build|create|feature/i, "feature"],
    [/explore|investigate|analyze|understand|research/i, "explore"],
  ];

  for (const entry of entries) {
    let text = "";

    if (entry.type === "message") {
      text = typeof entry.message.content === "string"
        ? entry.message.content
        : entry.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
    } else if (entry.type === "custom_message" || entry.type === "branch_summary" || entry.type === "compaction") {
      const summary = "summary" in entry ? entry.summary : "content" in entry ? (entry as any).content : "";
      if (typeof summary === "string") text = summary;
    } else if (entry.type === "custom") {
      text = (entry as any).content || "";
    }

    if (!text || seen.has(text)) continue;
    seen.add(text);

    for (const [re, type] of keywords) {
      if (re.test(text)) return type;
    }
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Style prompt templates
// ---------------------------------------------------------------------------

type CompactStyle = "concise" | "detailed" | "bugfix" | "feature" | "refactor" | "explore";

const STYLE_PROMPTS: Record<CompactStyle, string> = {
  /** Short bullet-only summary — minimal context, maximum compression */
  concise: `Focus: produce an extremely concise summary. Use short bullet points. Omit routine details. Preserve only: active bugs, pending changes, next action.`,

  /** Preserve all decisions, rationale, and context — for complex work */
  detailed: `Focus: preserve maximum detail. Keep all decisions, rationales, error traces, and configuration values. This is for complex multi-session work.`,

  /** Bug fix session — prioritize root cause and fix approach */
  bugfix: `Focus: this was a bug-fixing session. In the summary, emphasize: exact error symptoms, root cause diagnosis (cite file + line), fix approach taken, and remaining risk/follow-up.`,

  /** Feature development — prioritize architecture and implementation plan */
  feature: `Focus: this was a feature-building session. In the summary, emphasize: design decisions, key file changes, exported APIs or interfaces, and what remains to be done.`,

  /** Refactoring session — prioritize changes and rationale */
  refactor: `Focus: this was a refactoring session. In the summary, emphasize: what was restructured, why it needed changing, and how the new structure differs from the old.`,

  /** Exploration/research — prioritize findings and next steps */
  explore: `Focus: this was an exploration/research session. In the summary, emphasize: what was discovered, key insights or patterns found, and what was decided as next step.`,
};

/** Build custom instructions from a style + optional extra focus. */
function buildCustomInstructions(style: CompactStyle, extraFocus?: string): string {
  let instructions = STYLE_PROMPTS[style];
  if (extraFocus) {
    instructions += `\n\nAdditional focus: ${extraFocus}`;
  }
  return instructions;
}

// ---------------------------------------------------------------------------
// History tracking (in-session state)
// ---------------------------------------------------------------------------

interface CompactStats {
  timestamp: number;
  tokensBefore: number;
  entriesCount: number;
  style: CompactStyle | "auto";
  activityType: ActivityType;
  summaryLength: number;
}

const compactHistory: CompactStats[] = [];
let lastDetectedActivity: ActivityType = "unknown";

function buildInstructionsFromActivity(activityType: ActivityType): string {
  const styleMap: Record<ActivityType, CompactStyle> = {
    bugfix: "bugfix",
    feature: "feature",
    refactor: "refactor",
    explore: "explore",
    unknown: "concise",
  };
  return buildCustomInstructions(styleMap[activityType]);
}

// ---------------------------------------------------------------------------
// /compact command
// ---------------------------------------------------------------------------

async function handleCompactCommand(ctx: ExtensionCommandContext, styleArg: string): Promise<void> {
  // Parse style
  const raw = styleArg.trim().toLowerCase();

  let style: CompactStyle = "concise";
  let extraFocus: string | undefined;

  if (raw && raw !== "auto") {
    // Check if it's a known style
    if (raw in STYLE_PROMPTS) {
      style = raw as CompactStyle;
    } else {
      // Treat as custom focus text
      extraFocus = styleArg.trim();
      style = "concise";
    }
  } else {
    // Auto-detect
    const entries = (ctx as any).sessionManager?.getBranch?.() || [];
    const activity = detectActivityType(entries);
    const styleMap: Record<ActivityType, CompactStyle> = {
      bugfix: "bugfix",
      feature: "feature",
      refactor: "refactor",
      explore: "explore",
      unknown: "concise",
    };
    style = styleMap[activity];
    ctx.ui.notify(
      `Compacting (${style}${activity !== "unknown" ? `, detected: ${activity}` : ""})…`,
      "info",
    );
  }

  const instructions = buildCustomInstructions(style, extraFocus);

  // Trigger compaction with custom instructions
  (ctx as any).compact?.({ customInstructions: instructions, onComplete: (result: any) => {
    ctx.ui.notify(
      `Compacted: ${result.tokensBefore?.toLocaleString() ?? "?"} tokens → ${result.summary?.length ?? 0} chars summary.`,
      "info",
    );
  }});
}

// ---------------------------------------------------------------------------
// /compact-stats command
// ---------------------------------------------------------------------------

async function handleCompactStats(ctx: ExtensionCommandContext): Promise<void> {
  if (compactHistory.length === 0) {
    ctx.ui.notify("No compaction history for this session.", "info");
    return;
  }

  const lines = compactHistory.map((s, i) => {
    const date = new Date(s.timestamp).toLocaleTimeString();
    const tokens = s.tokensBefore?.toLocaleString() ?? "?";
    const summaryLen = s.summaryLength ?? 0;
    const activity = s.activityType;
    return `${i + 1}. [${date}] ${s.style} · ${tokens} tokens · ${summaryLen} summary · (${activity})`;
  });

  ctx.ui.notify(`Compaction history:\n${lines.join("\n")}`, "info");
}

// ---------------------------------------------------------------------------
// AGENTS.md discovery (mirrors pi's resource-loader.ts logic)
// ---------------------------------------------------------------------------

/** Candidates checked by pi for context files. */
const CONTEXT_FILE_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/**
 * Read the first matching context file from dir, or undefined if none found.
 * Matches pi's loadContextFileFromDir() logic.
 */
async function readContextFileFromDir(dir: string): Promise<string | null> {
  for (const name of CONTEXT_FILE_CANDIDATES) {
    try {
      const filePath = path.join(dir, name);
      await fs.access(filePath);
      return await fs.readFile(filePath, "utf-8");
    } catch {
      // not found — try next candidate
    }
  }
  return null;
}

/**
 * Discover AGENTS.md content, matching pi's loadProjectContextFiles():
 * 1. Check cwd
 * 2. Walk up ancestor dirs (pi walks to root; we cap at 10 levels for safety)
 * 3. Fall back to agentDir (~/.pi)
 * Returns first match found.
 */
async function discoverAgentsMd(cwd: string, agentDir: string): Promise<string | null> {
  // 1. cwd (and its ancestors)
  let current = cwd;
  for (let i = 0; i < 10; i++) {
    const content = await readContextFileFromDir(current);
    if (content !== null) return content;

    const parent = path.resolve(current, "..");
    if (parent === current) break; // reached root
    current = parent;
  }

  // 2. agentDir (~/.pi)
  try {
    const content = await readContextFileFromDir(agentDir);
    if (content !== null) return content;
  } catch {
    // no agents.md in agentDir either
  }

  return null;
}

/**
 * Build the constraints reminder for summarization.
 * If AGENTS.md content was found, prepend it so the summarizer knows
 * the operational directives that governed the session.
 */
function buildAgentsMdReminder(agentsMdContent: string | null): string {
  if (!agentsMdContent) return "";

  const trimmed = agentsMdContent.trim();
  if (!trimmed) return "";

  return `

## Operational Directives (from AGENTS.md)

The conversation below was governed by these directives. Preserve ALL rules, constraints, and patterns described in the summary output so that the summary is self-contained and another LLM reading only the summary understands the full operational context.

${trimmed}`;
}

/**
 * Add dummy toolResult entries after every assistant message that has toolCall
 * blocks in the summarized range.
 *
 * When compaction cuts at an assistant message containing toolCall blocks, those
 * tool calls execute and produce toolResult entries — but those results fall on
 * the KEPT side of the cut (after the cut point). The summarizer sees orphan
 * tool calls (with no result in the summarized range), breaking the tool →
 * result pairing.
 *
 * Fix: after each assistant message that has toolCall blocks, insert a dummy
 * toolResult entry with a placeholder to complete the pair. The summarizer
 * sees complete toolCall → toolResult chains and can process them normally.
 * The dummy result is clearly marked as [compacted] so the summarizer can
 * treat it as informational rather than literal.
 */
function completeOrphanToolCalls(messages: any[]): void {
  const DUMMY_RESULT = {
    role: "toolResult" as const,
    content: [{ type: "text" as const, text: "[compacted: tool result in kept context]" }],
    toolCallId: "__compact_dummy__",
  };

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;

    const hasToolCalls = msg.content.some(
      (block: any) => block?.type === "toolCall",
    );
    if (!hasToolCalls) continue;

    // Insert dummy toolResult right after this assistant message
    messages.splice(i + 1, 0, { ...DUMMY_RESULT });
  }
}

/**
 * Complete orphan toolResult entries in the turn prefix by prepending a dummy
 * assistant message with the corresponding toolCall blocks.
 *
 * In split-turn compaction, turnPrefixMessages may contain toolResult entries
 * whose tool calls are in the suffix (kept range). The summarizer sees orphan
 * tool results with no preceding tool call — ambiguous and potentially confusing.
 *
 * Fix: for each toolResult entry in the prefix, prepend a dummy assistant
 * message containing a matching toolCall block (with dummy arguments). This
 * completes the toolCall → toolResult pair so the summarizer sees a valid
 * chain. The dummy entries are marked as [compacted] to distinguish them.
 */
function completeOrphanToolResults(messages: any[]): void {
  const toInject: any[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "toolResult") continue;

    const toolCallId = msg.toolCallId || "__compact_dummy__";
    const dummyToolCall = {
      type: "toolCall",
      id: toolCallId,
      name: "[compacted_tool]",
      arguments: { __compacted__: true },
    };
    const dummyAssistant = {
      role: "assistant",
      content: [
        { type: "text", text: "[compacted: tool call in kept context]" },
        dummyToolCall,
      ],
    };

    toInject.push({ afterIndex: i, assistant: dummyAssistant });
  }

  // Inject dummy assistants in reverse order so indices stay valid
  for (let j = toInject.length - 1; j >= 0; j--) {
    const { afterIndex, assistant } = toInject[j];
    messages.splice(afterIndex, 0, assistant);
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ── /compact ──
  pi.registerCommand("compact", {
    description: "Compact session context. Styles: concise | detailed | bugfix | feature | refactor | explore. No arg = auto-detect. Append custom focus text for any additional summarization emphasis.",
    getArgumentCompletions: (prefix: string) => {
      const opts: CompactStyle[] = ["concise", "detailed", "bugfix", "feature", "refactor", "explore"];
      return opts.filter(o => o.startsWith(prefix)).map(o => ({ value: o, label: o }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await handleCompactCommand(ctx, args);
    },
  });

  // ── /compact-stats ──
  pi.registerCommand("compact-stats", {
    description: "Show compaction history for this session.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await handleCompactStats(ctx);
    },
  });

    // ── session_before_compact: auto-inject smart instructions + fix orphan tool pairs ──
    pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: any) => {
      const prep = event.preparation;
      if (!prep) return;

      // ── Fix orphan tool calls/results BEFORE summarization ──
      // For messagesToSummarize: each assistant with toolCalls is orphan because
      // its toolResult entries are in the KEPT range. Insert dummy toolResult
      // after each such assistant to complete the pair.
      completeOrphanToolCalls(prep.messagesToSummarize);

      // For turnPrefixMessages: each toolResult is orphan because its toolCall
      // is in the kept suffix. Prepend a dummy assistant+toolCall before each
      // orphan toolResult to complete the pair.
      if (prep.isSplitTurn) {
        completeOrphanToolResults(prep.turnPrefixMessages);
      }

      // ── Build summarization instructions ──
      const userInstructions = (event.customInstructions || "").trim();

      // Discover AGENTS.md content (mirrors pi's resource-loader discovery order:
      // cwd → ancestors → ~/.pi/agent)
      const agentDir = ctx.sessionManager?.agentDir
        ?? path.join(process.env.HOME || "/data/data/com.termux/files/home", ".pi");
      const cwd = ctx.cwd || process.cwd();
      const agentsMdContent = await discoverAgentsMd(cwd, agentDir);
      const agentsMdReminder = buildAgentsMdReminder(agentsMdContent);

      // Auto-detect activity type and build style instructions
      const activityType = detectActivityType(event.branchEntries);
      lastDetectedActivity = activityType;
      const styleInstructions = buildInstructionsFromActivity(activityType);

      // Compose: AGENTS.md directives first, then style instructions, then user focus
      const allInstructions = [agentsMdReminder, styleInstructions, userInstructions]
        .filter(Boolean)
        .join("\n\n");

      // Mutate event.customInstructions in-place — forwarded to compact()
      (event as any).customInstructions = allInstructions;
    });

  // ── session_compact: stats notification ──
  pi.on("session_compact", (event: SessionCompactEvent) => {
    const entry = event.compactionEntry;
    const summary = entry.summary || "";
    const tokensBefore = entry.tokensBefore || 0;
    const wordCount = summary.split(/\s+/).filter(Boolean).length;

    compactHistory.push({
      timestamp: Date.now(),
      tokensBefore,
      entriesCount: 0,
      style: "auto",
      activityType: lastDetectedActivity,
      summaryLength: summary.length,
    });

    // Small notification — don't spam the user
    const usage = compactHistory.length;
    const trunc = summary.length > 80 ? `${summary.slice(0, 80)}…` : summary;
    console.info(`[compact] #${usage} · ${tokensBefore.toLocaleString()} tokens · ${wordCount} words · "${trunc.replace(/\n/g, " ")}"`);
  });
}