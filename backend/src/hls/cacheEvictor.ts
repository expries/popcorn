import { existsSync } from 'fs';

import { transcodeJobManager } from '../services/transcodeJobManager';
import { torrentManager } from '../services/torrentManager';
import { createLogger } from '../utils/logger';

import { ffmpegProcess } from './ffmpegProcess';
import { segmentCache } from './segmentCache';
import { sessionRegistry } from './sessionRegistry';
import type { HlsSession } from './types';
import { DEFAULT_HLS_CONFIG } from './types';

const log = createLogger('CacheEvictor');

interface EvictorConfig {
  maxCacheSizeBytes: number;
  sessionMaxAgeMs: number;
  checkIntervalMs: number;
  minFreeSpaceBytes: number;
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let unitIndex = 0;
  let value = bytes;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

class CacheEvictor {
  private config: EvictorConfig;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<EvictorConfig> = {}) {
    this.config = {
      maxCacheSizeBytes: config.maxCacheSizeBytes ?? DEFAULT_HLS_CONFIG.maxCacheSizeBytes,
      sessionMaxAgeMs: config.sessionMaxAgeMs ?? DEFAULT_HLS_CONFIG.sessionMaxAgeMs,
      checkIntervalMs: config.checkIntervalMs ?? DEFAULT_HLS_CONFIG.evictionIntervalMs,
      minFreeSpaceBytes: config.minFreeSpaceBytes ?? 1 * 1024 * 1024 * 1024, // 1GB
    };
  }

