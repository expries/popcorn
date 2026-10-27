import { open } from 'fs/promises';
import type { FileHandle } from 'fs/promises';

import { createLogger } from '../utils/logger';

const log = createLogger('SegmentValidator');

// MPEG-TS sync byte - all TS packets start with this
const MPEGTS_SYNC_BYTE = 0x47;

// Minimum file size for any valid segment (even 1s of low-bitrate video)
const MIN_SEGMENT_SIZE_BYTES = 1024; // 1KB

// Minimum bytes per second of video (very conservative, ~8kbps)
// Real video is typically 500kbps+ but we want to catch only obvious corruption
const MIN_BYTES_PER_SECOND = 1024; // 1KB/s

/** Configuration for segment validation */
export interface SegmentValidationConfig {
  targetDuration: number; // Expected segment duration in seconds
  minDuration: number; // Minimum valid duration
  maxDuration: number; // Maximum valid duration
  minSizeBytes: number; // Minimum file size
  minBytesPerSecond: number; // Minimum bytes per second of content
}

/** Default config for transcoding mode (forced keyframes at target intervals) */
export const TRANSCODE_VALIDATION_CONFIG: SegmentValidationConfig = {
  targetDuration: 6,
  minDuration: 1.0,
  maxDuration: 15, // ~2.5x target - forced keyframes should be consistent
  minSizeBytes: MIN_SEGMENT_SIZE_BYTES,
  minBytesPerSecond: MIN_BYTES_PER_SECOND,
};

/** Default config for copy mode (segments depend on source keyframes) */
export const COPY_MODE_VALIDATION_CONFIG: SegmentValidationConfig = {
  targetDuration: 6,
  minDuration: 1.0,
  maxDuration: 60, // Source keyframes can be far apart (30s+ in some content)
  minSizeBytes: MIN_SEGMENT_SIZE_BYTES,
  minBytesPerSecond: MIN_BYTES_PER_SECOND,
};

/**
 * Get validation config appropriate for the transcode mode.
 * @param isTranscoding - true if video is being re-encoded (forced keyframes)
 * @param targetDuration - the target segment duration
 */
export function getValidationConfig(
  isTranscoding: boolean,
  targetDuration: number = 6,
): SegmentValidationConfig {
  const base = isTranscoding ? TRANSCODE_VALIDATION_CONFIG : COPY_MODE_VALIDATION_CONFIG;
  return {
    ...base,
    targetDuration,
    // Scale maxDuration proportionally if targetDuration differs from default
    maxDuration: isTranscoding
      ? targetDuration * 2.5 // Tight bounds for transcoding
      : targetDuration * 10, // Loose bounds for copy mode
  };
}

/** Result of segment validation */
export interface SegmentValidationResult {
  valid: boolean;
  duration: number | null;
  fileSize: number | null;
  reason?: string;
}

/**
 * Validate a segment file after generation.
 * Checks:
 * 1. Duration is within valid range
 * 2. File size meets minimum threshold
 * 3. File starts with MPEG-TS sync byte
 * 4. File size is reasonable for claimed duration
 */
export async function validateSegment(
  filePath: string,
  duration: number | undefined,
  config: Partial<SegmentValidationConfig> = {},
): Promise<SegmentValidationResult> {
  const cfg = { ...TRANSCODE_VALIDATION_CONFIG, ...config };

  let fh: FileHandle | null = null;

  try {
    fh = await open(filePath, 'r');
    const stats = await fh.stat();
    const fileSize = stats.size;

    // Check 1: Minimum file size
    if (fileSize < cfg.minSizeBytes) {
      return {
        valid: false,
        duration: duration ?? null,
        fileSize,
        reason: `file too small (${fileSize} bytes < ${cfg.minSizeBytes})`,
      };
    }

    // Check 2: MPEG-TS sync byte
    const syncBuffer = Buffer.alloc(1);
    await fh.read(syncBuffer, 0, 1, 0);
    if (syncBuffer[0] !== MPEGTS_SYNC_BYTE) {
      return {
        valid: false,
        duration: duration ?? null,
        fileSize,
        reason: `invalid MPEG-TS header (expected 0x47, got 0x${syncBuffer[0].toString(16)})`,
      };
    }

    // Check 3: Duration validation (if provided)
    if (duration !== undefined) {
      // Too short
      if (duration < cfg.minDuration) {
        return {
          valid: false,
          duration,
          fileSize,
          reason: `duration too short (${duration.toFixed(2)}s < ${cfg.minDuration}s)`,
        };
      }

      // Too long
      if (duration > cfg.maxDuration) {
        return {
          valid: false,
          duration,
          fileSize,
          reason: `duration too long (${duration.toFixed(2)}s > ${cfg.maxDuration}s)`,
        };
      }

      // Check 4: Size-to-duration ratio
      const minExpectedSize = duration * cfg.minBytesPerSecond;
      if (fileSize < minExpectedSize) {
        return {
          valid: false,
          duration,
          fileSize,
          reason: `file too small for duration (${fileSize} bytes for ${duration.toFixed(2)}s, expected >= ${Math.round(minExpectedSize)})`,
        };
      }
    }

    // All checks passed
    return {
      valid: true,
      duration: duration ?? null,
      fileSize,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      duration: duration ?? null,
      fileSize: null,
      reason: `file read error: ${message}`,
    };
  } finally {
    if (fh) {
      await fh.close().catch(() => {});
    }
  }
}

/**
 * Quick duration-only validation (for cases where file hasn't been moved yet)
 */
export function validateDuration(
  duration: number | undefined,
  config: Partial<SegmentValidationConfig> = {},
): { valid: boolean; reason?: string } {
  if (duration === undefined) {
    return { valid: true };
  }

  const cfg = { ...TRANSCODE_VALIDATION_CONFIG, ...config };

  if (duration < cfg.minDuration) {
    return {
      valid: false,
      reason: `duration too short (${duration.toFixed(2)}s < ${cfg.minDuration}s)`,
    };
  }

  if (duration > cfg.maxDuration) {
    return {
      valid: false,
      reason: `duration too long (${duration.toFixed(2)}s > ${cfg.maxDuration}s)`,
    };
  }

  return { valid: true };
}
