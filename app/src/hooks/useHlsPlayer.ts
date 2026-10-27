import Hls from 'hls.js';
import { useEffect, useRef, useState, useCallback } from 'react';

import { HLS_SEGMENT_DURATION } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('HLS');

interface UseHlsPlayerOptions {
  hlsUrl: string | undefined;
  videoElement: HTMLVideoElement | null;
}

export function useHlsPlayer({ hlsUrl, videoElement }: UseHlsPlayerOptions) {
  const hlsRef = useRef<Hls | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hlsDuration, setHlsDuration] = useState(0);
  const maxDurationRef = useRef(0); // Track maximum duration seen to prevent shrinking
  const currentUrlRef = useRef<string | null>(null);
  // Track programmatic seeks to avoid race condition with handleSeeking
  const programmaticSeekRef = useRef(false);
  // Track last known good position for error recovery
  const lastGoodPositionRef = useRef(0);
  // Track seeking state outside effect to maintain across re-renders
  const isSeekingInProgressRef = useRef(false);
  const seekTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // If no URL or no video element, nothing to do
    if (!hlsUrl || !videoElement) {
      log.debug('Waiting for URL or video element', { hlsUrl: !!hlsUrl, videoElement: !!videoElement });
      return;
    }

    // If we've already initialized for this URL and element, skip
    if (currentUrlRef.current === hlsUrl && hlsRef.current?.media === videoElement) {
      log.debug('Already initialized, skipping');
      return;
    }

    log.info('Initializing HLS player', { hlsUrl });
    setIsLoading(true);
    currentUrlRef.current = hlsUrl;

    // Only use native HLS on actual Safari (not Chromium browsers)
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    if (isSafari && videoElement.canPlayType('application/vnd.apple.mpegurl')) {
      videoElement.src = hlsUrl;
      videoElement.play().catch(() => {});
      setIsLoading(false);
      return;
    }

    if (!Hls.isSupported()) {
      setIsLoading(false);
      return;
    }

    // Destroy existing instance
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      // Start from beginning, not live edge (important for EVENT playlists during transcoding)
      startPosition: 0,
      // Buffer settings - keep conservative to avoid requesting untranscoded segments
      backBufferLength: 30,
      maxBufferLength: 15,
      maxMaxBufferLength: 30,
      maxBufferSize: 30 * 1000 * 1000,
      // More tolerant of gaps and holes in the stream
      maxBufferHole: 2,
      // Disable aggressive prefetching
      startFragPrefetch: false,
      highBufferWatchdogPeriod: 3,
      stretchShortVideoTrack: true,
      maxAudioFramesDrift: 1,
      // Handle discontinuities and gaps more gracefully
      nudgeOffset: 0.2,
      nudgeMaxRetry: 5,
      // Fragment loading - shorter timeout, retry with delay
      fragLoadingTimeOut: 20000,
      fragLoadingMaxRetry: 3,
      fragLoadingRetryDelay: 2000,
      // Allow larger gaps without erroring
      maxFragLookUpTolerance: 0.5,
      // ABR settings - disable bandwidth probing since we have one quality
      abrEwmaDefaultEstimate: 5000000, // Assume 5 Mbps
      abrEwmaFastLive: 3,
      abrEwmaSlowLive: 9,
      startLevel: 0, // Always use the only quality level
      autoLevelCapping: 0, // Cap to level 0
    });

    hlsRef.current = hls;
    hls.loadSource(hlsUrl);
    hls.attachMedia(videoElement);

    hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
      log.info('Manifest parsed, ready for playback');
      setIsLoading(false);

      // Log playlist details for debugging
      if (data.levels && data.levels[0]) {
        const level = data.levels[0];
        const details = level.details;
        if (details) {
          log.info(`Playlist info: fragments=${details.fragments?.length}, totalduration=${details.totalduration?.toFixed(1)}s, targetduration=${details.targetduration}s`);
        }
      }

      if (hls.media && isFinite(hls.media.duration)) {
        const newDuration = hls.media.duration;
        log.info(`Media duration: ${newDuration.toFixed(1)}s`);
        // Only update if duration increased (prevents shrinking during seeks)
        if (newDuration > maxDurationRef.current) {
          maxDurationRef.current = newDuration;
          setHlsDuration(newDuration);
        }
      }
      // Don't auto-play - let the user click the play button
    });

    // Track when playlist/level is loaded or updated
    hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
      const details = data.details;
      if (details) {
        const fragCount = details.fragments?.length ?? 0;
        const totalDur = details.totalduration ?? 0;
        const avgSegDuration = fragCount > 0 ? totalDur / fragCount : 0;

        log.info(`Level loaded: fragments=${fragCount}, totalduration=${totalDur.toFixed(1)}s, endSN=${details.endSN}, avgSegDur=${avgSegDuration.toFixed(2)}s`);

        // Sanity check: segment duration should be ~HLS_SEGMENT_DURATION (±2s tolerance)
        if (avgSegDuration > 0 && (avgSegDuration < HLS_SEGMENT_DURATION - 2 || avgSegDuration > HLS_SEGMENT_DURATION + 2)) {
          log.error(`WARNING: Unexpected average segment duration ${avgSegDuration.toFixed(2)}s (expected ~${HLS_SEGMENT_DURATION}s)`);
          // Log individual fragment durations to help diagnose
          if (details.fragments && details.fragments.length > 0) {
            const durations = details.fragments.slice(0, 5).map((f) => f.duration?.toFixed(2)).join(', ');
            log.error(`First 5 fragment durations: [${durations}]`);
          }
        }

        // Log first and last fragments for debugging
        if (details.fragments && details.fragments.length > 0) {
          const first = details.fragments[0];
          const last = details.fragments[details.fragments.length - 1];
          log.debug(`First fragment: sn=${first.sn}, start=${first.start?.toFixed(1)}s, dur=${first.duration?.toFixed(2)}s`);
          log.debug(`Last fragment: sn=${last.sn}, start=${last.start?.toFixed(1)}s, dur=${last.duration?.toFixed(2)}s`);
        }

        // Update duration from playlist if it's larger
        if (totalDur > maxDurationRef.current) {
          maxDurationRef.current = totalDur;
          setHlsDuration(totalDur);
        }
      }
    });

    // Track segments being requested - helps debug segment calculation issues
    hls.on(Hls.Events.FRAG_LOADING, (_event, data) => {
      if (data.frag) {
        const frag = data.frag;
        log.debug(`Loading fragment: sn=${frag.sn}, start=${frag.start?.toFixed(1)}s, duration=${frag.duration?.toFixed(1)}s`);
      }
    });

    // Track segments successfully loaded to update last good position
    hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
      if (data.frag && data.frag.start !== undefined) {
        const fragStart = data.frag.start;
        const currentPos = videoElement.currentTime;
        const distance = Math.abs(fragStart - currentPos);

        log.debug(`Fragment loaded: sn=${data.frag.sn}, start=${fragStart.toFixed(1)}s, currentTime=${currentPos.toFixed(1)}s`);

        // Only update lastGoodPosition if fragment is reasonably close to current position
        // This prevents a wrong segment (loaded due to calculation error) from corrupting recovery
        if (distance < 60) {
          lastGoodPositionRef.current = fragStart;
        } else {
          log.warn(`Fragment ${data.frag.sn} at ${fragStart.toFixed(1)}s is ${distance.toFixed(1)}s away from currentTime - not updating lastGoodPosition`);
        }
      }
    });

    const handleDurationChange = () => {
      if (videoElement.duration && isFinite(videoElement.duration)) {
        const newDuration = videoElement.duration;
        // Only update if duration increased (prevents shrinking during seeks)
        // HLS.js may report shorter duration when FFmpeg restarts for seek
        if (newDuration > maxDurationRef.current) {
          maxDurationRef.current = newDuration;
          setHlsDuration(newDuration);
        }
      }
    };
    videoElement.addEventListener('durationchange', handleDurationChange);

    const handleSeeking = () => {
      // Skip if this is a programmatic seek - the caller is handling HLS.js loading
      if (programmaticSeekRef.current) {
        programmaticSeekRef.current = false;
        log.debug(`Programmatic seek to ${videoElement.currentTime.toFixed(1)}s`);
        return;
      }

      if (hlsRef.current && !isSeekingInProgressRef.current) {
        isSeekingInProgressRef.current = true;
        const seekTime = videoElement.currentTime;
        log.debug(`User seeking to ${seekTime.toFixed(1)}s`);

        // Clear any pending seek timeout
        if (seekTimeoutIdRef.current) {
          clearTimeout(seekTimeoutIdRef.current);
        }

        // Stop current loading to reset HLS.js internal state completely
        // This prevents stale segment indices from persisting after errors
        hlsRef.current.stopLoad();

        // Small delay to ensure stop completes, then restart from seek position
        seekTimeoutIdRef.current = setTimeout(() => {
          if (hlsRef.current) {
            hlsRef.current.startLoad(seekTime);
          }
          isSeekingInProgressRef.current = false;
          seekTimeoutIdRef.current = null;
        }, 50);
      }
    };

    const handleSeeked = () => {
      // Ensure seeking flag is reset when seek completes
      isSeekingInProgressRef.current = false;
    };

    videoElement.addEventListener('seeking', handleSeeking);
    videoElement.addEventListener('seeked', handleSeeked);

    let mediaErrorRecoveryAttempts = 0;
    let codecSwapAttempts = 0;
    const MAX_MEDIA_ERROR_RETRIES = 3;
    const MAX_CODEC_SWAP_ATTEMPTS = 2;

    hls.on(Hls.Events.ERROR, (_event, data) => {
      const response = data.response as { code?: number; text?: string } | undefined;

      // Handle 400 error (invalid segment index - usually means segment is beyond total)
      // This indicates HLS.js has corrupted segment mapping - need full reload
      if (response?.code === 400) {
        log.warn('Invalid segment requested - forcing full playlist reload');
        try {
          const errorData = JSON.parse(response.text ?? '{}');
          log.error(`Segment mismatch: requested=${errorData.requested}, total=${errorData.total}`);
        } catch {
          // Ignore parse errors
        }
        // Force full reload to reset HLS.js internal state
        // We need to wait for the new manifest to be parsed before seeking
        const recoveryPosition = lastGoodPositionRef.current;
        log.info(`Reloading source and recovering to position ${recoveryPosition.toFixed(1)}s`);

        if (currentUrlRef.current) {
          // Set up one-time listener for manifest parsed before reloading
          const onManifestParsed = () => {
            hls.off(Hls.Events.MANIFEST_PARSED, onManifestParsed);
            log.info(`Manifest reloaded, seeking to ${recoveryPosition.toFixed(1)}s`);
            videoElement.currentTime = recoveryPosition;
            hls.startLoad(recoveryPosition);
          };
          hls.on(Hls.Events.MANIFEST_PARSED, onManifestParsed);

          // Stop current loading and reload source
          hls.stopLoad();
          hls.loadSource(currentUrlRef.current);
        }
        return;
      }

      // Handle 416 error (segment not yet transcoded)
      if (response?.code === 416) {
        log.debug('Segment not yet transcoded');
        // Parse the response to get canSeekTo info if available
        try {
          const errorData = JSON.parse(response.text ?? '{}');
          if (errorData.canSeekTo !== undefined) {
            log.info(`Can only seek to ${Math.floor(errorData.canSeekTo / 60)}:${String(Math.floor(errorData.canSeekTo % 60)).padStart(2, '0')}`);
            // Update last good position to canSeekTo (minus buffer)
            lastGoodPositionRef.current = Math.max(0, errorData.canSeekTo - 2);
          }
        } catch {
          // Ignore parse errors
        }
        // Stop and restart from last good position instead of currentTime
        hls.stopLoad();
        const recoveryPosition = lastGoodPositionRef.current;
        setTimeout(() => hls.startLoad(recoveryPosition), 100);
        return;
      }

      // Handle 500 error (file missing or server error)
      if (response?.code === 500) {
        log.warn('Server error, retrying from last good position');
        hls.stopLoad();
        setTimeout(() => hls.startLoad(lastGoodPositionRef.current), 500);
        return;
      }

      // Handle 503 errors (retry later)
      if (response?.code === 503) {
        log.debug('Server busy, will retry');
        return;
      }

      log.warn('Error:', data.type, data.details, data.fatal ? '(FATAL)' : '');

      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            // For network errors, check if it's just a segment not ready
            if (data.details === 'fragLoadError') {
              log.info('Fragment load failed, restarting from last good position');
              hls.startLoad(lastGoodPositionRef.current);
            } else {
              log.info('Recovering from fatal network error');
              hls.startLoad(lastGoodPositionRef.current);
            }
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            log.info('Recovering from fatal media error');
            if (mediaErrorRecoveryAttempts < MAX_MEDIA_ERROR_RETRIES) {
              mediaErrorRecoveryAttempts++;
              hls.recoverMediaError();
            } else if (codecSwapAttempts < MAX_CODEC_SWAP_ATTEMPTS) {
              log.warn('Too many media errors, trying swap codec level');
              mediaErrorRecoveryAttempts = 0;
              codecSwapAttempts++;
              hls.swapAudioCodec();
              hls.recoverMediaError();
            } else {
              log.error('Exhausted all recovery attempts, destroying');
              hls.destroy();
            }
            break;
          default:
            log.error('Unrecoverable error, destroying');
            hls.destroy();
            break;
        }
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        // Try to recover from non-fatal media errors
        if (data.details === 'bufferStalledError') {
          log.info('Buffer stalled, attempting recovery');
          // Try to recover by restarting load from last good position
          hls.startLoad(lastGoodPositionRef.current);
        } else if (data.details === 'fragParsingError') {
          log.warn('Fragment parsing error, skipping segment');
          // Skip ahead slightly to avoid the bad segment
          if (videoElement.currentTime > 0 && !videoElement.paused) {
            videoElement.currentTime += 0.5;
          }
        }
      } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        // Non-fatal network errors
        if (data.details === 'fragLoadError') {
          // Check if this is a segment index issue (requesting beyond available segments)
          const frag = data.frag;
          if (frag) {
            log.debug(`Fragment ${frag.sn} load error at time ${frag.start?.toFixed(1)}s`);
          }
          // Reset loading state and recover from last known good position
          hls.stopLoad();
          setTimeout(() => {
            hls.startLoad(lastGoodPositionRef.current);
          }, 200);
        }
      }
    });

    return () => {
      log.debug('Cleanup - destroying HLS instance');
      if (seekTimeoutIdRef.current) {
        clearTimeout(seekTimeoutIdRef.current);
        seekTimeoutIdRef.current = null;
      }
      isSeekingInProgressRef.current = false;
      videoElement.removeEventListener('seeking', handleSeeking);
      videoElement.removeEventListener('seeked', handleSeeked);
      videoElement.removeEventListener('durationchange', handleDurationChange);
      hls.destroy();
      hlsRef.current = null;
      currentUrlRef.current = null;
      maxDurationRef.current = 0; // Reset for next video
      lastGoodPositionRef.current = 0; // Reset for next video
    };
  }, [hlsUrl, videoElement]);

  /**
   * Seek to a specific time. This method handles HLS.js loading coordination
   * to avoid race conditions with the seeking event handler.
   */
  const seekTo = (time: number) => {
    if (!videoElement) return;

    if (hlsRef.current) {
      // Set flag to prevent handleSeeking from interfering
      programmaticSeekRef.current = true;

      // Log seek details for debugging
      const expectedSegment = Math.floor(time / HLS_SEGMENT_DURATION);
      log.info(`Seeking to ${time.toFixed(1)}s (expected segment ~${expectedSegment})`);

      // Start loading from the target position
      hlsRef.current.startLoad(time);
    }
    // Set the video element's currentTime
    videoElement.currentTime = time;
  };

  return { hlsRef, isLoading, hlsDuration, seekTo };
}
