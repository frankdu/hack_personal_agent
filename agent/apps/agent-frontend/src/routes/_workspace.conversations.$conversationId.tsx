import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/_workspace/conversations/$conversationId",
)({
  component: () => null,
});
