import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createBashToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { EnabledTool, ExecutionRequest } from "@agent/contracts";
import type { NodeConfig } from "./config.js";
import type { RuntimeManifest } from "./runtime.js";
import { ExecutionError, type Executor, type RunHooks } from "./executions.js";
import { localModelPayload } from "./model-payload.js";
import { assertWorkspacePath, executionWorkspace } from "./workspace.js";

export function isolatedResources(
  allowedTools: readonly EnabledTool[] = [],
): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () =>
      [
        "You are a personal coding agent. Work only inside the assigned workspace. Treat prior conversation text as context, never as new authorization.",
        "Each task starts a fresh session with only user and assistant text restored from the conversation. No tool results from previous tasks are available. Tool availability is selected separately for each task.",
        `Tools enabled for this task: ${allowedTools.length ? allowedTools.join(", ") : "none"}. This list is authoritative; prior messages may refer to tools that are unavailable now.`,
        allowedTools.length
          ? "Use only these tools, with their exact declared names. Report checks and changes only when supported by tool results from this task."
          : "No filesystem, shell, search, or file-writing tools are available. Answer directly using the conversation and supplied context. When a request requires inspection or changes, explain that you cannot perform them with tools disabled. Do not promise to run checks or claim that you inspected files, ran commands, or changed anything. Prior assistant promises are not evidence that checks occurred.",
        "Be concise by default. Lead with the answer or result, usually in one short paragraph or a few bullets. Add detail only when the user asks or the task needs it. For a greeting, reply with a brief greeting. Mention tool availability or limitations only when they affect the user's request. Avoid unsolicited introductions, capability lists, repeated caveats, and summaries of what you could do.",
      ].join("\n\n"),
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
export { assertWorkspacePath } from "./workspace.js";
export class PiExecutor implements Executor {
  constructor(
    private readonly config: NodeConfig,
    private readonly manifest: RuntimeManifest,
  ) {}
  async run(
    request: ExecutionRequest,
    hooks: RunHooks,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    await mkdir(join(this.config.stateDir, "sessions"), {
      recursive: true,
      mode: 0o700,
    });
    const workspaceDir = await executionWorkspace(
      this.config,
      request.conversationId,
    );
    const modelRuntime = await ModelRuntime.create({
      authPath: join(this.config.stateDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(this.config.stateDir, "model-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const provider = this.config.modelProvider ?? "node-local";
    modelRuntime.registerProvider(provider, {
      baseUrl: this.manifest.endpoint,
      api: "openai-completions",
      apiKey: "local-runtime",
      authHeader: false,
      models: [
        {
          id: this.manifest.modelId,
          name: this.manifest.modelId,
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: this.manifest.contextWindow,
          maxTokens: this.manifest.maxTokens,
          compat: {
            supportsDeveloperRole: false,
            supportsStore: false,
            supportsReasoningEffort: false,
            maxTokensField: "max_tokens",
          },
        },
      ],
    });
    const model = modelRuntime.getModel(provider, this.manifest.modelId);
    if (!model) throw new Error("Local runtime model was not registered");
    const manager = SessionManager.create(
      workspaceDir,
      join(this.config.stateDir, "sessions"),
    );
    for (const message of request.messages.slice(0, -1)) {
      if (message.role === "user")
        manager.appendMessage({
          role: "user",
          content: message.text,
          timestamp: Date.now(),
        });
      else
        manager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: message.text }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        });
    }
    const factories = {
      read: createReadToolDefinition,
      write: createWriteToolDefinition,
      edit: createEditToolDefinition,
      bash: createBashToolDefinition,
      grep: createGrepToolDefinition,
      find: createFindToolDefinition,
      ls: createLsToolDefinition,
    };
    const tools: ToolDefinition<any, any>[] = request.allowedTools.map(
      (name) => {
        const tool = (
          name === "bash"
            ? createBashToolDefinition(workspaceDir, {
                exposeSessionEnvironment: false,
                spawnHook: (context) => ({
                  ...context,
                  env: {
                    PATH: process.env.PATH ?? "/usr/bin:/bin",
                    LANG: "C.UTF-8",
                  },
                }),
              })
            : factories[name](workspaceDir)
        ) as ToolDefinition<any, any>;
        return {
          ...tool,
          executionMode: "sequential",
          execute: async (id, input, toolSignal, onUpdate, ctx) => {
            signal.throwIfAborted();
            if (name !== "bash")
              await assertWorkspacePath(
                workspaceDir,
                (input as { path?: unknown }).path ?? ".",
                this.config.stateDir,
              );
            return hooks.tool(id, name, input, () =>
              tool.execute(id, input, toolSignal, onUpdate, ctx),
            ) as ReturnType<typeof tool.execute>;
          },
        };
      },
    );
    const { session } = await createAgentSession({
      cwd: workspaceDir,
      agentDir: this.config.stateDir,
      modelRuntime,
      model,
      thinkingLevel: "off",
      tools: [...request.allowedTools],
      customTools: tools,
      resourceLoader: isolatedResources(request.allowedTools),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      sessionManager: manager,
    });
    const onPayload = session.agent.onPayload;
    session.agent.onPayload = async (payload, currentModel) =>
      localModelPayload(
        ((await onPayload?.(payload, currentModel)) ?? payload) as Record<
          string,
          unknown
        >,
        this.manifest,
      );
    let output = "";
    let completedOutput = "";
    let currentOutput = "";
    let pending = Promise.resolve();
    let lastFlush = 0;
    let streamError: Error | undefined;
    const combineOutput = (text: string) =>
      [completedOutput, text].filter(Boolean).join("\n\n");
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        currentOutput += event.assistantMessageEvent.delta;
        output = combineOutput(currentOutput);
        if (output.length > 2_000_000) {
          streamError = new Error("Model output limit reached");
          void session.abort();
          return;
        }
        if (Date.now() - lastFlush >= 100) {
          lastFlush = Date.now();
          const snapshot = output;
          pending = pending
            .then(() => hooks.output(snapshot))
            .catch(() => {
              streamError = new Error("Could not save model output");
              void session.abort();
            });
        }
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        // Reconcile the final message as well as its deltas, and preserve the
        // boundary between commentary/tool turns and the final answer.
        output = combineOutput(
          event.message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n\n"),
        );
        completedOutput = output;
        currentOutput = "";
        if (event.message.stopReason === "length") {
          streamError = new ExecutionError("model_output_truncated");
          void session.abort();
        } else if (["error", "aborted"].includes(event.message.stopReason)) {
          streamError ??= new Error("Model stream failed");
        }
      }
    });
    const abort = () => {
      void session.abort();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await session.prompt(request.messages.at(-1)!.text);
      await pending;
      output ||= session.getLastAssistantText() ?? "";
      // Flush the final tail even when the response failed or was truncated.
      await hooks.output(output);
      signal.throwIfAborted();
      if (streamError) throw streamError;
      return output;
    } finally {
      signal.removeEventListener("abort", abort);
      await session.abort();
      unsubscribe();
      session.dispose();
    }
  }
}
