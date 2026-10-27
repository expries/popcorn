import axios from 'axios';

import { parseSearchResponseXml } from './xmlParser';

const baseUrl = process.env.JACKETT_BASE_URL ?? 'http://localhost:9117';
const apiKey = process.env.JACKETT_API_KEY;
const indexer = process.env.JACKETT_INDEXER ?? '1337x';

if (!apiKey) {
  console.warn('JACKETT_API_KEY not set in environment variables');
}

export const jackettClient = {
  query: async (query: string, limit = 30, offset = 0) => {
    const request = await axios.get(`${baseUrl}/api/v2.0/indexers/${indexer}/results/torznab/api`, {
      params: {
        apikey: apiKey,
        t: 'movie',
        q: query,
        limit,
        offset,
      },
    });

    const searchResultsXml = request.data;
    const torrents = parseSearchResponseXml(searchResultsXml);
    console.log(`Found ${torrents.length} torrents (offset: ${offset})`);
    return torrents;
  },
};
