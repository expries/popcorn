import { stat } from 'fs/promises';
import { join } from 'path';

export interface VideoFileInfo {
  name: string;
  path: string;
  size: number;
}

interface TorrentFile {
  name: string;
  length: number;
  bytesCompleted: number;
}

const VIDEO_EXTENSIONS = /\.(mp4|mkv|webm|avi|mov|m4v|ogv)$/i;
const LOCAL_DOWNLOADS_PATH = process.env.TORRENT_DOWNLOAD_PATH ?? '../transmission/downloads';

export function findLargestVideoFile(files: TorrentFile[]): TorrentFile | null {
  const videoFiles = files.filter((file) => VIDEO_EXTENSIONS.test(file.name));
  if (videoFiles.length === 0) return null;
  return videoFiles.reduce((largest, file) => (file.length > largest.length ? file : largest));
}

export async function resolveVideoPath(fileName: string): Promise<string | null> {
  // Use local downloads path (Transmission returns /downloads which is its Docker path)
  const basePath = join(LOCAL_DOWNLOADS_PATH, fileName);
  const partPath = basePath + '.part';

  // Check for .part file first (incomplete download), then complete file
  const candidates = [partPath, basePath];

  for (const path of candidates) {
    try {
      await stat(path);
      return path;
    } catch {
      continue;
    }
  }

  // File not found yet - torrent may still be initializing
  return null;
}

export function extractFileName(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}
