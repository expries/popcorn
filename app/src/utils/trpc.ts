import { createTRPCContext } from '@trpc/tanstack-react-query';

import type { AppRouter } from '@backend/routes/trpc';

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();
