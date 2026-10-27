import { useState, useEffect, useCallback, useRef } from 'react';

import { STREAM_SERVER_URL } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('SSE');

export interface ProgressData {
  downloadProgress: number;
  downloadedBytes: number;
  totalBytes: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  transcodeProgress?: number;
  transcodedDuration?: number;
  transcodedSegments?: number;
  totalSegments?: number;
  streamingMode: 'hls' | 'native';
  waitingForDownload?: boolean;
  canSeekTo: number;
  isTranscoding: boolean;
  isDownloading: boolean;
}

interface UseProgressSSEResult {
  progress: ProgressData | null;
  isConnected: boolean;
  connectionError: string | null;
  reconnect: () => void;
}

export function useProgressSSE(
  infoHash: string | null,
  enabled = true,
): UseProgressSSEResult {
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);

  const connect = useCallback(() => {
    if (!infoHash || !enabled) return;

    // Clean up existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const url = `${STREAM_SERVER_URL}/stream/${infoHash}/progress`;
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.addEventListener('connected', () => {
      setIsConnected(true);
      setConnectionError(null);
      reconnectAttemptsRef.current = 0;
      log.info(`Connected to progress stream for ${infoHash}`);
    });

    eventSource.addEventListener('progress', (event) => {
      try {
        const data = JSON.parse(event.data) as ProgressData;
        setProgress(data);
      } catch (e) {
        log.error('Failed to parse progress data:', e);
      }
    });

    eventSource.addEventListener('error', (event) => {
      log.error('Connection error:', event);
      setIsConnected(false);
      setConnectionError('Connection lost');

      // Exponential backoff for reconnection
      const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
      reconnectAttemptsRef.current++;

      log.debug(`Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`);
      reconnectTimeoutRef.current = setTimeout(connect, delay);
    });

    eventSource.onerror = () => {
      // EventSource automatically reconnects, but we want to track the state
      eventSource.close();
    };
  }, [infoHash, enabled]);

  useEffect(() => {
    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
  }, [connect]);

  return {
    progress,
    isConnected,
    connectionError,
    reconnect: connect,
  };
}
