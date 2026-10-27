import { eq } from 'drizzle-orm';

import { db, favourites, type Favourite, type NewFavourite } from '../db';
import { createLogger } from '../utils/logger';

const log = createLogger('Favourites');

export interface FavouriteMovie {
  id: number;
  title: string;
  posterUrl: string | null;
  releaseYear: number | null;
  rating: number;
  overview: string;
  addedAt: string;
}

function toFavouriteMovie(row: Favourite): FavouriteMovie {
  return {
    id: row.movieId,
    title: row.title,
    posterUrl: row.posterUrl,
    releaseYear: row.releaseYear,
    rating: Number(row.rating),
    overview: row.overview,
    addedAt: row.addedAt.toISOString(),
  };
}

class FavouritesManager {
  async getAll(): Promise<FavouriteMovie[]> {
    const rows = await db.select().from(favourites).orderBy(favourites.addedAt);
    return rows.map(toFavouriteMovie);
  }

  async add(movie: Omit<FavouriteMovie, 'addedAt'>): Promise<FavouriteMovie> {
    const existing = await db
      .select()
      .from(favourites)
      .where(eq(favourites.movieId, movie.id))
      .limit(1);

    if (existing.length > 0) {
      return toFavouriteMovie(existing[0]);
    }

    const newFavourite: NewFavourite = {
      movieId: movie.id,
      title: movie.title,
      posterUrl: movie.posterUrl,
      releaseYear: movie.releaseYear,
      rating: String(movie.rating),
      overview: movie.overview,
    };

    const [inserted] = await db.insert(favourites).values(newFavourite).returning();

    log.info(`Added: ${movie.title} (${movie.id})`);
    return toFavouriteMovie(inserted);
  }

  async remove(movieId: number): Promise<boolean> {
    const result = await db
      .delete(favourites)
      .where(eq(favourites.movieId, movieId))
      .returning();

    if (result.length === 0) {
      return false;
    }

    log.info(`Removed: ${result[0].title} (${movieId})`);
    return true;
  }

  async isFavourite(movieId: number): Promise<boolean> {
    const result = await db
      .select({ id: favourites.id })
      .from(favourites)
      .where(eq(favourites.movieId, movieId))
      .limit(1);

    return result.length > 0;
  }
}

export const favouritesManager = new FavouritesManager();
