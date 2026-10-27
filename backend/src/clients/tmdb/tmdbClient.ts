import axios from 'axios';

import { RateLimiter } from '../../utils/rateLimiter';

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

// Rate limit: TMDB allows 50 requests/second, configurable via env
const TMDB_RATE_LIMIT = parseInt(process.env.TMDB_RATE_LIMIT ?? '50', 10);
const rateLimiter = new RateLimiter(TMDB_RATE_LIMIT);

console.log(`[TMDB] Rate limiter initialized: ${TMDB_RATE_LIMIT} requests/second`);

export interface TMDBMovie {
  id: number;
  title: string;
  original_title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string;
  vote_average: number;
  vote_count: number;
  popularity: number;
  genre_ids: number[];
}

export interface TMDBSearchResult {
  page: number;
  results: TMDBMovie[];
  total_pages: number;
  total_results: number;
}

export interface MovieSearchResult {
  id: number;
  title: string;
  originalTitle: string;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  releaseDate: string;
  releaseYear: number | null;
  rating: number;
  voteCount: number;
}

function getApiKey(): string {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    throw new Error('TMDB_API_KEY environment variable is not set');
  }
  return apiKey;
}

function getPosterUrl(posterPath: string | null, size: 'w185' | 'w342' | 'w500' | 'original' = 'w342'): string | null {
  if (!posterPath) return null;
  return `${TMDB_IMAGE_BASE_URL}/${size}${posterPath}`;
}

function getBackdropUrl(
  backdropPath: string | null,
  size: 'w300' | 'w780' | 'w1280' | 'original' = 'w780',
): string | null {
  if (!backdropPath) return null;
  return `${TMDB_IMAGE_BASE_URL}/${size}${backdropPath}`;
}

function extractYear(releaseDate: string): number | null {
  if (!releaseDate) return null;
  const year = Number.parseInt(releaseDate.split('-')[0], 10);
  return Number.isNaN(year) ? null : year;
}

function transformMovie(movie: TMDBMovie): MovieSearchResult {
  return {
    id: movie.id,
    title: movie.title,
    originalTitle: movie.original_title,
    overview: movie.overview,
    posterUrl: getPosterUrl(movie.poster_path),
    backdropUrl: getBackdropUrl(movie.backdrop_path),
    releaseDate: movie.release_date,
    releaseYear: extractYear(movie.release_date),
    rating: movie.vote_average,
    voteCount: movie.vote_count,
  };
}

export const tmdbClient = {
  async searchMovies(
    query: string,
    page = 1,
  ): Promise<{ movies: MovieSearchResult[]; totalPages: number; totalResults: number }> {
    const apiKey = getApiKey();

    // Wait for rate limit token before making request
    await rateLimiter.acquire();

    const response = await axios.get<TMDBSearchResult>(`${TMDB_BASE_URL}/search/movie`, {
      params: {
        query,
        page,
        include_adult: false,
        language: 'en-US',
      },
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    const movies = response.data.results.map(transformMovie);

    return {
      movies,
      totalPages: response.data.total_pages,
      totalResults: response.data.total_results,
    };
  },

  async getMovie(movieId: number): Promise<MovieSearchResult | null> {
    const apiKey = getApiKey();

    // Wait for rate limit token before making request
    await rateLimiter.acquire();

    try {
      const response = await axios.get<TMDBMovie>(`${TMDB_BASE_URL}/movie/${movieId}`, {
        params: {
          language: 'en-US',
        },
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      return transformMovie(response.data);
    } catch {
      return null;
    }
  },

  async getPopularMovies(page = 1): Promise<{ movies: MovieSearchResult[]; totalPages: number; totalResults: number }> {
    const apiKey = getApiKey();

    // Wait for rate limit token before making request
    await rateLimiter.acquire();

    const response = await axios.get<TMDBSearchResult>(`${TMDB_BASE_URL}/movie/popular`, {
      params: {
        page,
        language: 'en-US',
      },
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    const movies = response.data.results.map(transformMovie);

    return {
      movies,
      totalPages: response.data.total_pages,
      totalResults: response.data.total_results,
    };
  },

  /**
   * Get current rate limiter state for monitoring
   */
  getRateLimitState(): { tokens: number; queueLength: number; maxRate: number } {
    return {
      ...rateLimiter.getState(),
      maxRate: TMDB_RATE_LIMIT,
    };
  },
};
