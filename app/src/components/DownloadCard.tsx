import { Button } from './button';
import { MultiProgressBar } from './MultiProgressBar';
import { cn } from '@/utils/styles';

interface TorrentStats {
  infoHash: string;
  name: string;
  fileName?: string;
  fileSize?: number;
  progress: number;
  downloadSpeed: number;
  numPeers: number;
  downloaded: number;
  totalSize?: number;
  transcodeProgress: number | null;
  transcodeStatus: 'none' | 'pending' | 'in_progress' | 'completed' | 'failed';
  needsTranscoding: boolean;
  transcodedSegments: number | null;
  totalSegments: number | null;
}

interface DownloadCardProps {
  torrent: TorrentStats;
  variant: 'active' | 'completed';
  onWatch: (infoHash: string) => void;
  onRemove: (infoHash: string) => void;
  isRemoving?: boolean;
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
};

const formatSpeed = (bytesPerSecond: number): string => {
  return `${formatBytes(bytesPerSecond)}/s`;
};

function getStatusText(torrent: TorrentStats, isActive: boolean, isReady: boolean): string {
  if (!isActive) {
    if (torrent.needsTranscoding && torrent.transcodeStatus !== 'completed') {
      return 'Needs transcoding';
    }
    return 'Ready to watch';
  }

  if (!isReady) {
    return 'Fetching metadata...';
  }

  // Active download
  if (torrent.progress < 1.0) {
    if (torrent.needsTranscoding && torrent.transcodeStatus === 'in_progress') {
      return 'Downloading & Transcoding';
    }
    return 'Downloading';
  }

  // Download complete, check transcode
  if (torrent.needsTranscoding) {
    switch (torrent.transcodeStatus) {
      case 'in_progress':
        return 'Transcoding';
      case 'pending':
        return 'Waiting to transcode';
      case 'completed':
        return 'Ready';
      case 'failed':
        return 'Transcode failed';
      default:
        return 'Processing';
    }
  }

  return 'Ready';
}

function getStatusColor(torrent: TorrentStats, isActive: boolean, isReady: boolean): string {
  if (!isReady) {
    return 'text-yellow-500';
  }

  if (!isActive) {
    if (torrent.needsTranscoding && torrent.transcodeStatus !== 'completed') {
      return 'text-yellow-500';
    }
    return 'text-emerald-500';
  }

  if (torrent.transcodeStatus === 'failed') {
    return 'text-red-500';
  }

  if (torrent.transcodeStatus === 'in_progress') {
    return 'text-emerald-500';
  }

  return 'text-blue-500';
}

export function DownloadCard({ torrent, variant, onWatch, onRemove, isRemoving }: DownloadCardProps) {
  const isActive = variant === 'active';
  // Consider torrent "ready" when metadata is available (totalSize > 0)
  const isReady = (torrent.totalSize ?? 0) > 0;

  const statusText = getStatusText(torrent, isActive, isReady);
  const statusColor = getStatusColor(torrent, isActive, isReady);

  return (
    <div className="p-4 rounded-xl bg-card border border-input hover:border-muted-foreground/30 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {isActive ? (
              <div className="relative flex-shrink-0">
                <div className="w-2 h-2 bg-blue-500 rounded-full" />
                <div className="absolute inset-0 w-2 h-2 bg-blue-500 rounded-full animate-ping" />
              </div>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-muted-foreground flex-shrink-0"
              >
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            )}
            <p className="font-medium truncate" title={torrent.name}>
              {torrent.name}
            </p>
          </div>
          {torrent.fileName && torrent.fileName !== torrent.name && (
            <p className="text-sm text-muted-foreground truncate ml-4" title={torrent.fileName}>
              {torrent.fileName}
            </p>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            size="sm"
            variant="default"
            onClick={() => onWatch(torrent.infoHash)}
            disabled={isActive && torrent.progress < 0.01}
            className="cursor-pointer"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mr-1"
            >
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            Watch
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onRemove(torrent.infoHash)}
            disabled={isRemoving}
            className={cn(
              'cursor-pointer text-muted-foreground hover:text-destructive hover:bg-destructive/10',
              isRemoving && 'opacity-50',
            )}
          >
            {isRemoving ? (
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            ) : (
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
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </svg>
            )}
          </Button>
        </div>
      </div>

      {isActive && (
        <div className="mt-3 space-y-2">
          <MultiProgressBar
            downloadProgress={torrent.progress}
            transcodeProgress={torrent.transcodeProgress}
            needsTranscoding={torrent.needsTranscoding}
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <div className="flex items-center gap-4">
              {/* Download progress */}
              <span className="font-medium">
                {(torrent.progress * 100).toFixed(1)}%
                {torrent.needsTranscoding && torrent.transcodeProgress !== null && (
                  <span className="text-emerald-500 ml-1">
                    ({(torrent.transcodeProgress * 100).toFixed(0)}% transcoded)
                  </span>
                )}
              </span>
              <span className="flex items-center gap-1">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
                  <path d="m6 9 6 6 6-6"/>
                </svg>
                {formatSpeed(torrent.downloadSpeed)}
              </span>
              <span>{torrent.numPeers} peers</span>
            </div>
            <span className={statusColor}>
              {statusText}
            </span>
          </div>
        </div>
      )}

      {!isActive && (
        <div className="mt-2 flex items-center gap-3 text-sm text-muted-foreground ml-4">
          {torrent.fileSize && (
            <span className="flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                <path d="M14 2v4a2 2 0 0 0 2 2h4" />
              </svg>
              {formatBytes(torrent.fileSize)}
            </span>
          )}
          {torrent.needsTranscoding && (
            <span className={cn(
              'flex items-center gap-1',
              torrent.transcodeStatus === 'completed' ? 'text-emerald-500' : 'text-yellow-500',
            )}>
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.934a.5.5 0 0 0-.777-.416L16 11"/>
                <rect x="2" y="6" width="14" height="12" rx="2"/>
              </svg>
              {torrent.transcodeStatus === 'completed' ? 'Transcoded' : 'Needs transcoding'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
