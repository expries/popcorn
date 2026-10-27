import { probeFile } from '../../hls/codecProbe';
import { torrentManager } from '../../services/torrentManager';
import { handleMasterPlaylist, handleSegmentRequest, handleVariantPlaylist } from './hlsHandlers';
import { handleNativeStream } from './nativeStream';
import { handleProgressSSE } from './progressSSE';
import { corsPreflightResponse, redirectResponse } from './responses';
import { handleStatsRequest } from './statsHandler';
import { getBaseUrl, needsHls } from './utils';

export { handleMasterPlaylist, handleSegmentRequest, handleVariantPlaylist } from './hlsHandlers';
export { handleNativeStream } from './nativeStream';
export { handleProgressSSE } from './progressSSE';
export { handleStatsRequest } from './statsHandler';
export * from './responses';

export function createStreamServer(port: number) {
  const server = Bun.serve({
    port,
    routes: {
      // HLS routes - specific patterns first
      '/hls/:infoHash/master.m3u8': async (req) => {
        if (req.method === 'OPTIONS') return corsPreflightResponse();
        return handleMasterPlaylist(req.params.infoHash, getBaseUrl(req, port));
      },

      '/hls/:infoHash/stream.m3u8': async (req) => {
        if (req.method === 'OPTIONS') return corsPreflightResponse();
        return handleVariantPlaylist(req.params.infoHash, getBaseUrl(req, port));
      },

      // Stream routes
      '/stream/:infoHash': async (req) => {
        if (req.method === 'OPTIONS') return corsPreflightResponse();
        const baseUrl = getBaseUrl(req, port);
        const fileInfo = await torrentManager.getVideoFileInfo(req.params.infoHash);

        if (!fileInfo) {
          return new Response('Video not found or torrent not ready', { status: 404 });
        }

        // Probe codec info for MP4/WebM to detect incompatible codecs like H.265
        let codecInfo = null;
        try {
          console.log(`[Stream] Probing file: ${fileInfo.path}`);
          codecInfo = await probeFile(fileInfo.path);
          console.log(`[Stream] Codec info for ${fileInfo.name}:`, {
            videoCodec: codecInfo.videoCodec,
            audioCodec: codecInfo.audioCodec,
            width: codecInfo.width,
            height: codecInfo.height,
            profile: codecInfo.videoProfile,
            level: codecInfo.videoLevel,
            pixelFormat: codecInfo.pixelFormat,
            moovAtStart: codecInfo.moovAtStart,
          });
        } catch (e) {
          console.warn(`[Stream] Failed to probe codec for ${fileInfo.name}:`, e);
        }

        const hlsNeeded = needsHls(fileInfo.name, codecInfo, true); // verbose=true for stream requests
        console.log(`[Stream] HLS needed for ${fileInfo.name}: ${hlsNeeded}`);

        if (hlsNeeded) {
          const hlsUrl = `${baseUrl}/hls/${req.params.infoHash}/master.m3u8`;
          console.log(`[Stream] Redirecting to HLS: ${hlsUrl}`);
          return redirectResponse(hlsUrl);
        }

        console.log(`[Stream] Serving native stream for ${fileInfo.name}`);
        const rangeHeader = req.headers.get('range');
        return handleNativeStream(req.params.infoHash, fileInfo, rangeHeader);
      },

      '/stats/:infoHash': async (req) => {
        if (req.method === 'OPTIONS') return corsPreflightResponse();
        return handleStatsRequest(req.params.infoHash, getBaseUrl(req, port));
      },

      // SSE progress endpoint for real-time updates
      '/stream/:infoHash/progress': async (req) => {
        if (req.method === 'OPTIONS') return corsPreflightResponse();
        return handleProgressSSE(req.params.infoHash);
      },
    },

    // Handle segment requests and fallback in fetch
    async fetch(req) {
      if (req.method === 'OPTIONS') {
        return corsPreflightResponse();
      }

      // Handle segment requests: /hls/:infoHash/segment_N.ts
      const url = new URL(req.url);
      const segmentMatch = url.pathname.match(/^\/hls\/([a-fA-F0-9]+)\/segment_(\d+)\.ts$/);
      if (segmentMatch) {
        const [, infoHash, segmentIndexStr] = segmentMatch;
        const segmentIndex = parseInt(segmentIndexStr, 10);
        return handleSegmentRequest(infoHash, segmentIndex);
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  console.log(`Stream Server running at http://localhost:${port}`);
  return server;
}
