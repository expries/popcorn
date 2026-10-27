import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef, useCallback } from 'react';

import type { JackettTorrent } from '@/server/clients/jackett/types';

import { useTRPCClient } from '../utils/trpc';

const formatSize = (bytes?: number): string => {
  if (!bytes) return 'N/A';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(2)} MB`;
};

const getSeeders = (torrent: JackettTorrent): number => {
  return Number.parseInt(torrent.attributes.seeders || '0', 10);
};

const getLeechers = (torrent: JackettTorrent): number => {
  return Number.parseInt(torrent.attributes.peers || '0', 10);
};

const getRatio = (seeders: number, leechers: number): string => {
  if (leechers === 0) return seeders > 0 ? '∞' : 'N/A';
  return (seeders / leechers).toFixed(2);
};

interface TorrentSearchProps {
  title: string;
  movieId?: number;
  renderTorrent: (torrent: JackettTorrent, movieId?: number) => React.JSX.Element;
}

export const TorrentSearch = (props: TorrentSearchProps) => {
  const trpcClient = useTRPCClient();
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const queryTorrents = useInfiniteQuery({
    queryKey: ['queryTorrents', props.title],
    queryFn: async ({ pageParam = 0 }) => {
      const result = await trpcClient.queryTorrents.query({
        movie: {
          title: props.title,
          releaseYear: 0,
        },
        page: pageParam,
      });
      return result;
    },
    getNextPageParam: (lastPage) => {
      if (lastPage.hasMore) {
        return lastPage.page + 1;
      }
      return undefined;
    },
    initialPageParam: 0,
  });

  const handleObserver = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const [target] = entries;
      if (target.isIntersecting && queryTorrents.hasNextPage && !queryTorrents.isFetchingNextPage) {
        queryTorrents.fetchNextPage();
      }
    },
    [queryTorrents],
  );

  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(handleObserver, {
      root: null,
      rootMargin: '100px',
      threshold: 0,
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [handleObserver]);

  if (queryTorrents.isPending) {
    return <p className="text-muted-foreground">Searching for torrents...</p>;
  }

  if (queryTorrents.isError) {
    return <p className="text-destructive">Error: {queryTorrents.error.message}</p>;
  }

  const allTorrents = queryTorrents.data?.pages.flatMap((page) => page.torrents) ?? [];

  if (allTorrents.length === 0) {
    return <p className="text-muted-foreground">No torrents found</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left p-3 font-semibold">Title</th>
            <th className="text-right p-3 font-semibold">Size</th>
            <th className="text-right p-3 font-semibold">Seeders</th>
            <th className="text-right p-3 font-semibold">Leechers</th>
            <th className="text-right p-3 font-semibold">Ratio</th>
            <th className="text-center p-3 font-semibold">Action</th>
          </tr>
        </thead>
        <tbody>
          {allTorrents.map((torrent, idx) => {
            const seeders = getSeeders(torrent);
            const leechers = getLeechers(torrent);
            const ratio = getRatio(seeders, leechers);

            return (
              <tr key={idx} className="border-b border-border hover:bg-muted/50 transition-colors">
                <td className="p-3">
                  <div className="flex flex-col">
                    <span className="font-medium">{torrent.title}</span>
                    {torrent.indexer && <span className="text-xs text-muted-foreground">{torrent.indexer}</span>}
                  </div>
                </td>
                <td className="p-3 text-right text-sm">{formatSize(torrent.size)}</td>
                <td className="p-3 text-right">
                  <span className={seeders > 0 ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}>
                    {seeders}
                  </span>
                </td>
                <td className="p-3 text-right">
                  <span className="text-muted-foreground">{leechers}</span>
                </td>
                <td className="p-3 text-right font-mono text-sm">{ratio}</td>
                <td className="p-3 text-center">{props.renderTorrent(torrent, props.movieId)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Infinite scroll trigger */}
      <div ref={loadMoreRef} className="py-4 text-center">
        {queryTorrents.isFetchingNextPage && (
          <p className="text-muted-foreground">Loading more results...</p>
        )}
        {!queryTorrents.hasNextPage && allTorrents.length > 0 && (
          <p className="text-muted-foreground text-sm">No more results</p>
        )}
      </div>
    </div>
  );
};
