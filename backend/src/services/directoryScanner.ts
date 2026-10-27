import { readdir, stat } from 'fs/promises';
import { join } from 'path';

import type { VideoFileInfo } from './videoFileResolver';

const DOWNLOADS_PATH = process.env.TORRENT_DOWNLOAD_PATH ?? '../transmission/downloads';
const VIDEO_EXTENSIONS = /\.(mp4|mkv|webm|avi|mov|m4v|ogv)$/i;

async function scanDirectory(dir: string): Promise<VideoFileInfo[]> {
  const videos: VideoFileInfo[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        const subDirVideos = await scanDirectory(fullPath);
        videos.push(...subDirVideos);
      } else if (VIDEO_EXTENSIONS.test(entry.name)) {
        const stats = await stat(fullPath);
        videos.push({
          name: entry.name,
          path: fullPath,
          size: stats.size,
        });
      }
    }
  } catch (error) {
    console.error(`[Torrent] Error scanning directory ${dir}:`, error);
  }

  return videos;
}

export async function scanDownloadsDirectory(): Promise<VideoFileInfo[]> {
  return scanDirectory(DOWNLOADS_PATH);
}
