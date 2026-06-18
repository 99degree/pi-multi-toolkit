/**
 * pi-search-tool — provides /search command for code search.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("search", {
    description: "Search files using ripgrep (rg) or grep",
    handler: async (query: string, ctx: any) => {
      if (!query) {
        ctx.ui.notify("Usage: /search <pattern> [--files|--dir <dir>]", "error");
        return;
      }

      let args = ["--color=never", "--line-number"];
      let searchPath = ctx.cwd || process.cwd();

      // Parse simple flags
      const queryParts = query.split(/\s+--/);
      const pattern = queryParts[0];
      const flags = queryParts.slice(1);

      for (const flag of flags) {
        if (flag.startsWith("files")) {
          args.push("--files");
        } else if (flag.startsWith("dir=")) {
          searchPath = flag.slice(4);
        } else if (flag.startsWith("type=")) {
          args.push(`--type=${flag.slice(5)}`);
        } else if (flag.startsWith("glob=")) {
          args.push(`--glob=${flag.slice(5)}`);
        }
      }

      args.push(pattern);
      args.push(searchPath);

      try {
        const { stdout } = await ctx.bash(`rg ${args.join(" ")}`, { timeout: 30 });
        if (stdout) {
          ctx.ui.notify(stdout, "info");
        } else {
          ctx.ui.notify("No matches found", "hint");
        }
      } catch {
        // Try with grep if rg fails
        try {
          const { stdout } = await ctx.bash(
            `grep -rn --color=never "${pattern}" ${searchPath}`,
            { timeout: 30 }
          );
          if (stdout) {
            ctx.ui.notify(stdout, "info");
          } else {
            ctx.ui.notify("No matches found", "hint");
          }
        } catch (e: any) {
          ctx.ui.notify(`Search error: ${e.message || String(e)}`, "error");
        }
      }
    },
  });
}
