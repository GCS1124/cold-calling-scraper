import { describe, expect, it } from 'vitest';

import {
  readResponseTextBounded,
  ResponseBodyTooLargeError,
} from './bounded-fetch';

describe('readResponseTextBounded', () => {
  it('rejects and cancels a public response once its byte budget is exceeded', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('0123456789'));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readResponseTextBounded(new Response(body), 5)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
    expect(cancelled).toBe(true);
  });

  it('keeps multibyte text intact when it fits the byte budget', async () => {
    const text = 'नोटरी';
    await expect(
      readResponseTextBounded(new Response(text), new TextEncoder().encode(text).byteLength),
    ).resolves.toBe(text);
  });
});
