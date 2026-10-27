import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useTRPC } from '../utils/trpc';

interface UseStartTorrentResult {
  infoHash: string | null;
  error: string | null;
  status: string;
  start: (link: string) => void;
  isLoading: boolean;
}

export function useStartTorrent(): UseStartTorrentResult {
  const [infoHash, setInfoHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Initializing...');
  const [isFetching, setIsFetching] = useState(false);

  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const addTorrentMutation = useMutation(trpc.addTorrent.mutationOptions());

  const start = async (link: string) => {
    setError(null);
    setIsFetching(true);
    setStatus('Fetching torrent info...');

    try {
      const response = await queryClient.fetchQuery(
        trpc.fetchTorrentInfo.queryOptions({ torrent: { url: link } }),
      );

      if (!response.success || !response.data) {
        setError('Failed to get magnet URI from torrent');
        setIsFetching(false);
        return;
      }

      const magnetURI = response.data.magnetURI;
      setStatus('Starting torrent download on server...');
      setIsFetching(false);

      addTorrentMutation.mutate(
        { magnetUri: magnetURI },
        {
          onSuccess: (addResponse) => {
            if (!addResponse.success || !('data' in addResponse)) {
              setError('error' in addResponse ? addResponse.error : 'Failed to start torrent');
              return;
            }

            setInfoHash(addResponse.data.infoHash);
            setStatus('Downloading from BitTorrent network...');
          },
          onError: (err) => {
            setError(err.message || 'Failed to start torrent on server');
          },
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch torrent info');
      setIsFetching(false);
    }
  };

  return {
    infoHash,
    error,
    status,
    start,
    isLoading: isFetching || addTorrentMutation.isPending,
  };
}
