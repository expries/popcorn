interface TranscodeWaitOverlayProps {
  isVisible: boolean;
  pendingSeekTarget: number | null;
  canSeekTo: number;
  transcodeProgress: number;
  totalDuration: number;
  onSeekBack: () => void;
  onCancel: () => void;
  mode?: 'transcode' | 'download';
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function TranscodeWaitOverlay({
  isVisible,
  pendingSeekTarget,
  canSeekTo,
  transcodeProgress,
  totalDuration,
  onSeekBack,
  onCancel,
  mode = 'transcode',
}: TranscodeWaitOverlayProps) {
  if (!isVisible) return null;

  const isDownloadMode = mode === 'download';
  const waitingText = isDownloadMode ? 'Waiting for download...' : 'Waiting for transcode...';

  // Calculate positions as percentages for the visual progress bar
  const availablePercent = totalDuration > 0 ? (canSeekTo / totalDuration) * 100 : 0;
  const targetPercent = totalDuration > 0 && pendingSeekTarget ? (pendingSeekTarget / totalDuration) * 100 : 0;
  const safeSeekTime = Math.max(0, canSeekTo - 2);

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-20" onClick={onCancel}>
      <div
        className="flex flex-col items-center gap-5 text-white p-8 rounded-2xl bg-black/80 backdrop-blur-sm min-w-[320px]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Spinner and status */}
        <div className="flex items-center gap-3">
          <svg className="w-6 h-6 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <p className="text-base font-medium">{waitingText}</p>
        </div>

        {/* Seek target info */}
        <p className="text-lg font-semibold">
          Seeking to <span className="text-primary">{formatTime(pendingSeekTarget ?? 0)}</span>
        </p>

        {/* Visual mini-progress bar */}
        <div className="w-full space-y-2">
          <div className="relative h-3 bg-gray-700 rounded-full overflow-visible">
            {/* Available/transcoded range */}
            <div
              className="absolute h-full bg-gray-500 rounded-full transition-all duration-300"
              style={{ width: `${availablePercent}%` }}
            />

            {/* Available position marker */}
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-md transition-all duration-300"
              style={{ left: `${availablePercent}%`, transform: 'translate(-50%, -50%)' }}
            />

            {/* Target seek position marker */}
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-primary rounded-full shadow-md border-2 border-white"
              style={{ left: `${targetPercent}%`, transform: 'translate(-50%, -50%)' }}
            />
          </div>

          {/* Labels below the bar */}
          <div className="flex justify-between text-xs text-gray-400">
            <span>0:00</span>
            <span className="text-gray-300">
              Available: {formatTime(canSeekTo)} ({(transcodeProgress * 100).toFixed(0)}%)
            </span>
            <span>{formatTime(totalDuration)}</span>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-3 w-full mt-1">
          <button
            onClick={onSeekBack}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg text-sm font-medium transition-colors cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
            Watch from {formatTime(safeSeekTime)}
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-medium transition-colors cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
