import { useSearch } from '@tanstack/react-router';

import { TorrentSearch } from '@/components/torrent-search';
import { TorrentButton } from '@/components/torrent-button';
import { ActiveDownloads } from '@/components/active-downloads';

export function SearchPage() {
  const search = useSearch({ from: '/search' });
  const q = search.q;

  if (!q || q.trim().length === 0) {
    return (
      <div className="mt-8 mx-auto w-full max-w-2xl text-center flex flex-col gap-4">
        <ActiveDownloads />
        <p className="text-muted-foreground">No search query provided. Use the search bar to find torrents.</p>
      </div>
    );
  }

  return (
    <div className="mt-8 mx-auto w-full text-left flex flex-col gap-4">
      <ActiveDownloads />
      <TorrentSearch title={q} renderTorrent={(torrent) => <TorrentButton torrent={torrent} />} />
    </div>
  );
}
