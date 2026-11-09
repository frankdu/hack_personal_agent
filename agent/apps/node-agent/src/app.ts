import { mkdir, realpath, stat, rm, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, relative, isAbsolute } from "node:path";
import { readConfig, type NodeConfig } from "./config.js";
import { durableWrite, readJson } from "./storage.js";
import { inspectHardware } from "./hardware.js";
import {
  loadRuntime,
  RuntimeSupervisor,
  validateRuntimeHardware,
} from "./runtime.js";
import { OllamaDiscovery } from "./ollama.js";
import { PiExecutor } from "./pi-session.js";
import { Enrollment } from "./enrollment.js";
import { Executions, RequestError } from "./executions.js";
import { createNodeServer } from "./server.js";
import { Terminals } from "./terminals.js";
import { Projects } from "./projects.js";
async function acquire(stateDir: string, bootId: string) {
  const path = join(stateDir, "owner.lock");
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = JSON.parse(
      await readFile(join(path, "owner.json"), "utf8"),
    ) as { pid: number };
    if (!Number.isInteger(existing.pid) || existing.pid < 1)
      throw new Error("Invalid state lock");
    try {
      process.kill(existing.pid, 0);
      throw new Error("Node state directory already in use");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
    await rm(path, { recursive: true });
    await mkdir(path);
  }
  await durableWrite(join(path, "owner.json"), { pid: process.pid, bootId });
  return async () => {
    const owner = (await readJson(join(path, "owner.json"))) as
      { bootId: string } | undefined;
    if (owner?.bootId === bootId) await rm(path, { recursive: true });
  };
}
export async function startNode(config: NodeConfig = readConfig()) {
  if (config.workspaceDirIsDefault)
    await mkdir(config.workspaceDir, { recursive: true });
  if (!(await stat(config.workspaceDir)).isDirectory())
    throw new Error("Workspace must be a directory");
  config = { ...config, workspaceDir: await realpath(config.workspaceDir) };
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  config = { ...config, stateDir: await realpath(config.stateDir) };
  const stateWithinWorkspace = relative(config.workspaceDir, config.stateDir);
  if (
    config.enabledTools.length &&
    (stateWithinWorkspace === "" ||
      (!stateWithinWorkspace.startsWith("..") &&
        !isAbsolute(stateWithinWorkspace)))
  )
    throw new Error(
      "Private node state must be outside any tool-enabled workspace",
    );
  const bootId = randomUUID();
  const unlock = await acquire(config.stateDir, bootId);
  let runtime: RuntimeSupervisor | undefined;
  let discovery: OllamaDiscovery | undefined;
  let enrollment: Enrollment | undefined;
  let executions: Executions | undefined;
  let terminals: Terminals | undefined;
  try {
    const projects = new Projects(config);
    await projects.initialize();
    const stored = (await readJson(join(config.stateDir, "identity.json"))) as
      { nodeId: string } | undefined;
    const nodeId = stored?.nodeId ?? randomUUID();
    if (!/^[a-f0-9-]{36}$/.test(nodeId))
      throw new Error("Invalid persisted identity");
    await durableWrite(join(config.stateDir, "identity.json"), { nodeId });
    const [hardware, manifest] = await Promise.all([
      inspectHardware(),
      loadRuntime(config.runtimeConfigPath),
    ]);
    if (manifest) {
      validateRuntimeHardware(manifest, hardware);
      runtime = new RuntimeSupervisor(
        manifest,
        nodeId,
        config.stateDir,
        hardware.availableMemoryBytes,
      );
    } else if (config.ollama.enabled)
      discovery = new OllamaDiscovery(
        config.ollama,
        hardware,
        nodeId,
        config.stateDir,
        () => Boolean(executions?.activeIds().length),
      );
    const profiles = () =>
      runtime ? [runtime.profile()] : (discovery?.profiles() ?? []);
    const readyProfile = () =>
      runtime?.profile().state === "ready"
        ? runtime.profile().id
        : discovery?.readyProfile();
    enrollment = new Enrollment(
      config,
      nodeId,
      bootId,
      hardware,
      profiles,
      () => executions?.activeIds() ?? [],
    );
    executions = new Executions(
      config,
      nodeId,
      bootId,
      () => enrollment!.current(),
      readyProfile,
      {
        run: async (request, hooks, signal) => {
          const selected = manifest ?? discovery?.manifest;
          if (!selected || selected.profileId !== request.profileId)
            throw new Error("No selected runtime for this profile");
          return new PiExecutor(config, selected).run(request, hooks, signal);
        },
      },
    );
    await executions.initialize();
    terminals = new Terminals(
      config,
      nodeId,
      bootId,
      () => enrollment!.current(),
      projects,
    );
    await terminals.initialize();
    enrollment.onLeaseLost = () => {
      executions!.abort("lease_lost");
      terminals!.revoke();
    };
    if (runtime)
      runtime.onUnavailable = () => executions!.abort("runtime_unavailable");
    if (discovery)
      discovery.onUnavailable = () => executions!.abort("runtime_unavailable");
    const { server, drain } = createNodeServer(config, {
      projects,
      terminals,
      executions,
      hardware,
      nodeId,
      bootId,
      profiles,
      registered: () => Boolean(enrollment!.current()),
      discoveryStatus: () => discovery?.status,
      selectModel: discovery
        ? (input) => {
            const lease = enrollment!.current();
            if (
              !lease ||
              input.bootId !== bootId ||
              input.generation !== lease.generation
            )
              throw new RequestError(
                409,
                "stale_lease",
                "The node lease changed; refresh and retry.",
              );
            discovery!.select(input.profileId);
          }
        : undefined,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const starting = Promise.all([
      enrollment.start(),
      runtime?.start(),
      discovery?.start(),
    ]);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      drain();
      try {
        await terminals!.close();
        await executions!.close();
        await Promise.allSettled([
          enrollment!.close(),
          runtime?.close(),
          discovery?.close(),
          starting,
        ]);
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections();
        });
        await unlock();
      }
    };
    return {
      server,
      nodeId,
      bootId,
      executions,
      terminals,
      runtime,
      discovery,
      enrollment,
      close,
      started: starting,
    };
  } catch (error) {
    await terminals?.close().catch(() => {});
    await discovery?.close().catch(() => {});
    await runtime?.close().catch(() => {});
    await enrollment?.close();
    await unlock();
    throw error;
  }
}
