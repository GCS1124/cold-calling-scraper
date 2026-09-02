const isPrivateIpv4Address = (hostname: string) => {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return false;
  }

  const octets = hostname.split('.').map(Number);

  if (octets.some((octet) => octet < 0 || octet > 255)) {
    return true;
  }

  const [first, second, third] = octets;

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
    if (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^(?:fe[89ab]):/i.test(normalized)
    ) {
      return true;
    }

    const mappedIpv4 = normalized.match(/^(?:0*:)*ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
    return Boolean(mappedIpv4 && isPrivateIpv4Address(mappedIpv4));
  }

  return false;
};

export const isPublicHttpUrl = (value: string | URL) => {
  try {
    const url = typeof value === 'string' ? new URL(value) : value;

    return /^https?:$/i.test(url.protocol) && !isPrivateOrLocalHostname(url.hostname);
  } catch {
    return false;
  }
};
