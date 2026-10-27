import { transcodeJobManager } from '../services/transcodeJobManager';
import { torrentManager } from '../services/torrentManager';
import { createLogger } from '../utils/logger';

import { buildSessionKey, makeTranscodeDecision, probeFile } from './codecProbe';
import { ffmpegProcess } from './ffmpegProcess';
import { segmentCache } from './segmentCache';
import { determineStreamingStrategy } from './streamingStrategy';
import type { HlsSession, SessionKey } from './types';
import { DEFAULT_HLS_CONFIG, getCumulativeDuration } from './types';

const log = createLogger('Session');
const dbLog = createLogger('DB');

/**
 * Retry an async operation with exponential backoff
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  options: { maxRetries?: number; baseDelayMs?: number; context?: string } = {},
): Promise<T | null> {
  const { maxRetries = 3, baseDelayMs = 1000, context = 'operation' } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (attempt === maxRetries) {
        dbLog.error(`${context} failed after ${maxRetries + 1} attempts:`, err);
        return null;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      dbLog.warn(`${context} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`, err);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return null;
}

/**
 * Get container format from file extension
 */
function getContainerFormat(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop();
  const formatMap: Record<string, string> = {
    mkv: 'matroska',
    webm: 'webm',
    mp4: 'mp4',
    m4v: 'mp4',
    mov: 'mov',
    avi: 'avi',
    ogv: 'ogg',
  };
  return formatMap[ext ?? ''] ?? 'unknown';
}

/**
 * Find the highest contiguous segment starting from 0.
 * This ensures progress reflects actually playable content, not just the max segment index.
 * For example, if segments [0,1,2,50,51,52] exist, this returns 2 (not 52).
 */
export function getHighestContiguousSegment(generatedSegments: Set<number>): number {
  if (generatedSegments.size === 0) {
    return -1;
  }

  let highest = -1;
  // Loop until we find a gap - no arbitrary upper bound needed since we break on first missing
  for (let i = 0; ; i++) {
    if (generatedSegments.has(i)) {
      highest = i;
    } else {
      break;
    }
  }
  return highest;
}

/**
 * Calculate the maximum seekable position (canSeekTo) for a session.
 * For HLS: based on contiguous transcoded segments using actual segment durations
 * For native: based on download progress
 * @param session - HLS session (may be null for native streaming)
 * @param downloadProgress - Download progress as fraction 0-1
 * @param fallbackDuration - Duration to use when no session exists (for native streaming)
 */
export function calculateCanSeekTo(
  session: HlsSession | null,
  downloadProgress: number,
  fallbackDuration?: number,
): number {
  if (!session) {
    // Native streaming without session - use fallback duration
    if (fallbackDuration !== undefined && fallbackDuration > 0) {
      return downloadProgress * fallbackDuration;
    }
    return 0;
  }

  if (session.streamingMode === 'hls') {
    const highestContiguous = getHighestContiguousSegment(session.generatedSegments);
    if (highestContiguous < 0) return 0;
    return getCumulativeDuration(session.segmentDurations, highestContiguous, session.segmentDuration);
  }

  // Native mode - use download progress
  return downloadProgress * session.totalDuration;
}

class SessionRegistry {
  private sessions: Map<SessionKey, HlsSession> = new Map();
  private readonly segmentDuration: number;

  constructor(segmentDuration: number = DEFAULT_HLS_CONFIG.segmentDuration) {
    this.segmentDuration = segmentDuration;
  }

