import { isIP } from 'node:net';

const isPrivateIpv4Octets = (octets: number[]) => {
  const [first, second, third] = octets;

  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
};

const isPrivateIpv4Address = (hostname: string) => {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return false;
  }

  return isPrivateIpv4Octets(hostname.split('.').map(Number));
};

const parseIpv6Hextets = (value: string) => {
  const normalized = value.toLowerCase().split('%')[0] ?? '';
  if (!normalized || isIP(normalized) !== 6) return undefined;

  const parsePart = (part: string) => {
    if (!part) return [] as number[];

    const tokens = part.split(':');
    const hextets: number[] = [];
    for (const [index, token] of tokens.entries()) {
      if (!token) return undefined;

      if (token.includes('.')) {
        if (index !== tokens.length - 1) return undefined;
        const octets = token.split('.').map(Number);
        if (
          octets.length !== 4 ||
          octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
        ) return undefined;
        hextets.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
        continue;
      }

      if (!/^[0-9a-f]{1,4}$/i.test(token)) return undefined;
      hextets.push(Number.parseInt(token, 16));
    }
    return hextets;
  };

  const parts = normalized.split('::');
  if (parts.length > 2) return undefined;

  const head = parsePart(parts[0] ?? '');
  const tail = parts.length === 2 ? parsePart(parts[1] ?? '') : [];
  if (!head || !tail) return undefined;

  if (parts.length === 1) {
    return head.length === 8 ? head : undefined;
  }

  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
};

const ipv4FromLastHextets = (hextets: number[]) => {
  const last = hextets.slice(-2);
  return [last[0]! >> 8, last[0]! & 0xff, last[1]! >> 8, last[1]! & 0xff];
};

const isPrivateIpv6Address = (hostname: string) => {
  const hextets = parseIpv6Hextets(hostname);
  if (!hextets) return true;

  const first = hextets[0]!;
  const second = hextets[1]!;

  // Unspecified, loopback, unique-local, link-local, multicast, and reserved
  // documentation/discard ranges must never become crawl targets.
  if (
    hextets.every((hextet) => hextet === 0) ||
    (hextets.slice(0, 7).every((hextet) => hextet === 0) && hextets[7] === 1) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && second === 0x0db8) ||
    (first === 0x0100 && second === 0)
  ) {
    return true;
  }

  const mappedIpv4 =
    hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff;
  const compatibleIpv4 = hextets.slice(0, 6).every((hextet) => hextet === 0);

  return (mappedIpv4 || compatibleIpv4) && isPrivateIpv4Octets(ipv4FromLastHextets(hextets));
};

const isPrivateOrLocalHostname = (hostname: string) => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === 'localhost.localdomain' ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.home.arpa')
  ) {
    return true;
  }

  if (isPrivateIpv4Address(normalized)) {
    return true;
  }

  if (normalized.includes(':')) {
    return isPrivateIpv6Address(normalized) || normalized === '::1';
  }

  return false;
};

export const isPublicHttpUrl = (value: string | URL) => {
  try {
    const url = typeof value === 'string' ? new URL(value) : value;

    return (
      /^https?:$/i.test(url.protocol) &&
      !url.username &&
      !url.password &&
      !isPrivateOrLocalHostname(url.hostname)
    );
  } catch {
    return false;
  }
};

/**
 * NotaryCafe profile references are an indexed-only source in this product.
 * Keeping the host check central prevents a later enrichment path from
 * accidentally turning a profile URL into a direct crawl target.
 */
export const isNotaryCafeHost = (value: string | URL) => {
  try {
    const url = typeof value === 'string' ? new URL(value) : value;
    const hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    return hostname === 'notarycafe.com' || hostname.endsWith('.notarycafe.com');
  } catch {
    return false;
  }
};

/**
 * Callback destinations are stricter than ordinary public source URLs. They
 * must be HTTPS, cannot carry credentials, and cannot hide a destination in
 * a query string or fragment.
 */
export const isPublicHttpsCallbackUrl = (value: string | URL) => {
  try {
    const url = typeof value === 'string' ? new URL(value) : value;

    return (
      url.protocol === 'https:' &&
      isPublicHttpUrl(url) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
};
