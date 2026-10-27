import z from 'zod';

import { jackettClient } from '../clients/jackett/jackettClient';
import { t } from '../trpc';

const PAGE_SIZE = 30;

export const queryTorrents = t.procedure
  .input(
    z
      .object({
        movie: z
          .object({
            title: z.string(),
            releaseYear: z.number().nullable(),
          })
          .required(),
        page: z.number().min(0).default(0),
      })
      .required(),
  )
  .query(async (req) => {
    console.log('querying torrents for movie:', req.input.movie, 'page:', req.input.page);
    const movie = req.input.movie;
    const page = req.input.page;
    const query = movie.releaseYear ? `${movie.title} ${movie.releaseYear}` : movie.title;
    const torrents = await jackettClient.query(query, PAGE_SIZE, page * PAGE_SIZE);

    // Filter out non-video torrents (audio, books, etc.)
    // Torznab category codes: 2000-2999 = Movies, 5000-5999 = TV
    const videoTorrents = torrents.filter((torrent) => {
      const categories = torrent.categories || [];

      // Check if any category is in the video range (2000-2999 for movies, 5000-5999 for TV)
      const hasVideoCategory = categories.some((cat) => {
        const catNum = Number.parseInt(cat, 10);
        return (catNum >= 2000 && catNum < 3000) || (catNum >= 5000 && catNum < 6000);
      });

      return hasVideoCategory;
    });

    // Sort by seeders (descending)
    const sortedTorrents = videoTorrents.sort((a, b) => {
      const seedersA = Number.parseInt(a.attributes.seeders || '0', 10);
      const seedersB = Number.parseInt(b.attributes.seeders || '0', 10);
      return seedersB - seedersA;
    });

    console.log(`Filtered to ${sortedTorrents.length} video torrents (from ${torrents.length} total)`);

    return {
      torrents: sortedTorrents,
      hasMore: torrents.length === PAGE_SIZE,
      page,
    };
  });
