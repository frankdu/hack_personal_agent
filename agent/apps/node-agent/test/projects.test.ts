import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { readConfig } from "../src/config.js";
import { Projects } from "../src/projects.js";
import { executionWorkspace } from "../src/workspace.js";

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "agent-projects-"));
  const root = await realpath(temporary);
  const config = readConfig({ NODE_STATE_DIR: join(root, "state") });
  config.workspaceDir = join(root, "chat_sessions");
  await mkdir(config.stateDir);
  await mkdir(config.workspaceDir);
  const projects = new Projects(config);
  await projects.initialize();
  return {
    root,
    config,
    projects,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("default chat workspaces are stable per conversation, isolated, and browsable automatically", async () => {
  const f = await fixture();
  try {
    const session = randomUUID();
    const directory = await executionWorkspace(f.config, session);
    assert.equal(directory, join(f.config.workspaceDir, session));
    await writeFile(join(directory, "notes.txt"), "saved chat content");
    assert.equal(await executionWorkspace(f.config, session), directory);
    assert.equal(
      await readFile(join(directory, "notes.txt"), "utf8"),
      "saved chat content",
    );
    assert.notEqual(
      await executionWorkspace(f.config, randomUUID()),
      directory,
    );
    const [root] = f.projects.list().projects;
    assert.equal(root!.name, "chat_sessions");
    assert.equal(root!.source, "chat_sessions");
    const listing = await f.projects.tree(root!.id, session, 0);
    assert.deepEqual(listing.entries, [
      { name: "notes.txt", path: `${session}/notes.txt`, kind: "file" },
    ]);
    await assert.rejects(
      executionWorkspace(f.config, "../../escape"),
      /Invalid chat session ID/,
    );
    const other = join(f.root, "outside");
    await mkdir(other);
    const linkedId = randomUUID();
    await symlink(other, join(f.config.workspaceDir, linkedId));
    await assert.rejects(executionWorkspace(f.config, linkedId), /outside/);
    f.config.workspaceDirIsDefault = false;
    assert.equal(
      await executionWorkspace(f.config, session),
      f.config.workspaceDir,
    );
  } finally {
    await f.cleanup();
  }
});

test("project roots are canonical, deduplicated, persisted, and named after directories", async () => {
  const f = await fixture();
  try {
    const directory = join(f.root, "my-project");
    await mkdir(directory);
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "README.md"), "hello");
    const project = await f.projects.add(directory);
    assert.equal(project.name, "my-project");
    assert.deepEqual(await f.projects.add(`${directory}/.`), project);
    assert.equal(f.projects.list().projects.length, 2);
    const restarted = new Projects(f.config);
    await restarted.initialize();
    assert.deepEqual(restarted.list(), f.projects.list());
    const listing = await restarted.tree(project.id, ".", 0);
    assert.deepEqual(
      listing.entries.map((e) => [e.name, e.kind]),
      [
        ["src", "directory"],
        ["README.md", "file"],
      ],
    );
    await assert.rejects(
      f.projects.add(f.config.stateDir),
      /private node state/,
    );
    await assert.rejects(f.projects.add(f.root), /private node state/);
    await assert.rejects(
      f.projects.add(join(directory, "missing")),
      /does not exist/,
    );
  } finally {
    await f.cleanup();
  }
});

test("tree traversal and symlink expansion cannot browse outside an approved project", async () => {
  const f = await fixture();
  try {
    const root = f.projects.list().projects[0]!;
    await symlink(f.config.stateDir, join(root.directory, "private-link"));
    const listing = await f.projects.tree(root.id, ".", 0);
    assert.equal(listing.entries[0]!.kind, "symlink");
    for (const path of [
      "../state",
      f.config.stateDir,
      "private-link",
      "private-link/child",
    ])
      await assert.rejects(f.projects.tree(root.id, path, 0));
    await assert.rejects(
      f.projects.tree("a".repeat(64), ".", 0),
      /Project not found/,
    );
    await mkdir(join(root.directory, "nested"));
    await rm(join(root.directory, "nested"), { recursive: true });
    await assert.rejects(
      f.projects.tree(root.id, "nested", 0),
      /no longer exists/,
    );
  } finally {
    await f.cleanup();
  }
});

test("large directories paginate without dropping entries", async () => {
  const f = await fixture();
  try {
    const root = f.projects.list().projects[0]!;
    await Promise.all(
      Array.from({ length: 205 }, (_, i) =>
        writeFile(join(root.directory, `file-${i}.txt`), ""),
      ),
    );
    const first = await f.projects.tree(root.id, ".", 0);
    assert.equal(first.entries.length, 200);
    assert.notEqual(first.nextOffset, null);
    const last = await f.projects.tree(root.id, ".", first.nextOffset!);
    assert.equal(last.entries.length, 5);
    assert.equal(last.nextOffset, null);
    assert.equal(
      new Set([...first.entries, ...last.entries].map((e) => e.path)).size,
      205,
    );
  } finally {
    await f.cleanup();
  }
});
