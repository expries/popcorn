import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { VideoPlayer } from '../components/VideoPlayer';
import { Button } from '../components/button';
import { useStartTorrent } from '../hooks/useStartTorrent';
import { useTorrentStats } from '../hooks/useTorrentStats';
import { useTRPC } from '../utils/trpc';
import { cn } from '../utils/styles';
import { useFavourites } from '../hooks/useFavourites';

export function WatchPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/watch' });
  const { link, infoHash: existingInfoHash, movieId } = search;
  const trpc = useTRPC();
  const { isFavourite, toggleFavourite } = useFavourites();

  const startTorrent = useStartTorrent();
  const activeInfoHash = existingInfoHash ?? startTorrent.infoHash;

  const { data: stats } = useTorrentStats(activeInfoHash ?? null);

  const { data: movie } = useQuery({
    ...trpc.getMovie.queryOptions({ movieId: movieId! }),
    enabled: !!movieId,
  });

  // Start torrent from link if no existing infoHash
  useEffect(() => {
    if (link && !existingInfoHash) {
      startTorrent.start(link);
    }
  }, [link, existingInfoHash]);

  const status = stats?.progress && stats.progress > 0.01
    ? 'Streaming available'
    : startTorrent.status;

  const handleBack = () => {
    // Use browser history if available, otherwise fall back to movie page or home
    if (window.history.length > 1) {
      window.history.back();
    } else if (movieId) {
      navigate({ to: '/movie', search: { id: movieId } });
    } else {
      navigate({ to: '/' });
    }
  };

  const movieTitle = movie
    ? movie.releaseYear
      ? `${movie.title} (${movie.releaseYear})`
      : movie.title
    : null;

  if (!link && !existingInfoHash) {
    return (
      <div className="mt-8 mx-auto w-full max-w-5xl px-4 text-center flex flex-col gap-4">
        <p className="text-muted-foreground">No torrent URL provided</p>
      </div>
    );
  }

  if (startTorrent.error) {
    return (
      <div className="mt-8 mx-auto w-full max-w-5xl px-4 text-center flex flex-col gap-4">
        <p className="text-destructive">Error: {startTorrent.error}</p>
      </div>
    );
  }

  if (!activeInfoHash || !stats) {
    return (
      <div className="mt-8 mx-auto w-full max-w-5xl px-4 text-center flex flex-col gap-4">
        <p className="text-muted-foreground">{status}</p>
      </div>
    );
  }

  return (
    <div className="mt-4 mx-auto w-full max-w-5xl px-4 flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={handleBack} className="cursor-pointer">
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

        {movieTitle && (
          <div className="flex items-center gap-3 flex-1">
            <h1 className="text-xl font-bold">{movieTitle}</h1>
            {movie && (
              <button
                type="button"
                onClick={() => toggleFavourite(movie)}
                className={cn(
                  'p-2 rounded-full transition-all duration-200 cursor-pointer',
                  isFavourite(movie.id)
                    ? 'bg-red-500 text-white'
                    : 'bg-muted text-muted-foreground hover:bg-red-500 hover:text-white',
                )}
                aria-label={isFavourite(movie.id) ? 'Remove from favourites' : 'Add to favourites'}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="18"
                  height="18"
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
            )}
          </div>
        )}
      </div>

      <VideoPlayer stats={stats} status={status} />
    </div>
  );
}
