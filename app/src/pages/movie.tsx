import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/button';
import { TorrentSearch } from '@/components/torrent-search';
import { TorrentButton } from '@/components/torrent-button';
import { useTRPC } from '@/utils/trpc';
import { cn } from '@/utils/styles';
import { useFavourites } from '@/hooks/useFavourites';

export function MoviePage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/movie' });
  const trpc = useTRPC();
  const { isFavourite, toggleFavourite } = useFavourites();

  const movieId = search.id;
  const movieYear = search.year;

  const { data: movie, isLoading: isLoadingMovie } = useQuery({
    ...trpc.getMovie.queryOptions({ movieId: movieId! }),
    enabled: !!movieId,
  });

  const handleBack = () => {
    // Use browser history if available, otherwise fall back to home
    if (window.history.length > 1) {
      window.history.back();
    } else {
      navigate({ to: '/' });
    }
  };

  const torrentSearchTitle = movie ? (movie.releaseYear ? `${movie.title} ${movie.releaseYear}` : movie.title) : null;

  return (
    <div className="w-full max-w-7xl mx-auto px-4 py-6">
      <Button variant="ghost" size="sm" onClick={handleBack} className="mb-4 cursor-pointer">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m12 19-7-7 7-7" />
          <path d="M19 12H5" />
        </svg>
        Back
      </Button>

      {isLoadingMovie && movieId ? (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          <p className="mt-4 text-muted-foreground">Loading movie details...</p>
        </div>
      ) : movie ? (
        <div className="space-y-6">
          <div className="flex gap-6">
            {movie.posterUrl && (
              <div className="flex-shrink-0">
                <img src={movie.posterUrl} alt={movie.title} className="w-48 rounded-lg shadow-lg" />
              </div>
            )}
            <div className="flex-1">
              <div className="flex items-start gap-3 mb-2">
                <h1 className="text-3xl font-bold">
                  {movie.title}
                  {movie.releaseYear && (
                    <span className="text-muted-foreground font-normal ml-2">({movie.releaseYear})</span>
                  )}
                </h1>
                <button
                  type="button"
                  onClick={() => toggleFavourite(movie)}
                  className={cn(
                    'p-2 rounded-full transition-all duration-200 flex-shrink-0 cursor-pointer',
                    isFavourite(movie.id)
                      ? 'bg-red-500 text-white'
                      : 'bg-muted text-muted-foreground hover:bg-red-500 hover:text-white',
                  )}
                  aria-label={isFavourite(movie.id) ? 'Remove from favourites' : 'Add to favourites'}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill={isFavourite(movie.id) ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
                  </svg>
                </button>
              </div>

              {movie.rating !== undefined && movie.rating > 0 && (
                <div className="flex items-center gap-2 mb-4">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    className="text-yellow-400"
                  >
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                  <span className="font-medium">{movie.rating.toFixed(1)}</span>
                  <span className="text-muted-foreground text-sm">/ 10</span>
                </div>
              )}

              {movie.overview && <p className="text-muted-foreground leading-relaxed">{movie.overview}</p>}
            </div>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-4">Available Torrents</h2>
            {torrentSearchTitle && (
              <TorrentSearch
                title={torrentSearchTitle}
                movieId={movie.id}
                renderTorrent={(torrent, movieId) => <TorrentButton torrent={torrent} movieId={movieId} />}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="text-center py-12">
          <p className="text-muted-foreground">Movie not found. Try searching for another movie.</p>
        </div>
      )}
    </div>
  );
}
