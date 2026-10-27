import { mkdir, readdir, readFile, rename, rm, stat } from 'fs/promises';
import { join, resolve, relative } from 'path';

import { createLogger } from '../utils/logger';
import type { SessionKey } from './types';
import { DEFAULT_HLS_CONFIG } from './types';

const log = createLogger('Cache');

const SEGMENT_STABILITY_CHECKS = 2;
const SEGMENT_STABILITY_INTERVAL_MS = 150;

// Valid session key pattern: alphanumeric hash + underscore + transcode mode
const VALID_SESSION_KEY_PATTERN = /^[a-fA-F0-9]+_(copy|audio_only|full)$/;

class SegmentCache {
  private readonly basePath: string;

  constructor(basePath: string = DEFAULT_HLS_CONFIG.cachePath) {
    this.basePath = basePath;
  }

  /**
   * Validate a session key to prevent path traversal attacks.
   * Session keys should only contain alphanumeric characters, underscores,
   * and follow the pattern: {infoHash}_{transcodeMode}
   */
  private validateSessionKey(sessionKey: SessionKey): void {
    if (!VALID_SESSION_KEY_PATTERN.test(sessionKey)) {
      throw new Error(`Invalid session key format: ${sessionKey}`);
    }
  }

  /**
   * Validate that a resolved path is within the base path (defense in depth)
   */
  private validatePath(targetPath: string): void {
    const resolvedBase = resolve(this.basePath);
    const resolvedTarget = resolve(targetPath);
    const relativePath = relative(resolvedBase, resolvedTarget);

    // Path traversal detected if relative path starts with '..' or is absolute
    if (relativePath.startsWith('..') || resolve(relativePath) === relativePath) {
      throw new Error(`Path traversal detected: ${targetPath}`);
    }
  }

  /**
   * Get the cache directory path for a session
   */
  getSessionDir(sessionKey: SessionKey): string {
    this.validateSessionKey(sessionKey);
    const dir = join(this.basePath, sessionKey);
    this.validatePath(dir);
    return dir;
  }

  /**
   * Get the file path for a specific segment
   */
  getSegmentPath(sessionKey: SessionKey, segmentIndex: number): string {
    return join(this.basePath, sessionKey, `segment_${segmentIndex}.ts`);
  }

  /**
   * Get the temp file path for a segment being written
   */
  getTempSegmentPath(sessionKey: SessionKey, segmentIndex: number): string {
    return join(this.basePath, sessionKey, `segment_${segmentIndex}.ts.tmp`);
  }

