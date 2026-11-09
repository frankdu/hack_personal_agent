import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import terminalStylesheet from "@xterm/xterm/css/xterm.css?url";
import stylesheet from "../styles.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    head: () => ({
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title: "Curilo Agent · Workspace" },
        {
          name: "description",
          content: "One workspace for Curilo Agent and connected machines.",
        },
      ],
      links: [
        { rel: "stylesheet", href: stylesheet },
        { rel: "stylesheet", href: terminalStylesheet },
      ],
    }),
    component: () => (
      <html lang="en">
        <head>
          <HeadContent />
        </head>
        <body>
          <Outlet />
          <Scripts />
        </body>
      </html>
    ),
  },
);
