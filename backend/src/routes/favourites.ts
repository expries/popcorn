import z from 'zod';

import { favouritesManager } from '../services/favouritesManager';
import { t } from '../trpc';

const movieSchema = z.object({
  id: z.number(),
  title: z.string(),
  posterUrl: z.string().nullable(),
  releaseYear: z.number().nullable(),
  rating: z.number(),
  overview: z.string(),
});

export const getFavourites = t.procedure.query(async () => {
  const favourites = await favouritesManager.getAll();
  return { favourites };
});

export const addFavourite = t.procedure
  .input(movieSchema)
  .mutation(async (req) => {
    const favourite = await favouritesManager.add(req.input);
    return { success: true, favourite };
  });

export const removeFavourite = t.procedure
  .input(z.object({ movieId: z.number() }))
  .mutation(async (req) => {
    const removed = await favouritesManager.remove(req.input.movieId);
    return { success: removed };
  });

export const isFavourite = t.procedure
  .input(z.object({ movieId: z.number() }))
  .query(async (req) => {
    const isFav = await favouritesManager.isFavourite(req.input.movieId);
    return { isFavourite: isFav };
  });
