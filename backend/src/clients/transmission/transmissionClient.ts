import { Transmission } from '@ctrl/transmission';

const baseUrl = process.env.TRANSMISSION_URL ?? 'http://localhost:9091';

export const transmissionClient = new Transmission({
  baseUrl,
});

// Re-export status constants for convenience
export const TorrentStatus = {
  STOPPED: 0,
  CHECK_WAIT: 1,
  CHECK: 2,
  DOWNLOAD_WAIT: 3,
  DOWNLOAD: 4,
  SEED_WAIT: 5,
  SEED: 6,
} as const;
