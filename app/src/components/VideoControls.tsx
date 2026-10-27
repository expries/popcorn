import { useState } from 'react';
import type { DownloadedRange } from '../hooks/useTorrentStats';
import {
  ExitFullscreenIcon,
  FullscreenIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  VolumeHighIcon,
  VolumeLowIcon,
  VolumeMutedIcon,
} from './icons/PlayerIcons';

interface VideoControlsProps {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
  isMuted: boolean;
  isFullscreen: boolean;
  downloadedRanges?: DownloadedRange[] | null;
  availableFraction?: number; // Single "available to play" indicator (0-1)
  isBuffering?: boolean;
  isHlsMode?: boolean; // Whether we're in HLS/transcoding mode
  onSeekBarClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  onTogglePlayPause: () => void;
  onSkipBack: () => void;
  onSkipForward: () => void;
  onToggleMute: () => void;
  onVolumeChange: (volume: number) => void;
  onToggleFullscreen: () => void;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function VolumeIcon({ isMuted, volume }: { isMuted: boolean; volume: number }) {
  if (isMuted || volume === 0) return <VolumeMutedIcon />;
  if (volume < 0.5) return <VolumeLowIcon />;
  return <VolumeHighIcon />;
}

export function VideoControls({
  currentTime,
  duration,
  isPlaying,
  volume,
  isMuted,
  isFullscreen,
  downloadedRanges,
  availableFraction,
  isBuffering,
  isHlsMode,
  onSeekBarClick,
  onTogglePlayPause,
  onSkipBack,
  onSkipForward,
  onToggleMute,
  onVolumeChange,
  onToggleFullscreen,
}: VideoControlsProps) {
  const [hoverPosition, setHoverPosition] = useState<{ x: number; time: number } | null>(null);
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  // Use availableFraction if provided, otherwise fall back to downloadedRanges
  const useSimpleProgress = availableFraction !== undefined;

  const handleSeekBarMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = fraction * duration;
    setHoverPosition({ x: e.clientX - rect.left, time });
  };

  const handleSeekBarMouseLeave = () => {
    setHoverPosition(null);
  };

  return (
    <div
      className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent space-y-2"
    >
      {/* Seek bar */}
      <div
        className="h-2 bg-muted/50 rounded-full cursor-pointer relative group"
        onClick={onSeekBarClick}
        onMouseMove={handleSeekBarMouseMove}
        onMouseLeave={handleSeekBarMouseLeave}
      >
        {/* Hover timestamp tooltip */}
        {hoverPosition && duration > 0 && (
          <div
            className="absolute bottom-full mb-2 -translate-x-1/2 px-2 py-1 bg-black/90 text-white text-xs rounded pointer-events-none whitespace-nowrap"
            style={{ left: hoverPosition.x }}
          >
            {formatDuration(hoverPosition.time)}
          </div>
        )}

        {/* Single "available to play" indicator when using HLS transcoding */}
        {useSimpleProgress && (
          <div
            className="absolute h-full bg-muted-foreground/40 rounded-full"
            style={{ width: `${availableFraction * 100}%` }}
          />
        )}

        {/* Downloaded ranges visualization (fallback for native streaming) */}
        {!useSimpleProgress && downloadedRanges &&
          downloadedRanges.map((range, i) => (
            <div
              key={i}
              className="absolute h-full bg-muted-foreground/40 rounded-full"
              style={{
                left: `${range.start * 100}%`,
                width: `${(range.end - range.start) * 100}%`,
              }}
            />
          ))}

        {/* Current progress */}
        <div
          className="absolute h-full bg-primary rounded-full transition-all z-10"
          style={{ width: `${progress}%` }}
        />
        <div className="absolute inset-0 bg-primary/20 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>

      {/* Controls row */}
      <div className="flex items-center justify-between text-sm">
        {/* Left controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={onTogglePlayPause}
            className="p-2 hover:bg-white/10 rounded transition-colors relative cursor-pointer"
            title={isBuffering ? 'Buffering...' : isPlaying ? 'Pause' : 'Play'}
          >
            {isBuffering ? (
              <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            ) : isPlaying ? (
              <PauseIcon />
            ) : (
              <PlayIcon />
            )}
          </button>

          <button
            onClick={onSkipBack}
            className="p-2 hover:bg-white/10 rounded transition-colors cursor-pointer"
            title="Skip back 10 seconds"
          >
            <SkipBackIcon />
          </button>

          <button
            onClick={onSkipForward}
            className="p-2 hover:bg-white/10 rounded transition-colors cursor-pointer"
            title="Skip forward 10 seconds"
          >
            <SkipForwardIcon />
          </button>

          {/* Volume */}
          <div className="flex items-center gap-1 ml-2">
            <button
              onClick={onToggleMute}
              className="p-2 hover:bg-white/10 rounded transition-colors cursor-pointer"
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              <VolumeIcon isMuted={isMuted} volume={volume} />
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={isMuted ? 0 : volume}
              onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
              className="w-20 h-1 accent-primary cursor-pointer"
              title="Volume"
            />
          </div>

          {/* Time display */}
          <span className="font-mono ml-3 text-white">
            {formatDuration(currentTime)} / {formatDuration(duration)}
          </span>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-1">
          {isHlsMode && <span className="text-xs text-yellow-500 mr-2">HLS</span>}
          <button
            onClick={onToggleFullscreen}
            className="p-2 hover:bg-white/10 rounded transition-colors cursor-pointer"
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </button>
        </div>
      </div>
    </div>
  );
}