  /**
   * Start periodic eviction checks
   */
  start(): void {
    if (this.intervalId) {
      log.warn('Already running');
      return;
    }

    log.info('Starting with config:', {
      maxCacheSize: formatBytes(this.config.maxCacheSizeBytes),
      sessionMaxAge: `${this.config.sessionMaxAgeMs / 1000 / 60} minutes`,
      checkInterval: `${this.config.checkIntervalMs / 1000 / 60} minutes`,
    });

    // Run immediately on start
    this.evict().catch((err) => log.error('Initial eviction error:', err));

    // Schedule periodic checks
    this.intervalId = setInterval(() => {
      this.evict().catch((err) => log.error('Eviction error:', err));
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop periodic eviction
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      log.info('Stopped');
    }
  }

  /**
   * Run eviction logic
   */
  async evict(): Promise<{ expiredSessions: number; lruSessions: number; freedBytes: number; resumedSessions: number }> {
    log.debug('Running eviction check...');

    let expiredSessions = 0;
    let lruSessions = 0;
    let freedBytes = 0;
    let resumedSessions = 0;

    // Step 1: Handle expired sessions (resume incomplete or skip completed)
    const expiredResult = await this.handleExpiredSessions();
    expiredSessions = expiredResult.evictedCount;
    resumedSessions = expiredResult.resumedCount;
    freedBytes += expiredResult.freedBytes;

    // Step 2: Evict LRU sessions if over size limit
    const lruResult = await this.evictLRUIfOverLimit();
    lruSessions = lruResult.count;
    freedBytes += lruResult.freedBytes;

    if (expiredSessions > 0 || lruSessions > 0 || resumedSessions > 0) {
      log.info(
        `Evicted ${expiredSessions} expired + ${lruSessions} LRU sessions, resumed ${resumedSessions} sessions, freed ${formatBytes(freedBytes)}`,
      );
    } else {
      log.debug('No sessions to evict or resume');
    }

    return { expiredSessions, lruSessions, freedBytes, resumedSessions };
  }

  /**
   * Check if a session's transcode job is completed (should not be evicted)
   */
  private async isTranscodeCompleted(infoHash: string): Promise<boolean> {
    const job = await transcodeJobManager.getJob(infoHash);
    return job?.status === 'completed';
  }

  /**
   * Attempt to resume an incomplete transcode session.
   * Returns true if resumption was successful, false if session should be evicted.
   */
  private async tryResumeSession(session: HlsSession): Promise<boolean> {
    // Check if the source file still exists
    if (!existsSync(session.filePath)) {
      log.info(`Source file no longer exists for ${session.sessionKey}, will evict`);
      await transcodeJobManager.markFailed(session.infoHash);
      return false;
    }

    // Check if torrent is still in Transmission
    const torrentStats = await torrentManager.getTorrentStats(session.infoHash);
    if (!torrentStats) {
      log.info(`Torrent no longer exists for ${session.sessionKey}, will evict`);
      await transcodeJobManager.markFailed(session.infoHash);
      return false;
    }

    // Check if already complete
    if (session.highestGeneratedSegment >= session.totalSegments - 1) {
      log.info(`Transcode for ${session.sessionKey} is already complete, marking as completed`);
      await transcodeJobManager.markCompleted(session.infoHash);
      return true;
    }

    // Check if we can transcode (download complete or supports progressive)
    if (torrentStats.progress < 1.0 && !session.useIncompleteFileFlags) {
      log.debug(`Waiting for download to complete for ${session.sessionKey}`);
      session.waitingForDownload = true;
      session.lastAccessedAt = new Date(); // Reset the timer
      return true;
    }

    // Resume transcoding from the next segment
    const nextSegment = session.highestGeneratedSegment + 1;
    log.info(`Resuming transcode for ${session.sessionKey} from segment ${nextSegment}`);

    session.lastAccessedAt = new Date(); // Reset the timer
    session.waitingForDownload = false;

    await ffmpegProcess.startGeneration(session, nextSegment, torrentStats.progress);
    await transcodeJobManager.markInProgress(session.infoHash);

    return true;
  }

  /**
   * Handle expired sessions: resume incomplete transcodes or skip completed ones
   */
  private async handleExpiredSessions(): Promise<{ evictedCount: number; resumedCount: number; freedBytes: number }> {
    const sessions = sessionRegistry.getSessionsByLRU();
    const now = Date.now();
    let evictedCount = 0;
    let resumedCount = 0;
    let freedBytes = 0;

    for (const session of sessions) {
      const age = now - session.lastAccessedAt.getTime();

      if (age > this.config.sessionMaxAgeMs) {
        // Skip eviction for completed transcodes
        if (await this.isTranscodeCompleted(session.infoHash)) {
          log.debug(`Skipping completed transcode: ${session.sessionKey}`);
          continue;
        }

        const ageMinutes = Math.round(age / 1000 / 60);

        // Try to resume incomplete transcodes
        if (!session.isGenerating) {
          log.info(`Attempting to resume idle session: ${session.sessionKey} (age: ${ageMinutes} min)`);

          try {
            const resumed = await this.tryResumeSession(session);
            if (resumed) {
              resumedCount++;
              continue;
            }
          } catch (error) {
            log.error(`Failed to resume ${session.sessionKey}:`, error);
            await transcodeJobManager.markFailed(session.infoHash);
          }
        }

        // If we get here, evict the session
        log.info(`Evicting session: ${session.sessionKey} (age: ${ageMinutes} min)`);

        // Get size before deletion
        const stats = await segmentCache.getSessionStats(session.sessionKey);
        freedBytes += stats.totalBytes;

        // Kill any running FFmpeg process
        ffmpegProcess.stopGeneration(session.sessionKey);

        // Delete cached files
        await segmentCache.deleteSession(session.sessionKey);

        // Remove from registry
        sessionRegistry.removeSession(session.sessionKey);

        evictedCount++;
      }
    }

    return { evictedCount, resumedCount, freedBytes };
  }

  /**
   * Evict LRU sessions if cache size exceeds limit
   */
  private async evictLRUIfOverLimit(): Promise<{ count: number; freedBytes: number }> {
    let totalSize = await segmentCache.getTotalCacheSize();
    let count = 0;
    let freedBytes = 0;

    if (totalSize <= this.config.maxCacheSizeBytes) {
      return { count, freedBytes };
    }

    log.warn(
      `Cache over limit: ${formatBytes(totalSize)} > ${formatBytes(this.config.maxCacheSizeBytes)}`,
    );

    // Get sessions sorted by LRU (least recently used first)
    const sessions = sessionRegistry.getSessionsByLRU();

    for (const session of sessions) {
      // Stop when we have enough free space
      if (totalSize <= this.config.maxCacheSizeBytes - this.config.minFreeSpaceBytes) {
        break;
      }

      // Skip eviction for completed transcodes
      if (await this.isTranscodeCompleted(session.infoHash)) {
        log.debug(`Skipping completed transcode: ${session.sessionKey}`);
        continue;
      }

      const stats = await segmentCache.getSessionStats(session.sessionKey);

      log.info(`Evicting LRU session: ${session.sessionKey} (${formatBytes(stats.totalBytes)})`);

      // Kill any running FFmpeg process
      ffmpegProcess.stopGeneration(session.sessionKey);

      // Delete cached files
      await segmentCache.deleteSession(session.sessionKey);

      // Remove from registry
      sessionRegistry.removeSession(session.sessionKey);

      totalSize -= stats.totalBytes;
      freedBytes += stats.totalBytes;
      count++;
    }

    return { count, freedBytes };
  }

  /**
   * Get current cache statistics
   */
  async getStats(): Promise<{
    sessionCount: number;
    totalSize: string;
    maxSize: string;
    utilizationPercent: number;
  }> {
    const totalSize = await segmentCache.getTotalCacheSize();
    return {
      sessionCount: sessionRegistry.getSessionCount(),
      totalSize: formatBytes(totalSize),
      maxSize: formatBytes(this.config.maxCacheSizeBytes),
      utilizationPercent: Math.round((totalSize / this.config.maxCacheSizeBytes) * 100),
    };
  }
}

export const cacheEvictor = new CacheEvictor();
