interface TorrentStatsGridProps {
  progress: number;
  numPeers: number;
  downloadSpeed: number;
  uploadSpeed: number;
  fileSize?: number;
  status: string;
}

export function TorrentStatsGrid({
  progress,
  numPeers,
  downloadSpeed,
  uploadSpeed,
  fileSize,
  status,
}: TorrentStatsGridProps) {
  return (
    <div className="mt-4 text-sm text-muted-foreground grid grid-cols-2 gap-2">
      <p>Progress: {(progress * 100).toFixed(1)}%</p>
      <p>Peers: {numPeers}</p>
      <p>Download: {(downloadSpeed / 1024 / 1024).toFixed(2)} MB/s</p>
      <p>Upload: {(uploadSpeed / 1024 / 1024).toFixed(2)} MB/s</p>
      {fileSize && <p>Size: {(fileSize / 1024 / 1024 / 1024).toFixed(2)} GB</p>}
      <p>Status: {status}</p>
    </div>
  );
}
