import { serve } from 'bun';

import index from './index.html';

const server = serve({
  routes: {
    // Serve index.html for all unmatched routes.
    '/*': index,
  },

  // Disable HMR for WebOS TV compatibility
  development: true,

  // Add CORS headers to expose detailed error messages
  async fetch(request, server) {
    const response = await server.fetch(request);
    response.headers.set('Access-Control-Allow-Origin', '*');
    return response;
  },
});

console.log(`Frontend running at ${server.url}`);
