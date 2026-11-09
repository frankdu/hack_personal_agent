import { createHash } from "node:crypto";
import { opendir, realpath, stat, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  projectsResponseSchema,
  type Project,
  type ProjectTree,
} from "@agent/contracts";
import type { NodeConfig } from "./config.js";
import { RequestError } from "./executions.js";
import { durableWrite, readJson, Serial } from "./storage.js";

export function within(root: string, path: string) {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

export class Projects {
  private roots: Project[] = [];
  private serial = new Serial();
  constructor(private readonly config: NodeConfig) {}
  private get file() {
    return join(this.config.stateDir, "projects.json");
  }
  async initialize() {
    const stored = await readJson(this.file);
    this.roots = stored
      ? projectsResponseSchema
          .parse(stored)
          .projects.filter((project) => project.source === "added")
      : [];
    const directory = this.config.workspaceDir;
    const id = createHash("sha256").update(directory).digest("hex");
    this.roots = this.roots.filter((project) => project.id !== id);
    this.roots.unshift({
      id,
      directory,
      name: basename(directory) || directory,
      source: this.config.workspaceDirIsDefault
        ? "chat_sessions"
        : "configured",
    });
  }
  list() {
    return { projects: this.roots };
  }
  async add(input: string) {
    return this.serial.run(async () => {
      try {
        const expanded =
          input === "~"
            ? homedir()
            : input.startsWith("~/")
              ? join(homedir(), input.slice(2))
              : input;
        // Relative paths always refer to the node's process cwd.
        const directory = await realpath(resolve(expanded));
        if (!(await stat(directory)).isDirectory())
          throw new RequestError(
            400,
            "project_not_directory",
            "Choose a directory on this node.",
          );
        if (
          within(directory, this.config.stateDir) ||
          within(this.config.stateDir, directory)
        )
          throw new RequestError(
            403,
            "private_state",
            "Projects must be separate from private node state.",
          );
        const existing = this.roots.find((p) => p.directory === directory);
        if (existing) return existing;
        if (this.roots.length >= 256)
          throw new RequestError(
            409,
            "project_limit",
            "This node already has 256 projects.",
          );
        const project: Project = {
          id: createHash("sha256").update(directory).digest("hex"),
          directory,
          name: basename(directory) || directory,
          source: "added",
        };
        const next = [...this.roots, project];
        await durableWrite(this.file, { projects: next });
        this.roots = next;
        return project;
      } catch (error) {
        if (error instanceof RequestError) throw error;
        throw new RequestError(
          400,
          "project_unavailable",
          "This project directory does not exist or cannot be accessed on the node.",
        );
      }
    });
  }
  async tree(id: string, path: string, offset: number): Promise<ProjectTree> {
    const project = this.roots.find((p) => p.id === id);
    if (!project)
      throw new RequestError(404, "project_not_found", "Project not found.");
    const requested = resolve(project.directory, path);
    if (
      isAbsolute(path) ||
      path.includes("\0") ||
      !within(project.directory, requested)
    )
      throw new RequestError(
        403,
        "path_outside_project",
        "Path is outside this project.",
      );
    try {
      const root = await realpath(project.directory);
      if (root !== project.directory)
        throw new RequestError(
          403,
          "project_changed",
          "Project directory changed; add it again.",
        );
      const parts = relative(root, requested).split(sep).filter(Boolean);
      let current = root;
      for (const part of parts) {
        current = join(current, part);
        if ((await lstat(current)).isSymbolicLink())
          throw new RequestError(
            403,
            "symlink_not_browsable",
            "Symbolic links cannot be expanded.",
          );
      }
      const canonical = await realpath(requested);
      if (!within(root, canonical) || within(this.config.stateDir, canonical))
        throw new RequestError(
          403,
          "path_outside_project",
          "Path is outside the browsable project.",
        );
      const entries: ProjectTree["entries"] = [];
      let index = 0;
      const directory = await opendir(canonical);
      for await (const entry of directory) {
        const position = index++;
        if (position < offset) continue;
        if (entries.length === 200)
          return { entries: sortEntries(entries), nextOffset: position };
        const child = join(canonical, entry.name);
        if (within(this.config.stateDir, child)) continue;
        entries.push({
          name: entry.name,
          path: relative(root, child).split(sep).join("/"),
          kind: entry.isSymbolicLink()
            ? "symlink"
            : entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                : "other",
        });
      }
      return { entries: sortEntries(entries), nextOffset: null };
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(
        400,
        "directory_unavailable",
        "Directory no longer exists or cannot be read.",
      );
    }
  }
}
function sortEntries(entries: ProjectTree["entries"]) {
  return entries.sort(
    (a, b) =>
      Number(b.kind === "directory") - Number(a.kind === "directory") ||
      a.name.localeCompare(b.name),
  );
}
