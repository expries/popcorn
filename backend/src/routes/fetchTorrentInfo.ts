import { z } from 'zod';

import { torrentClient } from '../clients/torrent/torrentClient';
import { t } from '../trpc';

export const fetchTorrentInfo = t.procedure
  .input(
    z.object({
      torrent: z.object({
        url: z.string(),
      }),
    }),
  )
  .query(async (req) => {
    const { url } = req.input.torrent;

    console.log('Selected torrent:', {
      url: req.input.torrent.url,
    });

    try {
      const torrentInfo = await torrentClient.fetchTorrentInfo(url);
      return {
        success: true,
        data: {
          magnetURI: torrentInfo.magnetURI,
        },
      };
    } catch (error) {
      console.error('Failed to fetch torrent info:', error);
      throw new Error(`Failed to fetch torrent info: ${error}`);
    }
  });
