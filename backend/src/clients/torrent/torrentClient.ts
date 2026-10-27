import axios from 'axios';
import parseTorrent, { toMagnetURI } from 'parse-torrent';

export interface TorrentInfo {
  magnetURI: string;
  torrentFileBuffer?: ArrayBuffer;
}

export const torrentClient = {
  fetchTorrentInfo: async (torrentUrl: string): Promise<TorrentInfo> => {
    // Jackett provides a redirect URL that can point to either:
    // 1. A magnet URI (redirect Location header starts with "magnet:")
    // 2. A torrent file download

    // First, follow redirects manually to detect magnet URI redirects
    // axios doesn't handle magnet: protocol redirects well
    const response = await axios.get(torrentUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxRedirects: 0, // Don't auto-follow redirects so we can check for magnet URIs
      validateStatus: (status) => status < 500,
    });

    // Check if this is a redirect to a magnet URI
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers['location'];

      if (location?.startsWith('magnet:')) {
        return { magnetURI: location };
      }

      // Follow the redirect manually for non-magnet URLs
      return torrentClient.fetchTorrentInfo(location);
    }

    const dataSize = response.data?.byteLength ?? response.data?.length ?? 0;
    console.log(
      `Response status: ${response.status}, Content-Type: ${response.headers['content-type'] ?? 'unknown'}, Size: ${dataSize} bytes`,
    );

    if (response.status === 404) {
      throw new Error('Torrent not found (404). The torrent link may have expired or is no longer available.');
    }

    if (response.status >= 400) {
      throw new Error(`Failed to fetch torrent: HTTP ${response.status}`);
    }

    const isEmpty = response.data?.byteLength === 0 || response.data?.length === 0 || !response.data;
    if (isEmpty) {
      throw new Error('Empty response when fetching torrent file. The torrent may no longer be available.');
    }

    // Check if we got HTML instead of a torrent file
    const contentType = response.headers['content-type'] ?? '';
    if (contentType.includes('text/html')) {
      // Check if the HTML contains a magnet link (some sites do this)
      const htmlContent = Buffer.from(response.data).toString('utf-8');
      const magnetMatch = htmlContent.match(/magnet:\?[^"'\s<>]+/);
      if (magnetMatch) {
        return { magnetURI: magnetMatch[0] };
      }

      throw new Error(
        'Received HTML instead of torrent file. The download link may require browser access or has expired.',
      );
    }

    console.log('Torrent file downloaded, parsing...');

    // Convert response data to Buffer
    let torrentBuffer: Buffer;
    if (Buffer.isBuffer(response.data)) {
      torrentBuffer = response.data;
    } else if (response.data instanceof ArrayBuffer) {
      torrentBuffer = Buffer.from(new Uint8Array(response.data));
    } else {
      torrentBuffer = Buffer.from(response.data);
    }

    console.log('Buffer length:', torrentBuffer.length, 'first bytes:', torrentBuffer.subarray(0, 10).toString('hex'));

    // Parse torrent to get info
    const torrentInfo = parseTorrent(torrentBuffer);

    if (!torrentInfo) {
      throw new Error('Failed to parse torrent file');
    }

    console.log('Parsed torrent info:', {
      name: torrentInfo.name,
      infoHash: torrentInfo.infoHash,
      hasAnnounce: !!torrentInfo.announce,
      announceCount: torrentInfo.announce?.length,
    });

    // Check if we have the required info for magnet URI
    if (!torrentInfo.infoHash) {
      throw new Error('Torrent file is missing infoHash - cannot generate magnet URI');
    }

    // Generate magnet URI
    const magnetURI = toMagnetURI(torrentInfo);

    if (!magnetURI || magnetURI.length === 0) {
      throw new Error('Generated magnet URI is empty');
    }

    console.log('Generated magnet URI:', magnetURI);

    return {
      magnetURI,
      torrentFileBuffer: response.data,
    };
  },
};
