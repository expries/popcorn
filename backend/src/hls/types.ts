/** Codec information extracted from ffprobe */
export interface CodecInfo {
  videoCodec: string | null;
  audioCodec: string | null;
  videoBitrate: number | null;
  audioBitrate: number | null;
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  // H.264 specific info
  videoProfile: string | null;
  videoLevel: number | null;
  // Pixel format (yuv420p is compatible, yuv422p/yuv444p/10-bit are not)
  pixelFormat: string | null;
  // moov atom position (null if unknown, true if at start, false if at end)
  moovAtStart: boolean | null;
}

/** Transcoding decision based on codec probe */
export type TranscodeMode = 'copy' | 'audio_only' | 'full';

export interface TranscodeDecision {
  mode: TranscodeMode;
  videoAction: 'copy' | 'transcode';
  audioAction: 'copy' | 'transcode';
  reason: string;
}

/** Session key format: {infoHash}_{transcodeMode} */
export type SessionKey = string;

/** Session state in the registry */
export interface HlsSession {
  sessionKey: SessionKey;
  infoHash: string;
  filePath: string;
  codecInfo: CodecInfo;
  decision: TranscodeDecision;
  createdAt: Date;
  lastAccessedAt: Date;
  segmentDuration: number;
  totalSegments: number;
  generatedSegments: Set<number>;
  segmentDurations: Map<number, number>; // Actual duration per segment (segmentIndex -> seconds)
  // FFmpeg process state for continuous generation
  ffmpegStartSegment: number; // Which segment FFmpeg started generating from
  highestGeneratedSegment: number; // Highest segment number generated so far
  isGenerating: boolean; // Whether FFmpeg is currently running
  // Progressive transcoding state
  streamingMode: 'hls' | 'native';
  waitingForDownload: boolean;
  transcodedDuration: number; // Duration in seconds that has been transcoded
  totalDuration: number; // Total video duration in seconds
  containerFormat: string; // Container format (matroska, mp4, etc.)
  useIncompleteFileFlags: boolean; // Whether to use -fflags +genpts for incomplete files
}

/**
 * Get cumulative duration up to and including the given segment.
 * Falls back to default segment duration for segments without recorded duration.
 */
export function getCumulativeDuration(
  segmentDurations: Map<number, number>,
  upToSegment: number,
  defaultDuration: number,
): number {
  let total = 0;
  for (let i = 0; i <= upToSegment; i++) {
    total += segmentDurations.get(i) ?? defaultDuration;
  }
  return total;
}

/**
 * Get the start time of a segment based on cumulative durations of previous segments.
 */
export function getSegmentStartTime(
  segmentDurations: Map<number, number>,
  segmentIndex: number,
  defaultDuration: number,
): number {
  if (segmentIndex <= 0) return 0;
  return getCumulativeDuration(segmentDurations, segmentIndex - 1, defaultDuration);
}

/** Result of segment duration validation */
export interface SegmentValidationResult {
  valid: boolean;
  duration: number | null; // null if no duration provided or invalid
  reason?: string;
}

/**
 * Validate a segment's duration.
 * Returns whether the segment should be accepted and the duration to use.
 *
 * Invalid segments (truncated, corrupted, parsing errors) should be rejected
 * entirely so they can be regenerated.
 */
export function validateSegmentDuration(
  duration: number | undefined,
  targetDuration: number,
): SegmentValidationResult {
  // No duration provided - can't validate, use default
  if (duration === undefined) {
    return { valid: true, duration: null };
  }

  // Too short - likely truncated/interrupted segment
  if (duration < 1.0) {
    return {
      valid: false,
      duration: null,
      reason: `too short (${duration.toFixed(2)}s < 1s)`,
    };
  }

  // Too long - likely parsing error or corrupted data
  // Allow up to 5x target duration for variable keyframe sources
  const maxDuration = targetDuration * 5;
  if (duration > maxDuration) {
    return {
      valid: false,
      duration: null,
      reason: `too long (${duration.toFixed(2)}s > ${maxDuration}s)`,
    };
  }

  // Valid duration
  return { valid: true, duration };
}

/** Lock state for preventing duplicate FFmpeg processes */
export interface ProducerLock {
  sessionKey: SessionKey;
  acquiredAt: Date;
  targetSegment: number;
  waiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }>;
}

/** Cache statistics */
export interface CacheStats {
  totalSessions: number;
  totalSegments: number;
  totalSizeBytes: number;
  oldestSessionAge: number;
}

/** FFprobe JSON output structure */
export interface FFprobeResult {
  streams: Array<{
    codec_type: 'video' | 'audio' | 'subtitle' | 'data';
    codec_name: string;
    bit_rate?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    profile?: string;
    level?: number;
    pix_fmt?: string;
    duration?: string;
    nb_frames?: string;
  }>;
  format: {
    duration: string;
    bit_rate?: string;
  };
}

/** HLS configuration */
export interface HlsConfig {
  cachePath: string;
  segmentDuration: number;
  lookaheadSegments: number;
  maxCacheSizeBytes: number;
  sessionMaxAgeMs: number;
  lockTimeoutMs: number;
  segmentWaitTimeoutMs: number;
  evictionIntervalMs: number;
}

/** Default HLS configuration */
export const DEFAULT_HLS_CONFIG: HlsConfig = {
  cachePath: process.env.HLS_CACHE_PATH ?? '/cache/hls',
  segmentDuration: parseInt(process.env.HLS_SEGMENT_DURATION ?? '6', 10),
  lookaheadSegments: parseInt(process.env.HLS_LOOKAHEAD_SEGMENTS ?? '5', 10),
  maxCacheSizeBytes:
    parseInt(process.env.HLS_MAX_CACHE_SIZE_GB ?? '10', 10) * 1024 * 1024 * 1024,
  sessionMaxAgeMs: parseInt(process.env.HLS_SESSION_MAX_AGE_HOURS ?? '24', 10) * 60 * 60 * 1000,
  lockTimeoutMs: parseInt(process.env.HLS_LOCK_TIMEOUT_MS ?? '60000', 10),
  segmentWaitTimeoutMs: parseInt(process.env.HLS_SEGMENT_WAIT_TIMEOUT_MS ?? '30000', 10),
  evictionIntervalMs: 5 * 60 * 1000, // 5 minutes
};
