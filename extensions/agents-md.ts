/**
 * pi AGENTS.md — creates AGENTS.md from internal template if missing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const AGENTS_MD = `# AGENTS.md

## Session
**Session ID**: ${sessionIdPlaceholder}
**Created**: ${datePlaceholder}

## Context
This file documents the active session and agent configuration.

## Extensions
- pi-replace-tool: Enhanced replace with content dump on no-match
- pi-multi-subs: Interactive subscription manager (/subs)
- pi-multi-pass: Interactive route manager (/route)
- pi-session-id: Session tracking and Mistral role fixes

## Rules
- Use ctx.ui.notify(message, level) for all inline output
- Use Node.js fs/promises for file operations
- Provisioned providers selectable via ctx.ui.select()
- Cloned provider names auto-generated as -N suffix
- Session ID injected into system prompts for Mistral compatibility
`;

export default function (pi: ExtensionAPI) {
  let sessionId = "";

  // ── Session start: create AGENTS.md if missing ──
  pi.on("session_start", async (_event: any, ctx: any) => {
    const agentsMdPath = path.join(ctx.cwd || process.cwd(), "AGENTS.md");

    try {
      await fs.access(agentsMdPath);
      return; // already exists
    } catch {
      // doesn't exist, create it
    }

    // Get session ID if available
    try {
      const sidPath = path.join(
        process.env.HOME || "/data/data/com.termux/files/home",
        ".pi/agent/session-id"
      );
      sessionId = (await fs.readFile(sidPath, "utf-8")).trim();
    } catch {
      sessionId = "unknown";
    }

    const content = AGENTS_MD
      .replace("${sessionIdPlaceholder}", sessionId)
      .replace("${datePlaceholder}", new Date().toISOString().split("T")[0]);

    await fs.writeFile(agentsMdPath, content, "utf-8");
    ctx.ui.notify(`Created AGENTS.md`, "info");
  });
}
