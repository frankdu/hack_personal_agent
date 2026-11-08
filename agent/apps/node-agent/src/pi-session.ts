import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { NodeConfig } from "./config.js";

/** Do not discover ambient extensions, skills, prompts, or project instructions. */
export function isolatedResources(): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "You are a personal coding agent. Use only the tools explicitly supplied by the host.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/** A lazy SDK boundary. No model execution or credential discovery at service boot. */
export class PiSessions {
  private readonly active = new Set<AgentSession>();
  private modelRuntime?: Promise<ModelRuntime>;
  private closing = false;

  constructor(private readonly config: NodeConfig) {}

  async create(): Promise<AgentSession> {
    if (this.closing) throw new Error("Node agent is shutting down");
    if (!this.config.modelProvider || !this.config.modelId) {
      throw new Error("Configure MODEL_PROVIDER and MODEL_ID before creating a session");
    }
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    const sessionsDir = join(this.config.stateDir, "sessions");
    await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
    this.modelRuntime ??= ModelRuntime.create({
      authPath: join(this.config.stateDir, "auth.json"),
      modelsPath: join(this.config.stateDir, "models.json"),
      modelsStorePath: join(this.config.stateDir, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    }).catch((error: unknown) => {
      this.modelRuntime = undefined;
      throw error;
    });
    const modelRuntime = await this.modelRuntime;
    const model = modelRuntime.getModel(this.config.modelProvider, this.config.modelId);
    if (!model) throw new Error("Configured model is not present in this node's model registry");
    const { session } = await createAgentSession({
      cwd: this.config.workspaceDir,
      agentDir: this.config.stateDir,
      modelRuntime,
      model,
      thinkingLevel: "off",
      tools: [...this.config.enabledTools],
      resourceLoader: isolatedResources(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      sessionManager: SessionManager.create(this.config.workspaceDir, sessionsDir),
    });
    if (this.closing) {
      session.dispose();
      throw new Error("Node agent is shutting down");
    }
    this.active.add(session);
    return session;
  }

  release(session: AgentSession): void {
    session.dispose();
    this.active.delete(session);
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.active].map(async (session) => {
      try {
        await session.abort();
      } finally {
        session.dispose();
      }
    }));
    this.active.clear();
  }
}
