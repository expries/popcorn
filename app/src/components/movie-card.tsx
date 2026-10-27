import { Link } from '@tanstack/react-router';

import { cn } from '@/utils/styles';
import { useFavourites, type FavouriteMovie } from '@/hooks/useFavourites';

interface Movie {
  id: number;
  title: string;
  posterUrl: string | null;
  releaseYear: number | null;
  rating: number;
  overview: string;
}

interface MovieCardProps {
  movie: Movie;
  className?: string;
}

export function MovieCard({ movie, className }: MovieCardProps) {
  const { isFavourite, toggleFavourite } = useFavourites();
  const favourited = isFavourite(movie.id);

  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-lg overflow-hidden bg-card border border-border',
        'transition-all duration-200',
        'hover:scale-[1.02] hover:shadow-xl hover:border-primary/50',
        className,
      )}
    >
      {/* Link for navigation */}
      <Link
        to="/movie"
        search={{
          id: movie.id,
          year: movie.releaseYear ?? undefined,
        }}
        className="absolute inset-0 z-10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-lg"
        aria-label={`View ${movie.title}`}
      />

      {/* Favourite button */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleFavourite(movie as FavouriteMovie);
        }}
        className={cn(
          'absolute top-2 left-2 p-2 rounded-full transition-all duration-200 z-[100] cursor-pointer',
          favourited
            ? 'bg-red-500 text-white'
            : 'bg-black/70 text-white hover:bg-red-500',
        )}
        aria-label={favourited ? 'Remove from favourites' : 'Add to favourites'}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill={favourited ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
        </svg>
      </button>

      <div className="relative aspect-[2/3] bg-muted overflow-hidden pointer-events-none">
        {movie.posterUrl ? (
          <img
            src={movie.posterUrl}
            alt={movie.title}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="m9 8 6 4-6 4Z" />
            </svg>
          </div>
        )}

        {movie.rating > 0 && (
          <div className="absolute top-2 right-2 px-2 py-1 rounded-md bg-black/70 text-white text-xs font-medium flex items-center gap-1">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="text-yellow-400"
            >
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            {movie.rating.toFixed(1)}
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200" />

        <div className="absolute bottom-0 left-0 right-0 p-3 translate-y-full group-hover:translate-y-0 transition-transform duration-200">
          <p className="text-white text-xs line-clamp-3">{movie.overview || 'No description available.'}</p>
        </div>
      </div>

      <div className="p-3 flex flex-col gap-1 pointer-events-none">
        <h3 className="font-medium text-sm leading-tight line-clamp-2 text-foreground group-hover:text-primary transition-colors">
          {movie.title}
        </h3>
        {movie.releaseYear && (
          <span className="text-xs text-muted-foreground">{movie.releaseYear}</span>
        )}
      </div>
    </div>
  );
}

interface MovieGridProps {
  movies: Movie[];
  className?: string;
}

export function MovieGrid({ movies, className }: MovieGridProps) {
  if (movies.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">No movies found. Try a different search.</p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'grid gap-4',
        'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6',
        className,
      )}
    >
      {movies.map((movie) => (
        <MovieCard key={movie.id} movie={movie} />
      ))}
    </div>
  );
}
