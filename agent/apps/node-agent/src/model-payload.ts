import type { RuntimeManifest } from "./runtime.js";

/** Fit the reply to this local runtime, including the system prompt and tool schemas. */
export function localModelPayload(
  payload: Record<string, unknown>,
  manifest: Pick<RuntimeManifest, "contextWindow" | "maxTokens" | "ollama">,
): Record<string, unknown> {
  // Pi 1.5's simple stream reserves a fixed 4096 tokens and clamps 4K models to
  // one output token. Recompute at the wire boundary with proportional headroom.
  // This is an estimate, not tokenizer admission; the runtime validates the input.
  const promptTokens = Math.ceil(
    Buffer.byteLength(
      JSON.stringify({ messages: payload.messages, tools: payload.tools }),
      "utf8",
    ) / 3,
  );
  const reserve = Math.min(4096, Math.ceil(manifest.contextWindow / 8));
  const maxTokens = Math.min(
    manifest.maxTokens,
    manifest.contextWindow - promptTokens - reserve,
  );
  if (maxTokens < Math.min(128, manifest.maxTokens))
    throw new Error("Conversation leaves too little context for a reply.");
  return {
    ...payload,
    max_tokens: maxTokens,
    ...(manifest.ollama ? { reasoning_effort: "none" } : {}),
  };
}
