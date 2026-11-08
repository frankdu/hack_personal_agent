import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { test } from "vitest";
import { ConversationList } from "../src/components/conversation-list.tsx";

const id = "00000000-0000-4000-8000-000000000001";
const props = {
  conversations: [],
  selectedId: null,
  loading: false,
  error: null,
  disabled: false,
  onRetry: () => {},
};

async function render(
  overrides: Partial<Parameters<typeof ConversationList>[0]>,
) {
  const rootRoute = createRootRoute({
    component: () =>
      createElement(ConversationList, { ...props, ...overrides }),
  });
  const conversationRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/conversations/$conversationId",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([conversationRoute]),
    history: createMemoryHistory({ initialEntries: [`/conversations/${id}`] }),
  });
  await router.load();
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

test("conversation list distinguishes loading, empty and failed responses", async () => {
  assert.match(await render({}), /No conversations yet/);
  const loading = await render({ loading: true });
  assert.match(loading, /Loading conversations/);
  assert.doesNotMatch(loading, /No conversations yet/);
  const failed = await render({ error: "Connection interrupted" });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Connection interrupted/);
  assert.match(failed, /Retry/);
  assert.doesNotMatch(failed, /No conversations yet/);
});

test("persisted conversations show safe titles, selection and active tasks while refresh fails", async () => {
  const html = await render({
    selectedId: id,
    disabled: true,
    error: "Refresh failed",
    conversations: [
      {
        id,
        title: "Explore <script>code</script>",
        updatedAt: "2026-11-08T12:00:00.000Z",
        activeTaskId: id,
      },
    ],
  });
  assert.match(html, /Explore &lt;script&gt;code&lt;\/script&gt;/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /aria-disabled="true"/);
  assert.doesNotMatch(html, /href=/);
  assert.match(html, /Task in progress/);
  assert.match(html, /2026-11-08/);
  assert.match(html, /Refresh failed/);
});

test("existing conversations expose their permalink as a browser link", async () => {
  const html = await render({
    selectedId: id,
    conversations: [
      {
        id,
        title: "Saved conversation",
        updatedAt: "2026-11-08T12:00:00.000Z",
        activeTaskId: null,
      },
    ],
  });
  assert.match(html, new RegExp(`<a[^>]*href="/conversations/${id}"`));
  assert.match(html, /aria-current="page"/);
  assert.match(html, /Saved conversation/);
});
