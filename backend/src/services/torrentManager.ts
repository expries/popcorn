import { createReadStream } from 'fs';
import type { Readable } from 'stream';

import { transmissionClient, TorrentStatus } from '../clients/transmission/transmissionClient';
import { scanDownloadsDirectory } from './directoryScanner';
import {
  extractFileName,
  findLargestVideoFile,
  resolveVideoPath,
  type VideoFileInfo,
} from './videoFileResolver';

export type { VideoFileInfo };

export type DownloadedRange = {
  start: number; // fraction 0-1
  end: number;   // fraction 0-1
};

export type PieceProgress = {
  pieceCount: number;
  pieceSize: number;
  downloadedRanges: DownloadedRange[];
};

export type TorrentStats = {
  infoHash: string;
  name: string;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  downloaded: number;
  uploaded: number;
  totalSize: number;
  eta: number;
  status: 'downloading' | 'seeding' | 'stopped' | 'checking' | 'queued';
  isFinished: boolean;
};

type TransmissionTorrent = {
  id: number;
  name: string;
  hashString: string;
  status: number;
  percentDone: number;
  rateDownload: number;
  rateUpload: number;
  peersConnected: number;
  totalSize: number;
  downloadedEver: number;
  uploadedEver: number;
  eta: number;
  isFinished: boolean;
  files: Array<{ name: string; length: number; bytesCompleted: number }>;
  downloadDir: string;
  pieceCount?: number;
  pieceSize?: number;
  pieces?: string; // base64-encoded bitfield
};

const TORRENT_FIELDS = [
  'id', 'name', 'hashString', 'status', 'percentDone',
  'rateDownload', 'rateUpload', 'peersConnected', 'totalSize',
  'downloadedEver', 'uploadedEver', 'eta', 'isFinished', 'files', 'downloadDir',
  'pieceCount', 'pieceSize', 'pieces',
] as const;

function decodePiecesBitfield(base64Pieces: string): boolean[] {
  const buffer = Buffer.from(base64Pieces, 'base64');
  const pieces: boolean[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    for (let bit = 7; bit >= 0; bit--) {
      pieces.push(((byte >> bit) & 1) === 1);
    }
  }
  return pieces;
}

function calculateDownloadedRanges(
  pieces: boolean[],
  pieceSize: number,
  fileOffset: number,
  fileSize: number,
  totalSize: number,
): DownloadedRange[] {
  const ranges: DownloadedRange[] = [];
  const fileEnd = fileOffset + fileSize;

  // Find pieces that overlap with this file
  const firstPiece = Math.floor(fileOffset / pieceSize);
  const lastPiece = Math.min(Math.ceil(fileEnd / pieceSize), pieces.length - 1);

  let rangeStart: number | null = null;

  for (let i = firstPiece; i <= lastPiece; i++) {
    const pieceStart = i * pieceSize;
    const pieceEnd = Math.min((i + 1) * pieceSize, totalSize);

    // Calculate overlap with the file
    const overlapStart = Math.max(pieceStart, fileOffset);
    const overlapEnd = Math.min(pieceEnd, fileEnd);

    if (overlapStart >= overlapEnd) continue;

    // Convert to fraction of file
    const startFraction = (overlapStart - fileOffset) / fileSize;
    const endFraction = (overlapEnd - fileOffset) / fileSize;

    if (pieces[i]) {
      // Piece is downloaded
      if (rangeStart === null) {
        rangeStart = startFraction;
      }
      // Check if this is the last piece or next piece is not downloaded
      if (i === lastPiece || !pieces[i + 1]) {
        ranges.push({ start: rangeStart, end: endFraction });
        rangeStart = null;
      }
    } else if (rangeStart !== null) {
      // End the current range
      ranges.push({ start: rangeStart, end: startFraction });
      rangeStart = null;
    }
  }

  return ranges;
}

function mapStatus(status: number): TorrentStats['status'] {
  switch (status) {
    case TorrentStatus.STOPPED: return 'stopped';
    case TorrentStatus.CHECK_WAIT:
    case TorrentStatus.CHECK: return 'checking';
    case TorrentStatus.DOWNLOAD_WAIT: return 'queued';
    case TorrentStatus.DOWNLOAD: return 'downloading';
    case TorrentStatus.SEED_WAIT:
    case TorrentStatus.SEED: return 'seeding';
    default: return 'stopped';
  }
}

function torrentToStats(torrent: TransmissionTorrent): TorrentStats {
  return {
    infoHash: torrent.hashString,
    name: torrent.name,
    progress: torrent.percentDone,
    downloadSpeed: torrent.rateDownload,
    uploadSpeed: torrent.rateUpload,
    numPeers: torrent.peersConnected,
    downloaded: torrent.downloadedEver,
    uploaded: torrent.uploadedEver,
    totalSize: torrent.totalSize,
    eta: torrent.eta,
    status: mapStatus(torrent.status),
    isFinished: torrent.isFinished || torrent.percentDone === 1,
  };
}

class TorrentManager {
  private async getTorrentByHash(hash: string): Promise<TransmissionTorrent | null> {
    const result = await transmissionClient.listTorrents(undefined, TORRENT_FIELDS as unknown as string[]);
    const torrents = result.arguments.torrents as TransmissionTorrent[];
    return torrents.find((t) => t.hashString.toLowerCase() === hash.toLowerCase()) ?? null;
  }

