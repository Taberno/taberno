import dns from 'dns/promises';
import net from 'net';
import { processUploadedImage, type ProcessedImage } from '../../admin/images';

const cache = new Map<string, Promise<ProcessedImage>>();

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024; // 20MB
const MAX_REDIRECTS = 3;

/**
 * True for loopback, link-local, private (RFC1918), and other
 * non-globally-routable addresses — including 169.254.169.254, the cloud
 * metadata endpoint every major provider uses.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return true;                       // loopback
    if (a === 10) return true;                         // private
    if (a === 172 && b >= 16 && b <= 31) return true;  // private
    if (a === 192 && b === 168) return true;           // private
    if (a === 169 && b === 254) return true;           // link-local / cloud metadata
    if (a === 0) return true;                          // "this" network
    if (a >= 224) return true;                         // multicast/reserved
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;                                                 // loopback
  if (lower.startsWith('fe8') || lower.startsWith('fe9')
    || lower.startsWith('fea') || lower.startsWith('feb')) return true;             // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;                // unique local
  if (lower.startsWith('::ffff:')) {
    const embedded = lower.slice('::ffff:'.length);
    if (net.isIPv4(embedded)) return isPrivateOrReservedIp(embedded);
  }
  return false;
}

/** Resolves the hostname and throws if ANY resolved address is private/internal. */
export async function assertPublicHost(hostname: string): Promise<void> {
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve host: ${hostname}`);
  }
  if (addresses.length === 0) throw new Error(`Could not resolve host: ${hostname}`);
  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new Error(`Refusing to fetch from a private/internal address (${hostname} -> ${address})`);
    }
  }
}

export function assertSafeUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid image URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to fetch non-http(s) URL: ${url}`);
  }
  return parsed;
}

/**
 * Fetches a URL that a WXR/WooCommerce import file claimed was a product
 * image, with the checks a raw fetch() doesn't give you for granted:
 * http(s)-only, DNS-resolved host must be public (blocks 169.254.169.254,
 * 127.0.0.1, RFC1918 ranges, etc. — a crafted export file can otherwise turn
 * "download this product image" into an internal port scan or a metadata
 * fetch republished as a public image), redirects are followed manually so
 * each hop is validated too (an initial public host redirecting to an
 * internal one would otherwise bypass the check entirely), a timeout, and a
 * response-size cap.
 */
async function fetchImageSafely(url: string): Promise<Buffer> {
  let current = assertSafeUrl(url);

  for (let hop = 0; ; hop++) {
    await assertPublicHost(current.hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current, { signal: controller.signal, redirect: 'manual' });
    } finally {
      clearTimeout(timeout);
    }

    if (res.status >= 300 && res.status < 400) {
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects fetching image: ${url}`);
      const location = res.headers.get('location');
      if (!location) throw new Error(`Redirect with no Location header fetching image: ${url}`);
      current = assertSafeUrl(new URL(location, current).toString());
      continue;
    }
    if (!res.ok) throw new Error(`Failed to download image (${res.status}): ${url}`);

    const contentLength = res.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
      throw new Error(`Image too large (${contentLength} bytes): ${url}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_RESPONSE_BYTES) throw new Error(`Image too large (${buffer.length} bytes): ${url}`);
    return buffer;
  }
}

/** Downloads a remote product image and runs it through the normal upload pipeline (resize + WebP). */
export async function importRemoteImage(url: string): Promise<ProcessedImage> {
  const existing = cache.get(url);
  if (existing) return existing;

  const promise = (async () => {
    const buffer = await fetchImageSafely(url);
    return processUploadedImage(buffer, url.split('/').pop() || 'image.jpg');
  })();

  cache.set(url, promise);
  return promise;
}
