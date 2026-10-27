import type { AddressInfo } from 'node:net';

import { createHTTPServer } from '@trpc/server/adapters/standalone';
import cors from 'cors';

import { appRouter } from './index';

const server = createHTTPServer({
  router: appRouter,
  middleware: cors(),
});

function formatAddress(address: string | AddressInfo | null): string | null {
  if (address instanceof Object) {
    return `${address.address}:${address.port}`;
  }
  return address;
}

export function createTRPCServer(port: number) {
  server.listen(port);
  const address = formatAddress(server.address());
  return { server, url: address };
}
