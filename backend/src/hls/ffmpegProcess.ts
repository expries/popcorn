import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readFile, rename, rm, stat } from 'fs/promises';
import { join } from 'path';

import { transcodeJobManager } from '../services/transcodeJobManager';
import { createLogger } from '../utils/logger';
import { segmentCache } from './segmentCache';
import { getValidationConfig, validateSegment } from './segmentValidator';
import { sessionRegistry } from './sessionRegistry';
import type { HlsSession, SessionKey } from './types';
import { DEFAULT_HLS_CONFIG } from './types';

const log = createLogger('FFmpeg');

const SEGMENT_POLL_INTERVAL_MS = 200;

// FFmpeg flags for reading incomplete/downloading files
// These help FFmpeg handle files that are still being written
const INCOMPLETE_FILE_FLAGS = [
  '-fflags', '+genpts',           // Generate presentation timestamps
  '-analyzeduration', '5000000',  // Analyze first 5 seconds
  '-probesize', '32768',          // Limit probe size for faster startup
  '-thread_queue_size', '512',    // Buffer for async reads
];

// Safety margin: stay this many segments behind download to prevent EOF errors
const SAFETY_MARGIN_SEGMENTS = 2;

interface FFmpegState {
  process: ChildProcess;
  startSegment: number;
  watchInterval: ReturnType<typeof setInterval>;
  nextExpectedIndex: number; // FFmpeg's internal segment counter (0, 1, 2...)
  tempDir: string; // Unique temp directory for this FFmpeg run
  runId: number; // Unique ID for this run
  segmentDurations: Map<number, number>; // Cached durations parsed from FFmpeg's m3u8
}

/**
 * Parse FFmpeg's m3u8 playlist to extract segment durations.
 * Returns a map of FFmpeg's internal segment index -> duration in seconds.
 */
