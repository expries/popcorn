import { useRef, useState, useCallback } from 'react';

import { useHlsPlayer } from '../hooks/useHlsPlayer';
import { useTranscodeAwareSeek } from '../hooks/useTranscodeAwareSeek';
import { useVideoControls } from '../hooks/useVideoControls';
import { useVideoDuration } from '../hooks/useVideoDuration';
import type { TorrentStats } from '../hooks/useTorrentStats';
import { TranscodeWaitOverlay } from './TranscodeWaitOverlay';
import { VideoControls } from './VideoControls';
import { cn } from '../utils/styles';
import { createLogger } from '../utils/logger';
import { HLS_SEGMENT_DURATION, STREAM_SERVER_URL } from '../config';

const log = createLogger('VideoPlayer');

interface VideoPlayerProps {
  stats: TorrentStats;
  status: string;
}

/**
 * Calculate the "available to play" fraction based on streaming mode.
 * For HLS mode: based on transcode progress
 * For native mode: based on download progress
 */
function getAvailableFraction(stats: TorrentStats): number {
  // Check both requiresHls (from static data) and streamingMode (from SSE)
  // to handle the case where SSE hasn't connected yet
  const isHlsMode = stats.requiresHls || stats.streamingMode === 'hls';

  if (isHlsMode) {
    if (stats.waitingForDownload) return 0;
    // Use transcodeProgress if available, otherwise calculate from canSeekTo/duration
    if (stats.transcodeProgress !== undefined) {
      return stats.transcodeProgress;
    }
    if (stats.canSeekTo !== undefined && stats.duration) {
      return stats.canSeekTo / stats.duration;
    }
    return 0;
  }
  // Native mode - use download progress
  return stats.progress;
}

const getMimeType = (fileName: string): string => {
  const ext = fileName.toLowerCase().split('.').pop();
  const mimeTypes: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    ogv: 'video/ogg',
  };
  return mimeTypes[ext ?? ''] ?? 'video/mp4';
};

