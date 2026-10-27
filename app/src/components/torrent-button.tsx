import { useNavigate } from '@tanstack/react-router';

import { Button } from '@/components/button';
import type { JackettTorrent } from '@/server/clients/jackett/types';

interface TorrentButtonProps {
  torrent: JackettTorrent;
  movieId?: number;
}

export const TorrentButton = ({ torrent, movieId }: TorrentButtonProps) => {
  const navigate = useNavigate();

  const handleClick = () => {
    const searchParams = {
      magnetUrl: torrent.magnetUrl,
      link: torrent.link,
      url: torrent.enclosure?.url,
      movieId,
    };

    // Navigate to watch page with magnet URL (preferred) or torrent file URL (fallback)
    if (torrent.magnetUrl || torrent.enclosure?.url) {
      navigate({
        to: '/watch',
        search: searchParams,
      });
    } else {
      console.error('No torrent URL or magnet URL available');
    }
  };

  return (
    <Button onClick={handleClick} size="sm" variant="default">
      Watch
    </Button>
  );
};
