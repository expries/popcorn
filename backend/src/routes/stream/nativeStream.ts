import type { Readable } from 'stream';

import { torrentManager } from '../../services/torrentManager';
import { videoRangeResponse, videoStreamResponse } from './responses';

interface FileInfo {
  name: string;
  path: string;
  size: number;
}

function getMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'webm') return 'video/webm';
  if (ext === 'ogv') return 'video/ogg';
  return 'video/mp4';
}

function nodeStreamToWeb(stream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      stream.on('end', () => {
        controller.close();
      });
      stream.on('error', (err: Error) => {
        console.error('[Stream] Error:', err.message);
        controller.error(err);
      });
    },
    cancel() {
      stream.destroy();
    },
  });
}

export async function handleNativeStream(
  infoHash: string,
  fileInfo: FileInfo,
  rangeHeader: string | null,
): Promise<Response> {
  const fileSize = fileInfo.size;
  const mimeType = getMimeType(fileInfo.name);

  console.log(`[NativeStream] Request for ${fileInfo.name}, size=${fileSize}, range=${rangeHeader}`);

  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 10 * 1024 * 1024, fileSize - 1);

    console.log(`[NativeStream] Range request: bytes ${start}-${end}/${fileSize}`);

    const result = await torrentManager.createVideoStream(infoHash, start, end);
    if (!result) {
      console.error(`[NativeStream] Failed to create stream for range ${start}-${end}`);
      return new Response('Failed to create stream', { status: 500 });
    }

    console.log(`[NativeStream] Serving range ${start}-${end}, chunk size=${end - start + 1}`);
    return videoRangeResponse(nodeStreamToWeb(result.stream), start, end, fileSize, mimeType);
  }

  console.log(`[NativeStream] Full file request (no range header)`);
  const result = await torrentManager.createVideoStream(infoHash);
  if (!result) {
    console.error(`[NativeStream] Failed to create full stream`);
    return new Response('Failed to create stream', { status: 500 });
  }

  return videoStreamResponse(nodeStreamToWeb(result.stream), fileSize, mimeType);
}
