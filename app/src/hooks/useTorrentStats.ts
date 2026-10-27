import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useProgressSSE } from './useProgressSSE';
import { STREAM_SERVER_URL } from '../config';

export interface DownloadedRange {
  start: number; // fraction 0-1
  end: number; // fraction 0-1
}

export interface CodecInfo {
  videoCodec: string | null;
  audioCodec: string | null;
  videoBitrate: number | null;
  audioBitrate: number | null;
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  videoProfile: string | null;
  videoLevel: number | null;
  pixelFormat: string | null;
  moovAtStart: boolean | null;
}

export interface TorrentStats {
  infoHash: string;
  name: string;
  fileName?: string;
  fileSize?: number;
  duration?: number;
  requiresHls?: boolean;
  hlsUrl?: string;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  totalSize?: number;
  downloadedRanges?: DownloadedRange[] | null;
  codecInfo?: CodecInfo | null;
  // New fields for streaming while downloading
  streamingMode?: 'hls' | 'native';
  waitingForDownload?: boolean;
  transcodeProgress?: number;
  transcodedDuration?: number;
  canSeekTo?: number;
  isTranscoding?: boolean;
}

async function fetchTorrentStats(infoHash: string): Promise<TorrentStats | null> {
  const response = await fetch(`${STREAM_SERVER_URL}/stats/${infoHash}`);
  if (!response.ok) return null;
  return response.json();
}

export function useTorrentStats(infoHash: string | null) {
  // One-time fetch for static data (codec info, file name, etc.)
  const staticQuery = useQuery({
    queryKey: ['torrentStatsStatic', infoHash],
    queryFn: () => fetchTorrentStats(infoHash!),
    enabled: !!infoHash,
    staleTime: Infinity,
    refetchInterval: false,
  });

  // Real-time updates via SSE
  const { progress: realtimeProgress, isConnected } = useProgressSSE(infoHash);

  // Merge static data with real-time updates
  const mergedStats = useMemo(() => {
    if (!staticQuery.data) return null;
    if (!realtimeProgress) return staticQuery.data;

    return {
      ...staticQuery.data,
      progress: realtimeProgress.downloadProgress,
      downloadSpeed: realtimeProgress.downloadSpeed,
      uploadSpeed: realtimeProgress.uploadSpeed,
      numPeers: realtimeProgress.numPeers,
      transcodeProgress: realtimeProgress.transcodeProgress,
      transcodedDuration: realtimeProgress.transcodedDuration,
      canSeekTo: realtimeProgress.canSeekTo,
      streamingMode: realtimeProgress.streamingMode,
      // Use SSE value if available, otherwise fall back to static data
      waitingForDownload: realtimeProgress.waitingForDownload ?? staticQuery.data.waitingForDownload,
      isTranscoding: realtimeProgress.isTranscoding,
    };
  }, [staticQuery.data, realtimeProgress]);

  return {
    data: mergedStats,
    isLoading: staticQuery.isLoading,
    isConnected,
  };
}