  async addTorrent(magnetUri: string): Promise<TorrentStats> {
    const result = await transmissionClient.addMagnet(magnetUri);

    if (result.result !== 'success') {
      throw new Error(`Failed to add torrent: ${result.result}`);
    }

    const added = result.arguments['torrent-added'] ?? result.arguments['torrent-duplicate'];
    if (!added) {
      throw new Error('Failed to add torrent: no torrent info returned');
    }

    console.log(`[Torrent] Added: ${added.name} (${added.hashString})`);

    // Enable sequential download for streaming (requires Transmission 4.1+)
    try {
      await transmissionClient.setTorrent(added.id, { sequential_download: true } as any);
      console.log(`[Torrent] Enabled sequential download for: ${added.hashString}`);
    } catch (err) {
      console.warn(`[Torrent] Sequential download not available (requires Transmission 4.1+):`, err);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const torrent = await this.getTorrentByHash(added.hashString);
    if (!torrent) {
      throw new Error('Failed to get torrent after adding');
    }

    return torrentToStats(torrent);
  }

  async getTorrentStats(infoHash: string): Promise<TorrentStats | null> {
    const torrent = await this.getTorrentByHash(infoHash);
    return torrent ? torrentToStats(torrent) : null;
  }

  async getAllStats(): Promise<TorrentStats[]> {
    const result = await transmissionClient.listTorrents(undefined, TORRENT_FIELDS as unknown as string[]);
    const torrents = result.arguments.torrents as TransmissionTorrent[];
    return torrents.map(torrentToStats);
  }

  async pauseTorrent(infoHash: string): Promise<boolean> {
    const torrent = await this.getTorrentByHash(infoHash);
    if (!torrent) return false;
    await transmissionClient.pauseTorrent(torrent.id);
    console.log(`[Torrent] Paused: ${infoHash}`);
    return true;
  }

  async resumeTorrent(infoHash: string): Promise<boolean> {
    const torrent = await this.getTorrentByHash(infoHash);
    if (!torrent) return false;
    await transmissionClient.resumeTorrent(torrent.id);
    console.log(`[Torrent] Resumed: ${infoHash}`);
    return true;
  }

  async removeTorrent(infoHash: string, deleteData = false): Promise<boolean> {
    const torrent = await this.getTorrentByHash(infoHash);
    if (!torrent) return false;
    await transmissionClient.removeTorrent(torrent.id, deleteData);
    console.log(`[Torrent] Removed: ${infoHash} (deleteData: ${deleteData})`);
    return true;
  }

  async getVideoFileInfo(infoHash: string): Promise<VideoFileInfo | null> {
    const torrent = await this.getTorrentByHash(infoHash);
    if (!torrent) return null;

    const largestVideo = findLargestVideoFile(torrent.files);
    if (!largestVideo) return null;

    const fullPath = await resolveVideoPath(largestVideo.name);
    if (!fullPath) return null; // File not available yet (torrent still initializing)

    return {
      name: extractFileName(largestVideo.name),
      path: fullPath,
      size: largestVideo.length,
    };
  }

  async createVideoStream(
    infoHash: string,
    start?: number,
    end?: number,
  ): Promise<{ stream: Readable; fileInfo: VideoFileInfo } | null> {
    const fileInfo = await this.getVideoFileInfo(infoHash);
    if (!fileInfo) return null;

    const actualEnd = end ?? fileInfo.size - 1;
    const stream = createReadStream(fileInfo.path, {
      start: start ?? 0,
      end: actualEnd,
    });

    return { stream, fileInfo };
  }

  async isFileAvailable(infoHash: string): Promise<boolean> {
    const fileInfo = await this.getVideoFileInfo(infoHash);
    return fileInfo !== null;
  }

  async getCompletedDownloads(): Promise<TorrentStats[]> {
    const allStats = await this.getAllStats();
    return allStats.filter((t) => t.progress === 1);
  }

  async scanDownloadsDirectory(): Promise<VideoFileInfo[]> {
    return scanDownloadsDirectory();
  }

  async getVideoPieceProgress(infoHash: string): Promise<PieceProgress | null> {
    const torrent = await this.getTorrentByHash(infoHash);
    if (!torrent || !torrent.pieces || !torrent.pieceSize || !torrent.pieceCount) {
      return null;
    }

    const largestVideo = findLargestVideoFile(torrent.files);
    if (!largestVideo) return null;

    // Calculate file offset (sum of all files before this one)
    let fileOffset = 0;
    for (const file of torrent.files) {
      if (file.name === largestVideo.name) break;
      fileOffset += file.length;
    }

    const pieces = decodePiecesBitfield(torrent.pieces);
    const downloadedRanges = calculateDownloadedRanges(
      pieces,
      torrent.pieceSize,
      fileOffset,
      largestVideo.length,
      torrent.totalSize,
    );

    return {
      pieceCount: torrent.pieceCount,
      pieceSize: torrent.pieceSize,
      downloadedRanges,
    };
  }
}

export const torrentManager = new TorrentManager();
