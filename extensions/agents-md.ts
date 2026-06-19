/**
 * pi AGENTS.md — creates AGENTS.md from internal template if missing.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export default function (pi: ExtensionAPI) {
  // ── Session start: create AGENTS.md if missing ──
  pi.on("session_start", async (_event: any, ctx: any) => {
    const agentsMdPath = path.join(ctx.cwd || process.cwd(), "AGENTS.md");
    try {
      await fs.access(agentsMdPath);
      return; // already exists
    } catch {
      // doesn't exist, create it
    }

    const createdDate = new Date().toISOString().split("T")[0];
    const content = `# AGENTS.md
## Session
**Created**: ${createdDate}
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
    await fs.writeFile(agentsMdPath, content, "utf-8");
    ctx.ui.notify(`Created AGENTS.md`, "info");
  });
}