  /**
   * Get or create a session for the given infoHash.
   * Probes the file if a session doesn't exist yet.
   * Optionally accepts download progress for streaming strategy determination.
   */
  async getOrCreateSession(infoHash: string, downloadProgress?: number): Promise<HlsSession> {
    // Get video file info from torrent manager
    const fileInfo = await torrentManager.getVideoFileInfo(infoHash);
    if (!fileInfo) {
      throw new Error('Video file not found');
    }

    // Probe the file to get codec information
    const codecInfo = await probeFile(fileInfo.path);
    const decision = makeTranscodeDecision(codecInfo);
    const sessionKey = buildSessionKey(infoHash, decision.mode);

    // Check if session already exists
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      // Update waiting state if download progress has changed
      if (downloadProgress !== undefined) {
        const containerFormat = getContainerFormat(fileInfo.path);
        const strategy = determineStreamingStrategy(codecInfo, containerFormat, downloadProgress);

        log.debug(`[${existing.sessionKey}] Existing session found. moovAtStart: ${codecInfo.moovAtStart}, progress: ${(downloadProgress * 100).toFixed(1)}%, session.waiting: ${existing.waitingForDownload}, strategy.waiting: ${strategy.waitingForDownload}`);

        // Update waiting state based on new download progress
        if (existing.waitingForDownload && strategy.canTranscodeNow) {
          existing.waitingForDownload = false;
          log.info(`[${existing.sessionKey}] Download progress sufficient, can start transcoding`);
        }

        // Also check if moovAtStart detection changed from null to false
        // This means we now know for certain the file needs full download
        if (!existing.waitingForDownload && strategy.waitingForDownload && codecInfo.moovAtStart === false) {
          existing.waitingForDownload = true;
          existing.useIncompleteFileFlags = false;
          log.info(`[${existing.sessionKey}] moov atom detected at end - now waiting for full download`);

          // Stop any running transcoding since it will fail anyway
          if (existing.isGenerating) {
            log.info(`[${existing.sessionKey}] Stopping transcoding due to moov at end`);
            ffmpegProcess.stopGeneration(existing.sessionKey);
          }
        }
      }
      return existing;
    }

    // Calculate total number of segments
    const totalSegments = Math.ceil(codecInfo.duration / this.segmentDuration);

    // Check for existing segments in cache
    let existingSegments = await segmentCache.getExistingSegments(sessionKey);

    // Validate cache against DB - only trust segments up to DB's highestGeneratedSegment
    // This prevents stale cache files from being served after server restart
    const existingJob = await transcodeJobManager.getJob(infoHash);
    if (existingSegments.length > 0) {
      if (existingJob) {
        const dbHighest = existingJob.highestGeneratedSegment;
        const cacheHighest = Math.max(...existingSegments);

        if (cacheHighest > dbHighest) {
          log.warn(
            `[${sessionKey}] Cache has segments up to ${cacheHighest} but DB shows only ${dbHighest} - invalidating stale segments`,
          );
          // Delete stale cache files
          await segmentCache.deleteSegmentsFrom(sessionKey, dbHighest + 1);
          // Filter existingSegments to only include valid ones
          existingSegments = existingSegments.filter((s) => s <= dbHighest);
        }
      } else {
        // No DB job exists but cache has segments - these are orphaned/stale
        log.warn(
          `[${sessionKey}] Cache has ${existingSegments.length} segments but no DB job exists - clearing stale cache`,
        );
        await segmentCache.deleteSession(sessionKey);
        existingSegments = [];
      }
    }

    // Determine streaming strategy based on codec and container
    const containerFormat = getContainerFormat(fileInfo.path);
    const progress = downloadProgress ?? 0;
    const strategy = determineStreamingStrategy(codecInfo, containerFormat, progress);

    // Create new session
    // Use Set for efficient segment lookup
    const generatedSegmentsSet = new Set(existingSegments);
    // Use contiguous segment count for transcodedDuration to reflect actually playable content
    const highestContiguous = getHighestContiguousSegment(generatedSegmentsSet);

    // Initialize segment durations map (empty for new sessions, existing segments use default)
    const segmentDurations = new Map<number, number>();

    const session: HlsSession = {
      sessionKey,
      infoHash,
      filePath: fileInfo.path,
      codecInfo,
      decision,
      createdAt: new Date(),
      lastAccessedAt: new Date(),
      segmentDuration: this.segmentDuration,
      totalSegments,
      generatedSegments: generatedSegmentsSet,
      segmentDurations,
      // FFmpeg process state
      ffmpegStartSegment: 0,
      highestGeneratedSegment: existingSegments.length > 0 ? Math.max(...existingSegments) : -1,
      isGenerating: false,
      // Progressive transcoding state
      streamingMode: strategy.mode,
      waitingForDownload: strategy.waitingForDownload,
      // Use contiguous segments for duration - existing segments use default duration
      transcodedDuration: highestContiguous >= 0
        ? getCumulativeDuration(segmentDurations, highestContiguous, this.segmentDuration)
        : 0,
      totalDuration: codecInfo.duration,
      containerFormat,
      useIncompleteFileFlags: strategy.useIncompleteFileFlags,
    };

