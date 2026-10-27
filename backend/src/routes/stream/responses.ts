const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
};

export function hlsPlaylistResponse(playlist: string): Response {
  return new Response(playlist, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-cache',
      ...CORS_HEADERS,
    },
  });
}

export function hlsSegmentResponse(segment: Buffer): Response {
  return new Response(segment, {
    status: 200,
    headers: {
      'Content-Type': 'video/MP2T',
      'Content-Length': String(segment.length),
      'Cache-Control': 'max-age=86400',
      ...CORS_HEADERS,
    },
  });
}

export function jsonErrorResponse(
  error: string,
  status: number,
  details?: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({ error, ...details }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...CORS_HEADERS,
      },
    },
  );
}

export function jsonSuccessResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

export function retryErrorResponse(error: string, retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({ error }),
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSeconds),
        ...CORS_HEADERS,
      },
    },
  );
}

export function corsPreflightResponse(): Response {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
    },
  });
}

export function videoStreamResponse(
  stream: ReadableStream<Uint8Array>,
  fileSize: number,
  mimeType: string,
): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Length': String(fileSize),
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      ...CORS_HEADERS,
    },
  });
}

export function videoRangeResponse(
  stream: ReadableStream<Uint8Array>,
  start: number,
  end: number,
  fileSize: number,
  mimeType: string,
): Response {
  return new Response(stream, {
    status: 206,
    headers: {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Content-Type': mimeType,
      ...CORS_HEADERS,
    },
  });
}

export function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      ...CORS_HEADERS,
    },
  });
}
