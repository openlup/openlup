import { QueryClient } from "@tanstack/react-query";

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        retry: 1,
      },
    },
  });
}

export const appQueryClient = createAppQueryClient();

export function clearAuthScopedQueryCache(): void {
  appQueryClient.clear();
}
