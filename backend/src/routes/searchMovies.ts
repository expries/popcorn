import z from 'zod';

import { tmdbClient } from '../clients/tmdb/tmdbClient';
import { t } from '../trpc';

export const searchMovies = t.procedure
  .input(
    z.object({
      query: z.string().min(1),
      page: z.number().min(1).default(1),
    }),
  )
  .query(async (req) => {
    console.log('searching movies for:', req.input.query, 'page:', req.input.page);
    const result = await tmdbClient.searchMovies(req.input.query, req.input.page);
    console.log(`Found ${result.movies.length} movies (${result.totalResults} total)`);
    return result;
  });

export const getMovie = t.procedure
  .input(
    z.object({
      movieId: z.number(),
    }),
  )
  .query(async (req) => {
    console.log('getting movie details for:', req.input.movieId);
    const movie = await tmdbClient.getMovie(req.input.movieId);
    return movie;
  });

export const getPopularMovies = t.procedure
  .input(
    z.object({
      page: z.number().min(1).default(1),
    }).optional(),
  )
  .query(async (req) => {
    const page = req.input?.page ?? 1;
    console.log('getting popular movies, page:', page);
    const result = await tmdbClient.getPopularMovies(page);
    console.log(`Found ${result.movies.length} popular movies`);
    return result;
  });
