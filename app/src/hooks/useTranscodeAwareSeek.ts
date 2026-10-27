import { useState, useCallback, useEffect, useRef } from 'react';

interface UseTranscodeAwareSeekOptions {
  canSeekTo: number; // Maximum seekable position in seconds
  totalDuration: number; // Total video duration in seconds
  onSeekBlocked: (targetTime: number) => void; // Called when seek is beyond transcoded range
  onSeekAllowed: (targetTime: number) => void; // Called when seek is allowed
}

interface UseTranscodeAwareSeekResult {
  requestSeek: (targetTime: number) => void;
  cancelPendingSeek: () => void;
  seekToAvailable: () => void;
  isWaitingForTranscode: boolean;
  pendingSeekTarget: number | null;
  transcodeProgress: number; // 0-1 fraction
}

// Safety buffer in seconds before canSeekTo edge to avoid race conditions
const SEEK_SAFETY_BUFFER_SECONDS = 2;

/**
 * Hook to handle transcode-aware seeking.
 * When user seeks beyond the transcoded range, this hook:
 * 1. Shows a waiting overlay
 * 2. Monitors transcode progress
 * 3. Auto-seeks when transcode catches up
 */
export function useTranscodeAwareSeek({
  canSeekTo,
  totalDuration,
  onSeekBlocked,
  onSeekAllowed,
}: UseTranscodeAwareSeekOptions): UseTranscodeAwareSeekResult {
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);
  const [isWaitingForTranscode, setIsWaitingForTranscode] = useState(false);

  // Use refs for callbacks to avoid effect re-runs when callbacks change
  const onSeekAllowedRef = useRef(onSeekAllowed);
  const onSeekBlockedRef = useRef(onSeekBlocked);

  // Keep refs in sync with latest callbacks
  useEffect(() => {
    onSeekAllowedRef.current = onSeekAllowed;
    onSeekBlockedRef.current = onSeekBlocked;
  }, [onSeekAllowed, onSeekBlocked]);

  const requestSeek = useCallback(
    (targetTime: number) => {
      // Use a small buffer before the edge to avoid race conditions
      // where we seek right to the edge but the segment isn't quite ready
      const safeCanSeekTo = Math.max(0, canSeekTo - SEEK_SAFETY_BUFFER_SECONDS);

      if (targetTime <= safeCanSeekTo) {
        // Target is safely within transcoded range - seek immediately
        setPendingSeek(null);
        setIsWaitingForTranscode(false);
        onSeekAllowedRef.current(targetTime);
      } else {
        // Target is at/beyond safe range - wait for transcode to catch up
        setPendingSeek(targetTime);
        setIsWaitingForTranscode(true);
        onSeekBlockedRef.current(targetTime);
      }
    },
    [canSeekTo],
  );

  // Auto-proceed when transcode catches up to pending seek target
  useEffect(() => {
    if (pendingSeek !== null && canSeekTo >= pendingSeek) {
      setIsWaitingForTranscode(false);
      onSeekAllowedRef.current(pendingSeek);
      setPendingSeek(null);
    }
  }, [canSeekTo, pendingSeek]);

  const cancelPendingSeek = useCallback(() => {
    setPendingSeek(null);
    setIsWaitingForTranscode(false);
  }, []);

  // Seek to the maximum currently available position
  const seekToAvailable = useCallback(() => {
    cancelPendingSeek();
    // Leave safety buffer before the edge
    const safePosition = Math.max(0, canSeekTo - SEEK_SAFETY_BUFFER_SECONDS);
    onSeekAllowedRef.current(safePosition);
  }, [canSeekTo, cancelPendingSeek]);

  const transcodeProgress = totalDuration > 0 ? canSeekTo / totalDuration : 0;

  return {
    requestSeek,
    cancelPendingSeek,
    seekToAvailable,
    isWaitingForTranscode,
    pendingSeekTarget: pendingSeek,
    transcodeProgress,
  };
}
