import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { test } from "vitest";
import type { Project, ProjectTree as Listing } from "@agent/contracts";
import { ProjectTree } from "../src/components/project-tree";

const project: Project = {
  id: "a".repeat(64),
  name: "chat_sessions",
  source: "chat_sessions",
  directory: "/home/test/.curilo/workspace/chat_sessions",
};
function render(pages?: Listing[], root = project) {
  const client = new QueryClient();
  if (pages)
    client.setQueryData(
      ["project-tree", "connection", "node", project.id, "."],
      {
        pages,
        pageParams: pages.map((_, i) => i * 200),
      },
    );
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          "ul",
          { role: "tree" },
          createElement(ProjectTree, {
            project: root,
            nodeId: "node",
            connection: {
              id: "connection",
              baseUrl: "http://localhost",
              token: "test",
            },
            online: false,
          }),
        ),
      ),
    );
  } finally {
    client.clear();
  }
}

test("automatic chat project expands to cached directories and file leaves, escaping names", () => {
  const html = render([
    {
      entries: [
        { name: "session-id", path: "session-id", kind: "directory" },
        { name: "<notes>.txt", path: "<notes>.txt", kind: "file" },
        { name: "external", path: "external", kind: "symlink" },
      ],
      nextOffset: 200,
    },
  ]);
  assert.match(html, /chat_sessions/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /session-id/);
  assert.match(html, /&lt;notes&gt;\.txt/);
  assert.match(html, /external \(symbolic link\)/);
  assert.match(html, /Load more/);
  // Only the project and real subdirectory are expandable.
  assert.equal((html.match(/aria-expanded=/g) ?? []).length, 2);
});

test("project tree distinguishes an empty directory, offline loading, and collapsed added roots", () => {
  assert.match(render([{ entries: [], nextOffset: null }]), /Empty directory/);
  assert.match(render(), /Node offline/);
  const collapsed = render(undefined, {
    ...project,
    source: "added",
    name: "my-project",
  });
  assert.match(collapsed, /aria-expanded="false"/);
  assert.doesNotMatch(collapsed, /Node offline|Empty directory/);
});