export function VideoPlayer({ stats, status }: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [hasStarted, setHasStarted] = useState(false);

  const requiresHls = stats.requiresHls ?? false;
  const isWaitingForDownload = stats.waitingForDownload ?? false;
  const streamUrl = requiresHls ? null : `${STREAM_SERVER_URL}/stream/${stats.infoHash}`;
  const mimeType = stats.fileName ? getMimeType(stats.fileName) : 'video/mp4';
  const canStream = stats.progress > 0.01;

  const { hlsRef, isLoading: isHlsLoading, hlsDuration, seekTo: hlsSeekTo } = useHlsPlayer({
    hlsUrl: requiresHls && !isWaitingForDownload ? stats.hlsUrl : undefined,
    videoElement,
  });

  // Centralized duration management with stability tracking
  const { duration } = useVideoDuration({
    videoElement,
    hlsDuration,
    backendDuration: stats.duration,
    isHlsMode: requiresHls,
  });

  // Callback ref to capture the video element
  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    setVideoElement(node);
  }, []);

  const controls = useVideoControls({ videoElement, containerRef, duration });

  // Calculate available fraction for progress bar
  const availableFraction = getAvailableFraction(stats);

  // Determine if we need buffer-aware seeking (HLS transcoding or native incomplete download)
  const isIncompleteNative = !requiresHls && stats.progress < 1.0;
  const needsBufferAwareSeek = (requiresHls && !isWaitingForDownload) || isIncompleteNative;

  // Calculate canSeekTo based on mode
  // For HLS: use transcode progress (stats.canSeekTo) but LIMITED by what HLS.js actually knows
  // The playlist may not have been refreshed yet, so we can't seek beyond hlsDuration
  // For native incomplete: use canSeekTo from SSE, with fallback to progress-based calculation
  // IMPORTANT: For HLS, fallback to 0 (not duration) if canSeekTo is unknown - this is safer
  // than allowing seeks to arbitrary positions when we don't know the transcoded range
  // NOTE: useTranscodeAwareSeek applies a 2-second safety buffer when deciding to seek
  const nativeFallbackCanSeekTo = duration * stats.progress;
  // For native streaming, trust canSeekTo only if it's a reasonable value (> 0 when there's progress)
  // If backend returns 0 but we have progress, use the fallback calculation
  const nativeCanSeekTo = (stats.canSeekTo && stats.canSeekTo > 0)
    ? stats.canSeekTo
    : nativeFallbackCanSeekTo;
  const calculatedCanSeekTo = requiresHls
    ? Math.min(stats.canSeekTo ?? 0, hlsDuration > 0 ? hlsDuration : Infinity)
    : isIncompleteNative
      ? nativeCanSeekTo
      : duration;

  // Helper to play after seek completes (avoids AbortError race condition)
  const playAfterSeek = useCallback(() => {
    if (!videoElement) return;

    let handled = false;
    const onSeeked = () => {
      if (handled) return;
      handled = true;
      if (videoElement.paused) {
        videoElement.play().catch((e) => {
          if (e.name !== 'AbortError') {
            log.error('Failed to play after seek:', e);
          }
        });
      }
    };
    // Use { once: true } so listener auto-removes after firing
    videoElement.addEventListener('seeked', onSeeked, { once: true });
    // Fallback timeout in case seeked event doesn't fire
    setTimeout(() => {
      if (!handled) {
        handled = true;
        if (videoElement.paused) {
          videoElement.play().catch(() => {});
        }
      }
    }, 1000);
  }, [videoElement]);

  // Callback when seek is blocked (beyond available range)
  const handleSeekBlocked = useCallback(() => {
    videoElement?.pause();
  }, [videoElement]);

  // Callback when seek is allowed (within available range or transcode caught up)
  const handleSeekAllowed = useCallback((targetTime: number) => {
    log.info('onSeekAllowed', {
      targetTime: targetTime.toFixed(1),
      expectedSegment: Math.floor(targetTime / HLS_SEGMENT_DURATION),
      videoDuration: videoElement?.duration?.toFixed(1),
      hlsDuration: hlsDuration.toFixed(1),
      calculatedCanSeekTo: calculatedCanSeekTo.toFixed(1),
    });

    // Clear any previous error when seeking to valid content
    if (videoError) {
      setVideoError(null);
    }

    if (!videoElement) return;

    const videoDuration = videoElement.duration;

    // Safety check: don't seek beyond what HLS.js knows about
    if (hlsRef.current && isFinite(videoDuration) && videoDuration > 0 && targetTime > videoDuration) {
      const safeTarget = Math.max(0, videoDuration - 2);
      log.warn('Seek target beyond playlist duration, seeking to safe position', {
        targetTime,
        videoDuration,
        safeTarget,
      });
      hlsSeekTo(safeTarget);
      playAfterSeek();
      return;
    }

    // Normal seek - use hlsSeekTo for HLS to avoid race condition
    if (requiresHls) {
      hlsSeekTo(targetTime);
    } else {
      videoElement.currentTime = targetTime;
    }
    log.debug('Set currentTime to', videoElement.currentTime);
    playAfterSeek();
  }, [videoElement, videoError, hlsRef, hlsSeekTo, hlsDuration, calculatedCanSeekTo, requiresHls, playAfterSeek]);

  // Buffer-aware seeking for both HLS and native modes
  const {
    requestSeek,
    cancelPendingSeek,
    seekToAvailable,
    isWaitingForTranscode: isWaitingForBuffer,
    pendingSeekTarget,
    transcodeProgress: bufferProgress,
  } = useTranscodeAwareSeek({
    canSeekTo: calculatedCanSeekTo,
    totalDuration: duration,
    onSeekBlocked: handleSeekBlocked,
    onSeekAllowed: handleSeekAllowed,
  });

  const handleVideoError = useCallback(() => {
    if (!videoElement?.error) return;
    const { code, message } = videoElement.error;

    // For native mode with incomplete downloads, decode errors (code 3) are expected
    // when seeking past downloaded content - show a more helpful message
    if (code === 3 && !requiresHls && stats.progress < 1.0) {
      setVideoError('Seeking past downloaded content - try seeking earlier in the video');
      return;
    }

    const errorMessages: Record<number, string> = {
      1: 'Video loading aborted',
      2: 'Network error while loading video',
      3: 'Video decoding failed - codec may not be supported',
      4: 'Video format not supported',
    };
    setVideoError(errorMessages[code] || message || `Unknown error (code ${code})`);
  }, [videoElement, requiresHls, stats.progress]);

  const handleSeekBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    const targetTime = fraction * duration;

    log.info('Seek requested', {
      fraction: fraction.toFixed(3),
      duration: duration.toFixed(1),
      targetTime: targetTime.toFixed(1),
      expectedSegment: Math.floor(targetTime / HLS_SEGMENT_DURATION),
      canSeekTo: stats.canSeekTo?.toFixed(1),
      hlsDuration: hlsDuration.toFixed(1),
      calculatedCanSeekTo: calculatedCanSeekTo.toFixed(1),
    });

    if (needsBufferAwareSeek) {
      // Use buffer-aware seeking for both HLS and native incomplete modes
      requestSeek(targetTime);
    } else {
      // Fully downloaded - seek directly
      controls.seekByFraction(fraction);
    }
  };

  // Buffer-aware skip handlers for both HLS and native modes
  const handleSkipBack = useCallback(() => {
    const targetTime = Math.max(0, controls.currentTime - 10);
    if (needsBufferAwareSeek) {
      requestSeek(targetTime);
    } else {
      controls.skipTime(-10);
    }
  }, [needsBufferAwareSeek, controls, requestSeek]);

  const handleSkipForward = useCallback(() => {
    const targetTime = Math.min(duration, controls.currentTime + 10);
    if (needsBufferAwareSeek) {
      requestSeek(targetTime);
    } else {
      controls.skipTime(10);
    }
  }, [needsBufferAwareSeek, duration, controls, requestSeek]);

  const handleStartPlayback = useCallback(() => {
    if (videoElement) {
      videoElement.play().catch((e) => {
        // Ignore AbortError - happens during rapid interactions
        if (e.name !== 'AbortError') {
          log.error('Failed to start playback:', e);
        }
      });
      setHasStarted(true);
    }
  }, [videoElement]);

  const [isDetailsOpen, setIsDetailsOpen] = useState(false);

  const formatSpeed = (bytes: number) => {
    const mbps = bytes / 1024 / 1024;
    return `${mbps.toFixed(2)} MB/s`;
  };

  const formatSize = (bytes?: number) => {
    if (!bytes) return 'N/A';
    const gb = bytes / 1024 / 1024 / 1024;
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    const mb = bytes / 1024 / 1024;
    return `${mb.toFixed(0)} MB`;
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Video Player */}
      {/* Show waiting message if HLS mode but waiting for download */}
      {requiresHls && isWaitingForDownload ? (
        <div className="aspect-video bg-muted flex items-center justify-center rounded-xl">
          <div className="text-center p-6">
            <svg
              className="w-12 h-12 mx-auto mb-4 text-muted-foreground animate-pulse"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <p className="text-lg font-medium">Waiting for download to complete</p>
            <p className="text-sm text-muted-foreground mt-2">
              This video requires transcoding and will be available after download completes.
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              Download progress: {(stats.progress * 100).toFixed(1)}%
            </p>
            <div className="w-64 h-2 bg-muted-foreground/20 rounded-full mt-4 mx-auto overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${stats.progress * 100}%` }}
              />
            </div>
          </div>
        </div>
      ) : canStream ? (
        <div
          ref={containerRef}
          className={cn(
            'relative rounded-xl overflow-hidden aspect-video bg-black',
            controls.isFullscreen && 'aspect-auto',
          )}
        >
          <video
            ref={setVideoRef}
            key={requiresHls ? 'hls' : streamUrl}
            width="100%"
            height="100%"
            autoPlay={false}
            playsInline
            className={cn('bg-black w-full h-full object-contain', controls.isFullscreen ? 'h-screen' : 'rounded-xl')}
            style={controls.isFullscreen ? undefined : { maxHeight: '70vh' }}
            onClick={hasStarted ? controls.togglePlayPause : undefined}
            onError={handleVideoError}
          >
            {!requiresHls && streamUrl && <source src={streamUrl} type={mimeType} />}
            Your browser does not support HTML5 video.
          </video>

          {/* Video error overlay */}
          {videoError && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80">
              <div className="text-center text-white p-4">
                <p className="text-red-400 font-bold mb-2">Playback Error</p>
                <p className="text-sm">{videoError}</p>
                <p className="text-xs text-gray-400 mt-2">File: {stats.fileName}</p>
                {!requiresHls && stats.progress < 1.0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setVideoError(null);
                      // Seek to beginning of video to recover
                      if (videoElement) {
                        videoElement.currentTime = 0;
                        videoElement.play().catch((e) => {
                          if (e.name !== 'AbortError') {
                            log.error('Failed to restart playback:', e);
                          }
                        });
                      }
                    }}
                    className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors cursor-pointer"
                  >
                    Restart from beginning
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Big play button overlay - shown before user starts playback */}
          {!hasStarted && (requiresHls ? !isHlsLoading : canStream) && (
            <button
              type="button"
              onClick={handleStartPlayback}
              className="absolute inset-0 flex items-center justify-center bg-black/40 hover:bg-black/50 transition-colors cursor-pointer group"
            >
              <div className="w-20 h-20 rounded-full bg-white/90 group-hover:bg-white flex items-center justify-center transition-colors shadow-lg">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="40"
                  height="40"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="text-black ml-1"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </button>
          )}

          {/* Loading/Buffering overlay */}
          {((isHlsLoading && requiresHls) || (controls.isBuffering && hasStarted)) && !isWaitingForBuffer && (
            <div
              className="absolute inset-0 flex items-center justify-center bg-black/30 cursor-pointer"
              onClick={hasStarted ? controls.togglePlayPause : undefined}
            >
              <div className="flex flex-col items-center gap-2 text-white pointer-events-none">
                <svg className="w-12 h-12 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <span className="text-sm">{isHlsLoading ? 'Loading stream...' : 'Buffering...'}</span>
              </div>
            </div>
          )}

          {/* Buffer wait overlay - shown when seeking beyond buffered/downloaded range */}
          <TranscodeWaitOverlay
            isVisible={isWaitingForBuffer}
            pendingSeekTarget={pendingSeekTarget}
            canSeekTo={calculatedCanSeekTo}
            transcodeProgress={bufferProgress}
            totalDuration={duration}
            onSeekBack={seekToAvailable}
            onCancel={cancelPendingSeek}
            mode={requiresHls ? 'transcode' : 'download'}
          />

          {hasStarted && (
            <VideoControls
              currentTime={controls.currentTime}
              duration={duration}
              isPlaying={controls.isPlaying}
              isBuffering={controls.isBuffering}
              volume={controls.volume}
              isMuted={controls.isMuted}
              isFullscreen={controls.isFullscreen}
              downloadedRanges={stats.downloadedRanges}
              availableFraction={requiresHls ? availableFraction : stats.progress < 1.0 ? stats.progress : undefined}
              isHlsMode={requiresHls}
              onSeekBarClick={handleSeekBarClick}
              onTogglePlayPause={controls.togglePlayPause}
              onSkipBack={handleSkipBack}
              onSkipForward={handleSkipForward}
              onToggleMute={controls.toggleMute}
              onVolumeChange={controls.changeVolume}
              onToggleFullscreen={controls.toggleFullscreen}
            />
          )}
        </div>
      ) : (
        <div className="aspect-video bg-black rounded-xl flex items-center justify-center">
          <p className="text-white">Buffering... {(stats.progress * 100).toFixed(1)}%</p>
        </div>
      )}

      {/* Stream Info Panel */}
      <div className="bg-card rounded-xl border border-input overflow-hidden">
        {/* Quick Stats Bar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-input bg-muted/30">
          <div className="flex items-center gap-6 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Progress</span>
              <span className="font-medium">{(stats.progress * 100).toFixed(1)}%</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Peers</span>
              <span className="font-medium">{stats.numPeers}</span>
            </div>
            <div className="flex items-center gap-2">
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
                className="text-green-500"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
              <span className="font-medium text-green-500">{formatSpeed(stats.downloadSpeed)}</span>
            </div>
            <div className="flex items-center gap-2">
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
                className="text-blue-500"
              >
                <path d="m18 15-6-6-6 6" />
              </svg>
              <span className="font-medium text-blue-500">{formatSpeed(stats.uploadSpeed)}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsDetailsOpen(!isDetailsOpen)}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <span>{isDetailsOpen ? 'Hide' : 'Show'} Details</span>
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
              className={cn('transition-transform', isDetailsOpen && 'rotate-180')}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>

        {/* Expandable Details */}
        {isDetailsOpen && (
          <div className="p-4 space-y-4">
            {/* Torrent Info */}
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Torrent</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-muted/30 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-1">File Name</p>
                  <p className="text-sm font-medium truncate" title={stats.fileName}>
                    {stats.fileName || stats.name}
                  </p>
                </div>
                <div className="bg-muted/30 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-1">File Size</p>
                  <p className="text-sm font-medium">{formatSize(stats.fileSize)}</p>
                </div>
                <div className="bg-muted/30 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-1">Status</p>
                  <p className="text-sm font-medium">{status}</p>
                </div>
                <div className="bg-muted/30 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-1">Stream Mode</p>
                  <p className="text-sm font-medium">
                    {requiresHls
                      ? isWaitingForDownload
                        ? 'Waiting for download'
                        : stats.isTranscoding
                          ? 'HLS (Transcoding...)'
                          : 'HLS (Ready)'
                      : 'Native'}
                  </p>
                </div>
              </div>
            </div>

            {/* Codec Info */}
            {stats.codecInfo && (
              <div>
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                  Codec Information
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-muted/30 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground mb-1">Video Codec</p>
                    <p className="text-sm font-medium">
                      {stats.codecInfo.videoCodec}
                      {stats.codecInfo.videoProfile && ` (${stats.codecInfo.videoProfile})`}
                    </p>
                  </div>
                  <div className="bg-muted/30 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground mb-1">Audio Codec</p>
                    <p className="text-sm font-medium">{stats.codecInfo.audioCodec || 'N/A'}</p>
                  </div>
                  <div className="bg-muted/30 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground mb-1">Resolution</p>
                    <p className="text-sm font-medium">
                      {stats.codecInfo.width}x{stats.codecInfo.height}
                    </p>
                  </div>
                  <div className="bg-muted/30 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground mb-1">Pixel Format</p>
                    <p className="text-sm font-medium">{stats.codecInfo.pixelFormat || 'Unknown'}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Debug Info */}
            {videoError && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                <p className="text-sm text-red-400">Error: {videoError}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
