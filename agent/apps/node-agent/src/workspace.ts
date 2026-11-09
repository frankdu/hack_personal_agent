import { mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { NodeConfig } from "./config.js";

export async function assertWorkspacePath(
  root: string,
  path: unknown,
  forbiddenRoot?: string,
): Promise<void> {
  if (typeof path !== "string") throw new Error("Tool path is required");
  const canonicalRoot = await realpath(root);
  const requested = resolve(canonicalRoot, path);
  let existing = requested;
  while (true) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        dirname(existing) === existing
      )
        throw error;
      existing = dirname(existing);
    }
  }
  for (const candidate of [requested, existing]) {
    const inside = relative(canonicalRoot, candidate);
    if (
      inside === ".." ||
      inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(inside)
    )
      throw new Error("Tool path is outside the approved workspace");
    if (forbiddenRoot) {
      const forbidden = relative(await realpath(forbiddenRoot), candidate);
      if (
        forbidden === "" ||
        (!forbidden.startsWith("..") && !isAbsolute(forbidden))
      )
        throw new Error("Tool path is inside private node state");
    }
  }
}

/** Conversation IDs keep a chat's files together across turns and node restarts. */
export async function executionWorkspace(
  config: NodeConfig,
  sessionId: string,
) {
  if (!config.workspaceDirIsDefault) return config.workspaceDir;
  if (
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
      sessionId,
    )
  )
    throw new Error("Invalid chat session ID");
  const directory = join(await realpath(config.workspaceDir), sessionId);
  await assertWorkspacePath(config.workspaceDir, directory, config.stateDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertWorkspacePath(config.workspaceDir, directory, config.stateDir);
  const canonical = await realpath(directory);
  if (canonical !== directory)
    throw new Error("Chat session directory must not be a symbolic link");
  return canonical;
}
