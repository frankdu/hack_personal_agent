import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { ConversationList } from "../src/components/conversation-list.tsx";

const id = "00000000-0000-4000-8000-000000000001";
const props = {
  conversations: [],
  selectedId: null,
  loading: false,
  error: null,
  disabled: false,
  onSelect: () => {},
  onRetry: () => {},
};

test("conversation list distinguishes loading, empty and failed responses", () => {
  const render = (overrides: Partial<Parameters<typeof ConversationList>[0]>) =>
    renderToStaticMarkup(
      createElement(ConversationList, { ...props, ...overrides }),
    );
  assert.match(render({}), /No conversations yet/);
  const loading = render({ loading: true });
  assert.match(loading, /Loading conversations/);
  assert.doesNotMatch(loading, /No conversations yet/);
  const failed = render({ error: "Connection interrupted" });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Connection interrupted/);
  assert.match(failed, /Retry/);
  assert.doesNotMatch(failed, /No conversations yet/);
});

test("persisted conversations show safe titles, selection and active tasks while refresh fails", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationList, {
      ...props,
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
    }),
  );
  assert.match(html, /Explore &lt;script&gt;code&lt;\/script&gt;/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /Task in progress/);
  assert.match(html, /2026-11-08/);
  assert.match(html, /Refresh failed/);
});
