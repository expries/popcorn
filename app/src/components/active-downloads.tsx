import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import { useTRPC } from '@/utils/trpc';
import { Card, CardContent, CardHeader, CardTitle } from './card';
import { DownloadCard } from './DownloadCard';

export function ActiveDownloads() {
  const navigate = useNavigate();
  const trpc = useTRPC();

  const { data, isLoading } = useQuery({
    ...trpc.getAllDownloads.queryOptions(),
    refetchInterval: (query) => {
      const activeCount = query.state.data?.data?.active?.length ?? 0;
      return activeCount > 0 ? 1000 : 5000;
    },
  });

  const stopMutation = useMutation(trpc.removeTorrent.mutationOptions());

  const activeDownloads = data?.data?.active ?? [];
  const completedDownloads = data?.data?.completed ?? [];
  const totalCount = activeDownloads.length + completedDownloads.length;

  const handleWatch = (infoHash: string) => {
    navigate({ to: '/watch', search: { infoHash } });
  };

  const handleRemove = (infoHash: string) => {
    stopMutation.mutate({ infoHash });
  };

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          My Downloads
          {totalCount > 0 && (
            <span className="text-sm font-normal text-muted-foreground">
              ({activeDownloads.length} active, {completedDownloads.length} completed)
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <p className="text-sm text-muted-foreground text-center py-4">Loading...</p>
        )}

        {!isLoading && totalCount === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No downloads yet. Search for a movie and click Watch to start downloading.
          </p>
        )}

        {activeDownloads.map((torrent) => (
          <DownloadCard
            key={torrent.infoHash}
            torrent={torrent}
            variant="active"
            onWatch={handleWatch}
            onRemove={handleRemove}
          />
        ))}

        {completedDownloads.map((torrent) => (
          <DownloadCard
            key={torrent.infoHash}
            torrent={torrent}
            variant="completed"
            onWatch={handleWatch}
            onRemove={handleRemove}
          />
        ))}
      </CardContent>
    </Card>
  );
}