  /**
   * Check if a segment file exists on disk (final file, not temp)
   */
  async segmentExists(sessionKey: SessionKey, segmentIndex: number): Promise<boolean> {
    const path = this.getSegmentPath(sessionKey, segmentIndex);
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Rename a temp segment file to its final name (atomic operation)
   */
  async finalizeSegment(sessionKey: SessionKey, segmentIndex: number): Promise<boolean> {
    const tempPath = this.getTempSegmentPath(sessionKey, segmentIndex);
    const finalPath = this.getSegmentPath(sessionKey, segmentIndex);
    try {
      await rename(tempPath, finalPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Wait for a segment to be fully written and stable
   * Returns true if segment is ready, false if timeout
   */
  async waitForCompleteSegment(
    sessionKey: SessionKey,
    segmentIndex: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const path = this.getSegmentPath(sessionKey, segmentIndex);
    const startTime = Date.now();
    let lastSize = -1;
    let stableCount = 0;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const stats = await stat(path);
        if (stats.size > 0 && stats.size === lastSize) {
          stableCount++;
          if (stableCount >= SEGMENT_STABILITY_CHECKS) {
            return true; // File is stable
          }
        } else {
          stableCount = 0;
          lastSize = stats.size;
        }
      } catch {
        // File doesn't exist yet, reset stability counter
        stableCount = 0;
        lastSize = -1;
      }
      await new Promise((resolve) => setTimeout(resolve, SEGMENT_STABILITY_INTERVAL_MS));
    }

    return false;
  }

  /**
   * Finalize all temp segments in a session directory
   */
  async finalizeAllTempSegments(sessionKey: SessionKey): Promise<number[]> {
    const dir = this.getSessionDir(sessionKey);
    const finalized: number[] = [];

    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (file.endsWith('.ts.tmp')) {
          const match = file.match(/segment_(\d+)\.ts\.tmp/);
          if (match) {
            const segmentIndex = parseInt(match[1], 10);
            const success = await this.finalizeSegment(sessionKey, segmentIndex);
            if (success) {
              finalized.push(segmentIndex);
            }
          }
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }

    return finalized;
  }

  /**
   * Read a segment file from cache
   */
  async readSegment(sessionKey: SessionKey, segmentIndex: number): Promise<Buffer | null> {
    const path = this.getSegmentPath(sessionKey, segmentIndex);
    try {
      return await readFile(path);
    } catch {
      return null;
    }
  }

  /**
   * Get all existing segment indices for a session
   */
  async getExistingSegments(sessionKey: SessionKey): Promise<number[]> {
    const dir = this.getSessionDir(sessionKey);
    try {
      const files = await readdir(dir);
      return files
        .filter((f) => f.startsWith('segment_') && f.endsWith('.ts'))
        .map((f) => {
          const match = f.match(/segment_(\d+)\.ts/);
          return match ? parseInt(match[1], 10) : -1;
        })
        .filter((n) => n >= 0)
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  /**
   * Get cache statistics for a session
   */
  async getSessionStats(
    sessionKey: SessionKey,
  ): Promise<{ segmentCount: number; totalBytes: number }> {
    const dir = this.getSessionDir(sessionKey);
    try {
      const files = await readdir(dir);
      let totalBytes = 0;
      let segmentCount = 0;

      for (const file of files) {
        if (file.endsWith('.ts')) {
          const fileStat = await stat(join(dir, file));
          totalBytes += fileStat.size;
          segmentCount++;
        }
      }

      return { segmentCount, totalBytes };
    } catch {
      return { segmentCount: 0, totalBytes: 0 };
    }
  }

  /**
   * Delete all cached data for a session
   */
  async deleteSession(sessionKey: SessionKey): Promise<void> {
    const dir = this.getSessionDir(sessionKey);
    try {
      await rm(dir, { recursive: true, force: true });
      log.info(`Deleted session: ${sessionKey}`);
    } catch (err) {
      log.error(`Failed to delete session ${sessionKey}:`, err);
    }
  }

  /**
   * Delete a single segment.
   */
  async deleteSegment(sessionKey: SessionKey, segmentIndex: number): Promise<boolean> {
    const segmentPath = join(this.getSessionDir(sessionKey), `segment_${segmentIndex}.ts`);
    try {
      await rm(segmentPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete all segments at or after a given index.
   * This is used to invalidate stale segments when restarting transcoding.
   * Returns the number of segments deleted.
   */
  async deleteSegmentsFrom(sessionKey: SessionKey, fromSegment: number): Promise<number> {
    const dir = this.getSessionDir(sessionKey);
    let deletedCount = 0;
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (file.startsWith('segment_') && file.endsWith('.ts')) {
          const match = file.match(/segment_(\d+)\.ts/);
          if (match) {
            const segmentIndex = parseInt(match[1], 10);
            if (segmentIndex >= fromSegment) {
              await rm(join(dir, file), { force: true });
              deletedCount++;
            }
          }
        }
      }
      if (deletedCount > 0) {
        log.info(`[${sessionKey}] Deleted ${deletedCount} stale segments (>= ${fromSegment})`);
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
    return deletedCount;
  }

  /**
   * Ensure the cache base directory exists
   */
  async ensureCacheDir(): Promise<void> {
    await mkdir(this.basePath, { recursive: true });
  }

  /**
   * Ensure the session directory exists
   */
  async ensureSessionDir(sessionKey: SessionKey): Promise<string> {
    const dir = this.getSessionDir(sessionKey);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Ensure a directory exists (for temp directories)
   */
  async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  /**
   * Get all session keys in the cache
   */
  async getAllSessionKeys(): Promise<SessionKey[]> {
    try {
      const entries = await readdir(this.basePath, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Get total cache size across all sessions
   */
  async getTotalCacheSize(): Promise<number> {
    try {
      const sessions = await this.getAllSessionKeys();
      let total = 0;

      for (const session of sessions) {
        const stats = await this.getSessionStats(session);
        total += stats.totalBytes;
      }

      return total;
    } catch {
      return 0;
    }
  }
}

export const segmentCache = new SegmentCache();