async function parseFFmpegPlaylist(playlistPath: string): Promise<Map<number, number>> {
  const durations = new Map<number, number>();

  try {
    const content = await readFile(playlistPath, 'utf-8');
    const lines = content.split('\n');

    let currentDuration: number | null = null;

    for (const line of lines) {
      const trimmed = line.trim();

      // Parse EXTINF line: #EXTINF:6.123456,
      if (trimmed.startsWith('#EXTINF:')) {
        const match = trimmed.match(/^#EXTINF:([\d.]+)/);
        if (match) {
          currentDuration = parseFloat(match[1]);
        }
      }
      // Parse segment filename: segment_0.ts
      else if (trimmed.startsWith('segment_') && trimmed.endsWith('.ts') && currentDuration !== null) {
        const indexMatch = trimmed.match(/^segment_(\d+)\.ts$/);
        if (indexMatch) {
          const segmentIndex = parseInt(indexMatch[1], 10);
          durations.set(segmentIndex, currentDuration);
        }
        currentDuration = null;
      }
    }

    if (durations.size > 0) {
      log.debug(`Parsed ${durations.size} segment durations from FFmpeg playlist`);
    }
  } catch (err) {
    log.debug(`Could not parse FFmpeg playlist at ${playlistPath}: ${err}`);
  }

  return durations;
}

/**
 * Manages long-running FFmpeg processes for continuous segment generation.
 * Each session has at most one FFmpeg process that generates segments sequentially.
 */
class FFmpegProcessManager {
  private processes: Map<SessionKey, FFmpegState> = new Map();
  private startLocks: Map<SessionKey, Promise<void>> = new Map();
  private readonly segmentDuration: number;
  private runCounter = 0;

  constructor(segmentDuration: number = DEFAULT_HLS_CONFIG.segmentDuration) {
    this.segmentDuration = segmentDuration;
  }

  /**
   * Build FFmpeg arguments for continuous generation from a start time
   */
  private buildArgs(
    session: HlsSession,
    startTime: number,
    outputDir: string,
    options: { isIncompleteFile: boolean; maxDuration?: number },
  ): string[] {
    const hasAudio = !!session.codecInfo.audioCodec;
    const isTranscoding = session.decision.videoAction === 'transcode';

    const args: string[] = [];

    // Add incomplete file flags before input when transcoding a downloading file
    if (options.isIncompleteFile) {
      args.push(...INCOMPLETE_FILE_FLAGS);
    }

    // Input seeking (if not starting from beginning)
    if (startTime > 0) {
      args.push('-ss', String(startTime));
    }

    args.push('-i', session.filePath);

    // Limit duration if transcoding incomplete file (safety margin)
    // This prevents FFmpeg from hitting EOF errors
    if (options.maxDuration !== undefined && options.maxDuration > startTime) {
      args.push('-t', String(options.maxDuration - startTime));
    }

    // Stream mapping
    args.push('-map', '0:v:0');
    if (hasAudio) {
      args.push('-map', '0:a:0');
    }
    args.push('-sn', '-dn'); // No subtitles or data streams

    // Video codec
    if (session.decision.videoAction === 'copy') {
      args.push('-c:v', 'copy');
    } else {
      // When transcoding (especially HEVC), ensure proper timestamp and frame rate handling
      // -vsync cfr: Force constant frame rate - critical for VFR sources or unusual timestamps
      // -r: Explicit output frame rate matching source to prevent speed issues
      // -enc_time_base: Use filter timebase for correct PTS generation
      args.push(
        '-vsync', 'cfr',
        '-r', String(session.codecInfo.frameRate),
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-profile:v', 'main',
        '-level:v', '4.0',
        '-pix_fmt', 'yuv420p',
      );
    }

    // Audio codec
    if (session.decision.audioAction === 'copy') {
      args.push('-c:a', 'copy');
    } else {
      // -async 1: Sync audio to video timestamps, stretch/squeeze as needed
      args.push('-async', '1', '-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    }

    // Force keyframes at segment boundaries when transcoding
    if (isTranscoding) {
      args.push('-force_key_frames', `expr:gte(t,n_forced*${this.segmentDuration})`);
    }

    // Ensure output timestamps start from zero (important for seeking accuracy)
    args.push('-start_at_zero');

    // HLS output - FFmpeg writes segment_0.ts, segment_1.ts, etc.
    // With temp_file flag, FFmpeg writes to .ts.tmp then renames to .ts when complete
    // We'll rename them to the correct segment numbers
    args.push(
      '-f', 'hls',
      '-hls_time', String(this.segmentDuration),
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', join(outputDir, 'segment_%d.ts'),
      '-hls_list_size', '0',
      '-hls_flags', 'temp_file',
      join(outputDir, 'ffmpeg_playlist.m3u8'),
    );

    return args;
  }

  /**
   * Calculate the safe segment limit based on download progress.
   * This ensures we don't try to transcode past what's been downloaded.
   */
  calculateSafeSegmentLimit(
    downloadedBytes: number,
    totalBytes: number,
    totalSegments: number,
  ): number {
    if (totalBytes === 0) return 0;
    const downloadFraction = downloadedBytes / totalBytes;
    const downloadedSegments = Math.floor(downloadFraction * totalSegments);
    return Math.max(0, downloadedSegments - SAFETY_MARGIN_SEGMENTS);
  }

  /**
   * Calculate the safe duration limit based on download progress.
   */
  calculateSafeDurationLimit(
    downloadProgress: number,
    totalDuration: number,
  ): number {
    const downloadedDuration = downloadProgress * totalDuration;
    const safetyMarginSeconds = SAFETY_MARGIN_SEGMENTS * this.segmentDuration;
    return Math.max(0, downloadedDuration - safetyMarginSeconds);
  }

  /**
   * Start FFmpeg generation from a specific segment
   * @param session - The HLS session
   * @param fromSegment - The segment to start generating from
   * @param downloadProgress - Optional download progress (0-1) for safety margin calculation
   */
  async startGeneration(
    session: HlsSession,
    fromSegment: number,
    downloadProgress?: number,
  ): Promise<void> {
    // Validate that the source file exists before starting FFmpeg
    if (!existsSync(session.filePath)) {
      log.error(`[${session.sessionKey}] Source file does not exist: ${session.filePath}`);
      throw new Error(`Source file not found: ${session.filePath}`);
    }

    // Stop any existing process for this session
    this.stopGeneration(session.sessionKey);

    // Invalidate stale segments at or after fromSegment
    // This ensures we don't serve old cache files that won't be regenerated
    await segmentCache.deleteSegmentsFrom(session.sessionKey, fromSegment);

    // Update session state to remove stale segments and their durations
    for (const segmentIndex of session.generatedSegments) {
      if (segmentIndex >= fromSegment) {
        session.generatedSegments.delete(segmentIndex);
        session.segmentDurations.delete(segmentIndex);
      }
    }

    // Also invalidate the segment just before fromSegment if it might be truncated
    // This happens when FFmpeg was interrupted mid-segment
    if (fromSegment > 0) {
      const prevSegment = fromSegment - 1;
      const prevDuration = session.segmentDurations.get(prevSegment);
      // If the previous segment's duration is suspiciously short, remove it
      // A properly completed segment should be close to the target duration
      if (prevDuration !== undefined && prevDuration < this.segmentDuration * 0.5) {
        log.info(`[${session.sessionKey}] Invalidating truncated segment ${prevSegment} (duration: ${prevDuration.toFixed(2)}s)`);
        session.generatedSegments.delete(prevSegment);
        session.segmentDurations.delete(prevSegment);
        await segmentCache.deleteSegment(session.sessionKey, prevSegment);
      }
    }

    // Update highestGeneratedSegment to be just before fromSegment
    const newHighest = fromSegment > 0 ? fromSegment - 1 : -1;
    session.highestGeneratedSegment = newHighest;

    // Sync DB to prevent stale data on restart
    transcodeJobManager.updateSegmentProgress(session.infoHash, newHighest).catch((err) => {
      log.warn(`[${session.sessionKey}] Failed to sync segment invalidation to DB:`, err);
    });

    const sessionDir = await segmentCache.ensureSessionDir(session.sessionKey);
    const startTime = fromSegment * this.segmentDuration;

    // Use a unique temp directory for each FFmpeg run to avoid overwriting
    // segments from previous runs (e.g., when seeking, FFmpeg restarts and
    // would otherwise overwrite segment_0.ts, segment_1.ts, etc.)
    const runId = ++this.runCounter;
    const tempDir = join(sessionDir, `temp_${runId}`);
    await segmentCache.ensureDir(tempDir);

    // Determine if we're transcoding an incomplete file
    const isIncomplete = session.useIncompleteFileFlags && downloadProgress !== undefined && downloadProgress < 1.0;

    // Calculate max duration for safety margin when transcoding incomplete files
    let maxDuration: number | undefined;
    if (isIncomplete && downloadProgress !== undefined) {
      maxDuration = this.calculateSafeDurationLimit(downloadProgress, session.totalDuration);
    }

    const args = this.buildArgs(session, startTime, tempDir, {
      isIncompleteFile: isIncomplete,
      maxDuration,
    });

    log.info(`[${session.sessionKey}] Starting FFmpeg generation`);
    log.info(`[${session.sessionKey}] From segment ${fromSegment} (time: ${startTime}s)`);
    log.debug(`[${session.sessionKey}] Mode: ${session.decision.mode}, incomplete file: ${isIncomplete}`);
    if (maxDuration !== undefined) {
      log.debug(`[${session.sessionKey}] Max duration: ${maxDuration.toFixed(1)}s (safety margin)`);
    }
    log.debug(`[${session.sessionKey}] Command: ffmpeg ${args.join(' ')}`);

    const ffmpeg = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Update session state
    session.ffmpegStartSegment = fromSegment;
    session.isGenerating = true;

    // Watch for new segments and rename them
    const watchInterval = setInterval(() => {
      this.checkForNewSegments(session);
    }, SEGMENT_POLL_INTERVAL_MS);

    const state: FFmpegState = {
      process: ffmpeg,
      startSegment: fromSegment,
      watchInterval,
      nextExpectedIndex: 0,
      tempDir,
      runId,
      segmentDurations: new Map(),
    };

    this.processes.set(session.sessionKey, state);

    let stderrOutput = '';

    ffmpeg.stderr?.on('data', (data: Buffer) => {
      stderrOutput += data.toString();
    });

    ffmpeg.on('close', async (code) => {
      clearInterval(watchInterval);

      // Final check for any remaining segments - process all pending segments
      // Must complete before cleaning up temp directory
      await this.processRemainingSegments(session, state);

      this.processes.delete(session.sessionKey);
      session.isGenerating = false;

      // Clean up temp directory after all segments have been processed
      rm(tempDir, { recursive: true, force: true }).catch(() => {});

      if (code === 0) {
        log.info(`[${session.sessionKey}] FFmpeg completed generation`);
        log.debug(`[${session.sessionKey}] Generated segments ${fromSegment}-${session.highestGeneratedSegment}`);
      } else {
        const errorMatch = stderrOutput.match(/Error[^]*/i);
        const errorMsg = errorMatch ? errorMatch[0].slice(0, 200) : `Exit code ${code}`;
        log.error(`[${session.sessionKey}] FFmpeg failed: ${errorMsg}`);
      }
    });

    ffmpeg.on('error', (err) => {
      clearInterval(watchInterval);
      this.processes.delete(session.sessionKey);
      session.isGenerating = false;
      // Clean up temp directory
      rm(tempDir, { recursive: true, force: true }).catch(() => {});
      log.error(`[${session.sessionKey}] FFmpeg process error:`, err.message);
    });
  }

  /**
   * Check for newly generated segments and move them to the session directory.
   * FFmpeg writes to a temp directory, we move completed segments to avoid overwrites.
   * With -hls_flags temp_file, FFmpeg writes to .ts.tmp then renames to .ts when complete.
   */
  private async checkForNewSegments(session: HlsSession): Promise<void> {
    const state = this.processes.get(session.sessionKey);
    if (!state) return;

    const sessionDir = segmentCache.getSessionDir(session.sessionKey);

    // FFmpeg writes segment_0.ts, segment_1.ts, etc. in its temp directory
    // We move them to the session directory with correct segment indices
    const ffmpegSegmentPath = join(state.tempDir, `segment_${state.nextExpectedIndex}.ts`);
    const targetSegmentIndex = state.startSegment + state.nextExpectedIndex;
    const targetSegmentPath = join(sessionDir, `segment_${targetSegmentIndex}.ts`);

    try {
      await stat(ffmpegSegmentPath);
      // File exists and is complete (temp_file flag ensures this)

      // Parse FFmpeg's playlist to get actual segment duration
      // We cache parsed durations to avoid re-parsing for every segment
      if (state.segmentDurations.size <= state.nextExpectedIndex) {
        const playlistPath = join(state.tempDir, 'ffmpeg_playlist.m3u8');
        const parsed = await parseFFmpegPlaylist(playlistPath);
        for (const [idx, dur] of parsed) {
          state.segmentDurations.set(idx, dur);
        }
      }
      const rawDuration = state.segmentDurations.get(state.nextExpectedIndex);

      // Move to session directory first (needed for full file validation)
      await rename(ffmpegSegmentPath, targetSegmentPath);

      // Validate segment (duration, file size, MPEG-TS header, size/duration ratio)
      // Use different thresholds for transcoding vs copy mode
      const isTranscoding = session.decision.videoAction === 'transcode';
      const validationConfig = getValidationConfig(isTranscoding, this.segmentDuration);
      const validation = await validateSegment(targetSegmentPath, rawDuration, validationConfig);

      if (!validation.valid) {
        // Invalid segment - delete it and skip (will be regenerated)
        log.warn(`[${session.sessionKey}] Rejecting segment ${targetSegmentIndex}: ${validation.reason}`);
        await rm(targetSegmentPath, { force: true });
        state.nextExpectedIndex++;
        return;
      }

      // Update session state via registry (this also updates transcodedDuration)
      sessionRegistry.markSegmentReady(session.sessionKey, targetSegmentIndex, validation.duration ?? undefined);

      log.debug(`[${session.sessionKey}] Segment ${targetSegmentIndex} ready (dur=${validation.duration?.toFixed(2) ?? 'default'}s, size=${validation.fileSize}, set size: ${session.generatedSegments.size})`);

      state.nextExpectedIndex++;
    } catch {
      // Segment doesn't exist yet, that's fine
    }
  }

  /**
   * Process all remaining segments when FFmpeg closes.
   * Keeps checking until no more segments are found.
   */
  private async processRemainingSegments(session: HlsSession, state: FFmpegState): Promise<void> {
    const sessionDir = segmentCache.getSessionDir(session.sessionKey);
    let foundSegments = true;

    // Parse FFmpeg's playlist one final time to get all segment durations
    const playlistPath = join(state.tempDir, 'ffmpeg_playlist.m3u8');
    const parsed = await parseFFmpegPlaylist(playlistPath);
    for (const [idx, dur] of parsed) {
      state.segmentDurations.set(idx, dur);
    }

    // Keep processing until we don't find any more segments
    while (foundSegments) {
      foundSegments = false;
      const ffmpegSegmentPath = join(state.tempDir, `segment_${state.nextExpectedIndex}.ts`);
      const targetSegmentIndex = state.startSegment + state.nextExpectedIndex;
      const targetSegmentPath = join(sessionDir, `segment_${targetSegmentIndex}.ts`);

      try {
        await stat(ffmpegSegmentPath);
        // File exists and is complete

        const rawDuration = state.segmentDurations.get(state.nextExpectedIndex);

        // Move to session directory first (needed for full file validation)
        await rename(ffmpegSegmentPath, targetSegmentPath);

        // Validate segment (duration, file size, MPEG-TS header, size/duration ratio)
        // Use different thresholds for transcoding vs copy mode
        const isTranscoding = session.decision.videoAction === 'transcode';
        const validationConfig = getValidationConfig(isTranscoding, this.segmentDuration);
        const validation = await validateSegment(targetSegmentPath, rawDuration, validationConfig);

        if (!validation.valid) {
          // Invalid segment - delete it and skip
          log.warn(`[${session.sessionKey}] Rejecting final segment ${targetSegmentIndex}: ${validation.reason}`);
          await rm(targetSegmentPath, { force: true });
          state.nextExpectedIndex++;
          foundSegments = true;
          continue;
        }

        // Update session state via registry
        sessionRegistry.markSegmentReady(session.sessionKey, targetSegmentIndex, validation.duration ?? undefined);

        log.debug(`[${session.sessionKey}] Segment ${targetSegmentIndex} ready (final, dur=${validation.duration?.toFixed(2) ?? 'default'}s, size=${validation.fileSize}, set size: ${session.generatedSegments.size})`);

        state.nextExpectedIndex++;
        foundSegments = true;
      } catch {
        // No more segments to process
      }
    }
  }

  /**
   * Stop FFmpeg generation for a session
   */
  stopGeneration(sessionKey: SessionKey): void {
    const state = this.processes.get(sessionKey);
    if (!state) return;

    log.info(`Stopping generation for ${sessionKey}`);

    clearInterval(state.watchInterval);
    state.process.kill('SIGTERM');
    this.processes.delete(sessionKey);

    // Clean up temp directory (the close handler will also try, but this is faster)
    rm(state.tempDir, { recursive: true, force: true }).catch(() => {});

    const session = sessionRegistry.getSession(sessionKey);
    if (session) {
      session.isGenerating = false;
    }
  }

  /**
   * Acquire a lock for the session, waiting if another operation is in progress.
   * Uses a promise chain to ensure proper serialization.
   */
  private async acquireLock(sessionKey: SessionKey): Promise<() => void> {
    // Get current lock (if any) before we add ours
    const currentLock = this.startLocks.get(sessionKey) ?? Promise.resolve();

    // Create our lock
    let resolveLock: () => void;
    const ourLock = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    // Chain our lock after the current one
    this.startLocks.set(sessionKey, currentLock.then(() => ourLock));

    // Wait for the previous lock to complete
    await currentLock;

    // Return release function
    return () => {
      resolveLock!();
    };
  }

  /**
   * Ensure FFmpeg is running and will eventually generate segments.
   * FFmpeg transcodes sequentially from the beginning (or resume point) to the end.
   * It is NEVER restarted due to seeks - transcoding is continuous.
   *
   * @param session - The HLS session
   * @param downloadProgress - Optional download progress (0-1) for safety margin
   * @returns true if FFmpeg was started
   */
  async ensureTranscodingStarted(
    session: HlsSession,
    downloadProgress?: number,
  ): Promise<boolean> {
    // If already generating, nothing to do
    if (session.isGenerating) {
      return false;
    }

    // Acquire lock to prevent concurrent FFmpeg starts
    const releaseLock = await this.acquireLock(session.sessionKey);

    try {
      // Re-check after acquiring lock
      if (session.isGenerating) {
        return false;
      }

      // Find the first segment that needs to be generated
      // This allows resuming from where we left off
      let startSegment = 0;
      for (let i = 0; i < session.totalSegments; i++) {
        if (!session.generatedSegments.has(i) && !(await segmentCache.segmentExists(session.sessionKey, i))) {
          startSegment = i;
          break;
        }
        // If we have this segment, continue to find the gap
        if (i === session.totalSegments - 1) {
          // All segments exist, nothing to do
          log.info(`[${session.sessionKey}] All segments already generated`);
          return false;
        }
      }

      log.info(`[${session.sessionKey}] FFmpeg not running`);
      await this.startGeneration(session, startSegment, downloadProgress);
      return true;
    } finally {
      releaseLock();
    }
  }

  /**
   * Check if a segment is available or will be available soon.
   * @returns 'ready' if cached, 'pending' if will be generated soon, 'unavailable' if too far ahead, 'missing' if was generated but file is gone
   */
  async getSegmentStatus(
    session: HlsSession,
    segmentIndex: number,
  ): Promise<'ready' | 'pending' | 'unavailable' | 'missing'> {
    // Check cache first - file must actually exist
    const fileExists = await segmentCache.segmentExists(session.sessionKey, segmentIndex);

    if (fileExists) {
      return 'ready';
    }

    // If segment was marked as generated but file is missing, report it
    if (session.generatedSegments.has(segmentIndex)) {
      log.warn(`[${session.sessionKey}] Segment ${segmentIndex} in generatedSegments but file missing`);
      return 'missing';
    }

    // If FFmpeg is generating, check if this segment will be generated soon
    if (session.isGenerating) {
      // Current position is the highest generated segment (or start if none yet)
      const currentPosition = Math.max(session.ffmpegStartSegment, session.highestGeneratedSegment);

      // Segment is behind the current position - it was skipped or won't be generated
      if (segmentIndex < session.ffmpegStartSegment) {
        return 'unavailable';
      }

      // Segment is within reasonable range of current position - it's pending
      // Calculate threshold dynamically: segments that would be generated within ~2 minutes
      // At ~1 segment per second transcoding speed, that's ~120 segments
      // But cap at remaining segments to avoid false 'pending' for very long videos
      const remainingSegments = session.totalSegments - currentPosition;
      const pendingThreshold = Math.min(120, remainingSegments);
      if (segmentIndex <= currentPosition + pendingThreshold) {
        return 'pending';
      }

      // Segment is too far ahead - return unavailable so frontend shows the dialog
      return 'unavailable';
    }

    // FFmpeg not running - segment won't be generated
    return 'unavailable';
  }

  /**
   * Wait for a specific segment to be generated.
   * Returns true if segment is ready, false on timeout.
   */
  async waitForSegment(
    session: HlsSession,
    segmentIndex: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      // Check if segment exists
      if (await segmentCache.segmentExists(session.sessionKey, segmentIndex)) {
        return true;
      }

      // Check if segment is ready via session state
      if (session.generatedSegments.has(segmentIndex)) {
        // Double-check file exists
        if (await segmentCache.segmentExists(session.sessionKey, segmentIndex)) {
          return true;
        }
      }

      // If FFmpeg stopped, check if the segment might still be generated
      if (!session.isGenerating) {
        // If segment is before where FFmpeg started, it won't be generated
        if (segmentIndex < session.ffmpegStartSegment) {
          log.warn(
            `Segment ${segmentIndex} won't be generated (before start: ${session.ffmpegStartSegment})`,
          );
          return false;
        }
        // If segment is already generated, we should have found it above
        // If it's not in the cache and FFmpeg stopped, it won't be generated
        if (!session.generatedSegments.has(segmentIndex)) {
          log.warn(
            `Segment ${segmentIndex} won't be generated (FFmpeg stopped, highest: ${session.highestGeneratedSegment})`,
          );
          return false;
        }
      }

      // Wait before checking again
      await new Promise((resolve) => setTimeout(resolve, SEGMENT_POLL_INTERVAL_MS));
    }

    log.warn(`Timeout waiting for segment ${segmentIndex}`);
    return false;
  }

  /**
   * Check if FFmpeg is running for a session
   */
  isRunning(sessionKey: SessionKey): boolean {
    return this.processes.has(sessionKey);
  }

  /**
   * Get the number of active FFmpeg processes
   */
  getActiveCount(): number {
    return this.processes.size;
  }

  /**
   * Kill all active FFmpeg processes
   */
  killAll(): void {
    log.info(`Killing all ${this.processes.size} active processes`);
    for (const sessionKey of this.processes.keys()) {
      this.stopGeneration(sessionKey);
    }
  }
}

export const ffmpegProcess = new FFmpegProcessManager();
