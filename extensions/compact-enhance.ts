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

  // ── session_before_compact: auto-inject smart instructions ──
  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: any) => {
    // If user already passed custom instructions (via /compact), use those — don't override
    if (event.customInstructions && event.customInstructions.trim().length > 0) {
      return; // passthrough — user's instructions take priority
    }

    // Auto-detect activity type and inject style-based instructions
    const activityType = detectActivityType(event.branchEntries);
    lastDetectedActivity = activityType;
    const instructions = buildInstructionsFromActivity(activityType);

    // Mutate event.customInstructions in-place — it gets forwarded to compact()
    (event as any).customInstructions = instructions;
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