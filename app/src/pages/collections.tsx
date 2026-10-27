import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import { useTRPC } from '@/utils/trpc';
import { DownloadCard } from '@/components/DownloadCard';
import { cn } from '@/utils/styles';

type TabType = 'all' | 'active' | 'completed';

export function CollectionsPage() {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabType>('all');
  const [removingHash, setRemovingHash] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    ...trpc.getAllDownloads.queryOptions(),
    refetchInterval: (query) => {
      const activeCount = query.state.data?.data?.active?.length ?? 0;
      return activeCount > 0 ? 1000 : 5000;
    },
  });

  const removeMutation = useMutation({
    ...trpc.removeTorrent.mutationOptions(),
    onMutate: ({ infoHash }) => {
      setRemovingHash(infoHash);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['getAllDownloads'] });
    },
    onSettled: () => {
      setRemovingHash(null);
    },
  });

  const activeDownloads = data?.data?.active ?? [];
  const completedDownloads = data?.data?.completed ?? [];
  const allDownloads = [...activeDownloads, ...completedDownloads];

  const displayedDownloads = activeTab === 'all'
    ? allDownloads
    : activeTab === 'active'
      ? activeDownloads
      : completedDownloads;

  const handleWatch = (infoHash: string) => {
    navigate({ to: '/watch', search: { infoHash } });
  };

  const handleRemove = (infoHash: string) => {
    removeMutation.mutate({ infoHash, deleteData: true });
  };

  const tabs: { id: TabType; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: allDownloads.length },
    { id: 'active', label: 'Downloading', count: activeDownloads.length },
    { id: 'completed', label: 'Completed', count: completedDownloads.length },
  ];

  return (
    <div className="w-full max-w-5xl mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Collections</h1>
        <p className="text-muted-foreground">Manage your downloads</p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 bg-muted/50 rounded-xl mb-6 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'px-4 py-2 rounded-lg text-sm font-medium transition-all cursor-pointer',
              activeTab === tab.id
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            {tab.count > 0 && (
              <span className={cn(
                'ml-2 px-1.5 py-0.5 rounded-md text-xs',
                activeTab === tab.id
                  ? 'bg-muted'
                  : 'bg-muted/50',
              )}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          <p className="mt-4 text-muted-foreground">Loading downloads...</p>
        </div>
      ) : displayedDownloads.length === 0 ? (
        <div className="text-center py-16 bg-card rounded-xl border border-input">
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
            className="mx-auto text-muted-foreground/50 mb-4"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" x2="12" y1="15" y2="3" />
          </svg>
          <h3 className="font-semibold text-lg mb-2">
            {activeTab === 'all'
              ? 'No downloads yet'
              : activeTab === 'active'
                ? 'No active downloads'
                : 'No completed downloads'}
          </h3>
          <p className="text-muted-foreground">
            {activeTab === 'all'
              ? 'Browse movies and click Watch to start downloading.'
              : activeTab === 'active'
                ? 'Start a new download from the Browse page.'
                : 'Downloads will appear here once completed.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {displayedDownloads.map((torrent) => (
            <DownloadCard
              key={torrent.infoHash}
              torrent={torrent}
              variant={activeDownloads.some(d => d.infoHash === torrent.infoHash) ? 'active' : 'completed'}
              onWatch={handleWatch}
              onRemove={handleRemove}
              isRemoving={removingHash === torrent.infoHash}
            />
          ))}
        </div>
      )}
    </div>
  );
}
