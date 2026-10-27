import { useCallback, useEffect, useState } from 'react';

interface UseVideoControlsOptions {
  videoElement: HTMLVideoElement | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  duration: number;
}

export function useVideoControls({ videoElement, containerRef, duration }: UseVideoControlsOptions) {
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  // Track user's pause intent separately from video state
  // This ensures UI stays responsive even when video is buffering
  const [userWantsPause, setUserWantsPause] = useState(false);

  // Track video time, play state, and buffering
  useEffect(() => {
    if (!videoElement) return;

    const handleTimeUpdate = () => setCurrentTime(videoElement.currentTime);
    // Update currentTime immediately when seeking starts and ends
    // This ensures the UI reflects the seek position without waiting for timeupdate
    const handleSeeking = () => setCurrentTime(videoElement.currentTime);
    const handleSeeked = () => setCurrentTime(videoElement.currentTime);
    // Only set isPlaying true if user hasn't requested pause
    const handlePlay = () => {
      setUserWantsPause(false);
      setIsPlaying(true);
    };
    const handlePause = () => setIsPlaying(false);
    const handleWaiting = () => setIsBuffering(true);
    const handlePlaying = () => setIsBuffering(false);
    const handleCanPlay = () => setIsBuffering(false);
    // Reset state when video ends
    const handleEnded = () => {
      setIsPlaying(false);
      setUserWantsPause(false);
      setIsBuffering(false);
    };

    videoElement.addEventListener('timeupdate', handleTimeUpdate);
    videoElement.addEventListener('seeking', handleSeeking);
    videoElement.addEventListener('seeked', handleSeeked);
    videoElement.addEventListener('play', handlePlay);
    videoElement.addEventListener('pause', handlePause);
    videoElement.addEventListener('waiting', handleWaiting);
    videoElement.addEventListener('playing', handlePlaying);
    videoElement.addEventListener('canplay', handleCanPlay);
    videoElement.addEventListener('ended', handleEnded);

    return () => {
      videoElement.removeEventListener('timeupdate', handleTimeUpdate);
      videoElement.removeEventListener('seeking', handleSeeking);
      videoElement.removeEventListener('seeked', handleSeeked);
      videoElement.removeEventListener('play', handlePlay);
      videoElement.removeEventListener('pause', handlePause);
      videoElement.removeEventListener('waiting', handleWaiting);
      videoElement.removeEventListener('playing', handlePlaying);
      videoElement.removeEventListener('canplay', handleCanPlay);
      videoElement.removeEventListener('ended', handleEnded);
    };
  }, [videoElement]);

  // Track fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const seek = useCallback((seconds: number) => {
    if (!videoElement) return;
    videoElement.currentTime = seconds;
    if (videoElement.paused) {
      videoElement.play().catch(() => {});
    }
  }, [videoElement]);

  const seekByFraction = useCallback((fraction: number) => {
    const videoDuration = videoElement?.duration && isFinite(videoElement.duration) ? videoElement.duration : duration;
    if (!videoDuration) return;
    const newTime = Math.max(0, Math.min(videoDuration, fraction * videoDuration));
    seek(newTime);
  }, [duration, seek, videoElement]);

  const skipTime = useCallback((seconds: number) => {
    const videoDuration = videoElement?.duration && isFinite(videoElement.duration) ? videoElement.duration : duration;
    if (!videoDuration) return;
    const newTime = Math.max(0, Math.min(videoDuration, currentTime + seconds));
    seek(newTime);
  }, [currentTime, duration, seek, videoElement]);

  const togglePlayPause = useCallback(() => {
    if (!videoElement) return;

    if (videoElement.paused || userWantsPause) {
      // User wants to play
      setUserWantsPause(false);
      videoElement.play().catch(() => {});
    } else {
      // User wants to pause - set intent immediately for responsive UI
      setUserWantsPause(true);
      setIsPlaying(false);
      videoElement.pause();
    }
  }, [videoElement, userWantsPause]);

  const toggleMute = useCallback(() => {
    if (!videoElement) return;
    videoElement.muted = !videoElement.muted;
    setIsMuted(videoElement.muted);
  }, [videoElement]);

  const changeVolume = useCallback((newVolume: number) => {
    if (!videoElement) return;
    videoElement.volume = newVolume;
    setVolume(newVolume);
    if (newVolume === 0) {
      setIsMuted(true);
    } else if (isMuted) {
      videoElement.muted = false;
      setIsMuted(false);
    }
  }, [videoElement, isMuted]);

  const toggleFullscreen = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;

    if (!document.fullscreenElement) {
      await container.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  }, [containerRef]);

  return {
    currentTime,
    isPlaying,
    isBuffering,
    volume,
    isMuted,
    isFullscreen,
    seek,
    seekByFraction,
    skipTime,
    togglePlayPause,
    toggleMute,
    changeVolume,
    toggleFullscreen,
  };
}
