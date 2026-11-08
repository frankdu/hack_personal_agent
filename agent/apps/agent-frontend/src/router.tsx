import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  // One cache per router/request, never a server-wide singleton.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 15_000, retry: 1 } },
  });
  return createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
