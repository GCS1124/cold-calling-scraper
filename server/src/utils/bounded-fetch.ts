export class ResponseBodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Response body exceeded the ${maxBytes}-byte safety limit.`);
    this.name = 'ResponseBodyTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/**
 * Read a fetch response without allowing an untrusted public endpoint to
 * allocate an unbounded string. The response is cancelled as soon as the byte
 * budget is exceeded.
 */
export const readResponseTextBounded = async (
  response: Response,
  maxBytes: number,
) => {
  const boundedMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.floor(maxBytes)
    : 1_000_000;

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > boundedMaxBytes) {
      throw new ResponseBodyTooLargeError(boundedMaxBytes);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        chunks.push(decoder.decode());
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > boundedMaxBytes) {
        try {
          await reader.cancel('response body limit exceeded');
        } catch {
          // The size-limit error is the useful failure even if the remote
          // stream has already closed while cancellation is requested.
        }
        throw new ResponseBodyTooLargeError(boundedMaxBytes);
      }

      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }

  return chunks.join('');
};
