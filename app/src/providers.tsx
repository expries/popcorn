import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { PropsWithChildren } from 'react';
import { useState } from 'react';
import { RouterProvider } from '@tanstack/react-router';

import type { AppRouter } from '@backend/routes/trpc';
import { router } from './router';
import { TRPCProvider } from './utils/trpc';
import { FavouritesProvider } from './hooks/useFavourites';
import { ThemeProvider } from './hooks/useTheme';
import { TRPC_URL } from './config';

let browserQueryClient: QueryClient | undefined;

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
      },
    },
  });
}

function getQueryClient() {
  if (typeof window === 'undefined') {
    return createQueryClient();
  }
  if (!browserQueryClient) {
    browserQueryClient = createQueryClient();
  }
  return browserQueryClient;
}

export function AppProviders({ children }: PropsWithChildren) {
  const queryClient = getQueryClient();
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: TRPC_URL })],
    }),
  );

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          <FavouritesProvider>
            {children}
          </FavouritesProvider>
          <ReactQueryDevtools initialIsOpen={true} />
        </TRPCProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export function App() {
  return (
    <AppProviders>
      <RouterProvider router={router} />
      <TanStackRouterDevtools router={router} />
    </AppProviders>
  );
}
