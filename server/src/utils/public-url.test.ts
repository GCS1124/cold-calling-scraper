import { describe, expect, it } from 'vitest';

import { isPublicHttpUrl } from './public-url';

describe('isPublicHttpUrl', () => {
  it.each([
    'http://localhost/admin',
    'http://127.0.0.1/admin',
    'http://[::1]/admin',
    'http://[::ffff:127.0.0.1]/admin',
    'http://[::ffff:7f00:1]/admin',
    'http://[fc00::1]/admin',
    'http://[fe80::1]/admin',
    'http://[ff02::1]/admin',
    'https://user:secret@example.com/contact',
  ])('rejects private, local, or reserved target %s', (url) => {
    expect(isPublicHttpUrl(url)).toBe(false);
  });

  it.each([
    'https://example.com/contact',
    'https://[2001:4860:4860::8888]/contact',
  ])('accepts a public HTTP target %s', (url) => {
    expect(isPublicHttpUrl(url)).toBe(true);
  });
});
