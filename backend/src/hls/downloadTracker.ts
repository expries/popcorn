import { torrentManager } from '../services/torrentManager';

export interface DownloadProgress {
  downloadedBytes: number;
  contiguousBytes: number;
  totalBytes: number;
  progress: number; // 0-1
  isComplete: boolean;
}

/**
 * Get current download progress for a torrent.
 * Used to determine safe transcoding limits.
 */
export async function getDownloadProgress(infoHash: string): Promise<DownloadProgress | null> {
  const stats = await torrentManager.getTorrentStats(infoHash);
  if (!stats) return null;

  return {
    downloadedBytes: stats.downloaded,
    // For sequential downloads (which we use), downloaded bytes are contiguous
    contiguousBytes: stats.downloaded,
    totalBytes: stats.totalSize,
    progress: stats.progress,
    isComplete: stats.progress >= 1.0,
  };
}

/**
 * Check if download has reached minimum threshold for progressive transcoding.
 */
export async function canStartProgressiveTranscode(
  infoHash: string,
  minimumProgressPercent: number,
): Promise<boolean> {
  const progress = await getDownloadProgress(infoHash);
  if (!progress) return false;
  return progress.progress >= minimumProgressPercent / 100;
}

/**
 * Calculate safe transcoding duration based on download progress.
 * Stays behind download by a safety margin to prevent EOF errors.
 */
export function calculateSafeTranscodeDuration(
  downloadProgress: number,
  totalDuration: number,
  safetyMarginSeconds: number,
): number {
  const downloadedDuration = downloadProgress * totalDuration;
  return Math.max(0, downloadedDuration - safetyMarginSeconds);
}