    this.sessions.set(sessionKey, session);

    log.info(
      `[${sessionKey}] Session created (${decision.mode}, ${totalSegments} segments, duration: ${codecInfo.duration.toFixed(1)}s)`,
    );
    log.info(`[${sessionKey}] Initial state: ${existingSegments.length} segments in cache/set`);
    log.debug(`[${sessionKey}] Transcode decision: ${decision.reason}`);
    log.debug(`[${sessionKey}] Container: ${containerFormat}, moovAtStart: ${codecInfo.moovAtStart}, progress: ${(progress * 100).toFixed(1)}%`);
    log.debug(`[${sessionKey}] Streaming strategy: ${strategy.reason}`);
    log.debug(`[${sessionKey}] Waiting for download: ${strategy.waitingForDownload}`);

    // Persist session to database with retry (fire and forget for performance)
    withRetry(
      () => transcodeJobManager.createOrUpdateJob(session),
      { context: `persist session ${sessionKey}` },
    );

    return session;
  }

  /**
   * Get session by key (returns null if not found)
   */
  getSession(sessionKey: SessionKey): HlsSession | null {
    return this.sessions.get(sessionKey) ?? null;
  }

  /**
   * Get session by infoHash (checks all transcode modes)
   */
  getSessionByInfoHash(infoHash: string): HlsSession | null {
    for (const session of this.sessions.values()) {
      if (session.infoHash === infoHash) {
        return session;
      }
    }
    return null;
  }

  /**
   * Update last accessed time for LRU tracking
   */
  touch(sessionKey: SessionKey): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.lastAccessedAt = new Date();
    }
  }

  /**
   * Mark a segment as generated and update transcoded duration.
   * Duration validation should be done by the caller before invoking this.
   * @param duration - Actual segment duration in seconds (optional, defaults to session.segmentDuration)
   */
  markSegmentReady(sessionKey: SessionKey, segmentIndex: number, duration?: number): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.generatedSegments.add(segmentIndex);

      // Store segment duration if provided (caller is responsible for validation)
      if (duration !== undefined) {
        session.segmentDurations.set(segmentIndex, duration);
      }

      // Update transcoded duration based on highest segment
      if (segmentIndex > session.highestGeneratedSegment) {
        session.highestGeneratedSegment = segmentIndex;
        // Use cumulative actual durations for accurate transcodedDuration
        session.transcodedDuration = getCumulativeDuration(
          session.segmentDurations,
          segmentIndex,
          session.segmentDuration,
        );

        // Persist progress to database with retry (fire and forget)
        withRetry(
          () => transcodeJobManager.updateSegmentProgress(session.infoHash, segmentIndex),
          { context: `persist segment ${segmentIndex} for ${sessionKey}` },
        );
      }
    }
  }

  /**
   * Check if a session has a specific segment
   */
  hasSegment(sessionKey: SessionKey, segmentIndex: number): boolean {
    const session = this.sessions.get(sessionKey);
    return session?.generatedSegments.has(segmentIndex) ?? false;
  }

  /**
   * Remove a session from the registry
   */
  removeSession(sessionKey: SessionKey): void {
    this.sessions.delete(sessionKey);
    log.info(`Removed: ${sessionKey}`);
  }

  /**
   * Get all sessions sorted by last access time (oldest first, for LRU eviction)
   */
  getSessionsByLRU(): HlsSession[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => a.lastAccessedAt.getTime() - b.lastAccessedAt.getTime(),
    );
  }

  /**
   * Get all sessions
   */
  getAllSessions(): HlsSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get count of active sessions
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Register an existing session (used for resuming from database)
   */
  registerSession(session: HlsSession): void {
    this.sessions.set(session.sessionKey, session);
    log.info(`Registered: ${session.sessionKey}`);
  }

  /**
   * Update session status in database when transcoding starts
   */
  async markTranscodingStarted(sessionKey: SessionKey): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (session) {
      await transcodeJobManager.markInProgress(session.infoHash);
    }
  }

  /**
   * Update session status in database when transcoding completes
   */
  async markTranscodingCompleted(sessionKey: SessionKey): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (session) {
      await transcodeJobManager.markCompleted(session.infoHash);
    }
  }
}

export const sessionRegistry = new SessionRegistry();
