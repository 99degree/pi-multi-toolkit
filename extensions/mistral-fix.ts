/**
 * pi Mistral Fix — fixes Mistral's strict role alternation.
 *
 * Mistral strict-mode APIs reject tool → user; they require
 * tool → assistant → user. This inserts an assistant message
 * between toolResult and user directly in the API payload.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function isMistralModel(modelId?: string): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  const name = id.split("/").pop() || id;
  return /^mistral[-.]/.test(name) || name.startsWith("mistral");
}

function ensureToolAssistantUser(msgs: any[]): boolean {
  let modified = false;
  for (let i = 0; i < msgs.length - 1; i++) {
    if (msgs[i]?.role === "tool" && msgs[i + 1]?.role === "user") {
      msgs.splice(i + 1, 0, {
        role: "assistant",
        content: "Continuing",
      });
      modified = true;
      i++;
    }
  }
  return modified;
}

export default function (pi: ExtensionAPI) {
  let notified = false;

  pi.on("before_provider_request", async (event: any, ctx: ExtensionContext) => {
    if (!isMistralModel(ctx?.model?.id)) {
      notified = false;
      return;
    }

    if (!notified) {
      notified = true;
      ctx.ui.notify(`Mistral tool role fix: ${ctx.model?.id || "?"}`, "info");
    }

    const msgs = event?.payload?.messages;
    if (!msgs || !Array.isArray(msgs) || msgs.length < 2) return;

    if (ensureToolAssistantUser(msgs)) {
      return event.payload;
    }
  });
}
