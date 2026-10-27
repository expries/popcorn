import { useState, useEffect, useRef, useCallback } from 'react';

interface UseVideoDurationOptions {
  videoElement: HTMLVideoElement | null;
  hlsDuration: number;
  backendDuration: number | undefined;
  isHlsMode: boolean;
}

interface UseVideoDurationResult {
  duration: number;
  isStable: boolean;
}

/**
 * Hook to manage video duration with clear priority and stability tracking.
 *
 * Priority order:
 * 1. Video element duration (most accurate once loaded)
 * 2. HLS manifest duration (for HLS mode before video loads)
 * 3. Backend ffprobe duration (fallback)
 *
 * Features:
 * - Tracks maximum duration seen to prevent shrinking during seeks
 * - Only accepts values within 5% tolerance of max (prevents jumps)
 * - Provides stability indicator for UI
 */
export function useVideoDuration({
  videoElement,
  hlsDuration,
  backendDuration,
  isHlsMode,
}: UseVideoDurationOptions): UseVideoDurationResult {
  const [stableDuration, setStableDuration] = useState(0);
  const [isStable, setIsStable] = useState(false);
  const maxDurationRef = useRef(0);
  // Track video element duration separately since videoElement?.duration doesn't trigger re-renders
  const [videoDuration, setVideoDuration] = useState(0);

  // Listen to durationchange event on video element
  useEffect(() => {
    if (!videoElement) {
      setVideoDuration(0);
      return;
    }

    const handleDurationChange = () => {
      const dur = videoElement.duration;
      if (dur && isFinite(dur) && dur > 0) {
        setVideoDuration(dur);
      }
    };

    // Check initial duration
    handleDurationChange();

    videoElement.addEventListener('durationchange', handleDurationChange);
    videoElement.addEventListener('loadedmetadata', handleDurationChange);

    return () => {
      videoElement.removeEventListener('durationchange', handleDurationChange);
      videoElement.removeEventListener('loadedmetadata', handleDurationChange);
    };
  }, [videoElement]);

  // Update stable duration based on priority
  const updateDuration = useCallback(() => {
    let selectedDuration = 0;
    let source: 'video' | 'hls' | 'backend' | 'none' = 'none';

    // Priority 1: Video element duration (most accurate)
    if (videoDuration > 0) {
      selectedDuration = videoDuration;
      source = 'video';
    }
    // Priority 2: HLS manifest duration (for HLS mode)
    else if (isHlsMode && hlsDuration > 0) {
      selectedDuration = hlsDuration;
      source = 'hls';
    }
    // Priority 3: Backend ffprobe duration (fallback)
    else if (backendDuration && backendDuration > 0) {
      selectedDuration = backendDuration;
      source = 'backend';
    }

    if (selectedDuration > 0) {
      // Only update if the new duration is reasonable:
      // - Greater than or equal to max seen (normal case)
      // - Within 5% tolerance of max (prevents regression during seeks)
      const tolerance = maxDurationRef.current * 0.05;
      if (
        selectedDuration >= maxDurationRef.current ||
        selectedDuration >= maxDurationRef.current - tolerance
      ) {
        maxDurationRef.current = Math.max(maxDurationRef.current, selectedDuration);
        setStableDuration(maxDurationRef.current);
        // Duration is stable when it comes from the video element
        setIsStable(source === 'video');
      }
    }
  }, [videoDuration, hlsDuration, backendDuration, isHlsMode]);

  useEffect(() => {
    updateDuration();
  }, [updateDuration]);

  return { duration: stableDuration, isStable };
}
