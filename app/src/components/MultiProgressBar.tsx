import { cn } from '@/utils/styles';

interface MultiProgressBarProps {
  downloadProgress: number;
  transcodeProgress: number | null;
  needsTranscoding: boolean;
  className?: string;
}

export function MultiProgressBar({
  downloadProgress,
  transcodeProgress,
  needsTranscoding,
  className = '',
}: MultiProgressBarProps) {
  const downloadPercentage = Math.min(downloadProgress * 100, 100);

  // If no transcoding needed, show simple download bar
  if (!needsTranscoding) {
    return (
      <div className={cn('w-full bg-muted rounded-full h-2', className)}>
        <div
          className="bg-primary h-2 rounded-full transition-all duration-300"
          style={{ width: `${downloadPercentage}%` }}
        />
      </div>
    );
  }

  // Calculate transcode percentage relative to total (not just downloaded portion)
  const transcodePercentage = transcodeProgress !== null
    ? Math.min(transcodeProgress * 100, 100)
    : 0;

  return (
    <div className={cn('w-full bg-muted rounded-full h-2 relative overflow-hidden', className)}>
      {/* Download progress (blue) - shows total downloaded */}
      <div
        className="absolute inset-y-0 left-0 bg-blue-500/40 transition-all duration-300"
        style={{ width: `${downloadPercentage}%` }}
      />
      {/* Transcode progress (green) - shows transcoded portion */}
      <div
        className="absolute inset-y-0 left-0 bg-emerald-500 transition-all duration-300 rounded-full"
        style={{ width: `${transcodePercentage}%` }}
      />
    </div>
  );
}
