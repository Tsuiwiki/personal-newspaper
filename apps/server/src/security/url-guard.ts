import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

export type GuardErrorCode =
  | 'E_URL_INVALID'
  | 'E_URL_PROTOCOL'
  | 'E_URL_CREDENTIALS'
  | 'E_URL_PORT'
  | 'E_DNS_FAILED'
  | 'E_URL_ADDRESS_BLOCKED'
  | 'E_REDIRECT_LIMIT'
  | 'E_TIMEOUT'
  | 'E_BODY_TOO_LARGE'
  | 'E_NETWORK';

export class GuardError extends Error {
  constructor(
    readonly code: GuardErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GuardError';
  }
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** 返回 16 字节的 IPv6 表示；无法解析时返回 null */
function parseIpv6(input: string): number[] | null {
  let value = input.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zoneIndex = value.indexOf('%');
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);
  if (!value.includes(':')) return null;

  const halves = value.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[][] | null => {
    if (!part) return [];
    const out: number[][] = [];
    for (const group of part.split(':')) {
      if (group.includes('.')) {
        const v4 = parseIpv4(group);
        if (!v4) return null;
        out.push([(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push([Number.parseInt(group, 16)]);
    }
    return out;
  };

  const head = toGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? toGroups(halves[1] ?? '') : null;
  if (!head || (halves.length === 2 && !tail)) return null;

  let groups: number[];
  if (halves.length === 2) {
    const headFlat = head.flat();
    const tailFlat = (tail ?? []).flat();
    const missing = 8 - headFlat.length - tailFlat.length;
    if (missing < 1) return null;
    groups = [...headFlat, ...new Array<number>(missing).fill(0), ...tailFlat];
  } else {
    groups = head.flat();
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of groups) bytes.push((group >> 8) & 0xff, group & 0xff);
  return bytes;
}

function isBlockedIpv4(octets: number[]): boolean {
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24, 192.0.2/24
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** 判断字面量 IP 是否落在必须阻断的地址段（回环/私网/链路本地/保留） */
export function isBlockedAddress(address: string): boolean {
  const plain = address.trim();
  if (net.isIPv4(plain)) {
    const octets = parseIpv4(plain);
    return octets ? isBlockedIpv4(octets) : true;
  }
  if (net.isIPv6(plain)) {
    const bytes = parseIpv6(plain);
    if (!bytes) return true;
    const [b0, b1, b2, b3] = bytes as [number, number, number, number];
    if (bytes.every((byte) => byte === 0)) return true; // ::
    const isMapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (isMapped) return isBlockedIpv4(bytes.slice(12));
    const isNat64 = b0 === 0x00 && b1 === 0x64 && b2 === 0xff && b3 === 0x9b;
    if (isNat64) return isBlockedIpv4(bytes.slice(12));
    const isSixToFour = b0 === 0x20 && b1 === 0x02;
    if (isSixToFour) return isBlockedIpv4(bytes.slice(2, 6));
    if ((b0 & 0xfe) === 0xfc) return true; // fc00::/7 unique local
    if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true; // fe80::/10 link-local
    if (b0 === 0xfe && (b1 & 0xc0) === 0xc0) return true; // fec0::/10 site-local
    if (b0 === 0xff) return true; // multicast
    if (b0 === 0x20 && b1 === 0x01 && b2 === 0x0d && b3 === 0xb8) return true; // 2001:db8::/32
    if (b0 === 0x01 && b1 === 0x00 && bytes.slice(2, 8).every((byte) => byte === 0)) return true; // 100::/64
    if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 0x01) return true; // ::1
    return false;
  }
  return true;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultResolver: AddressResolver = (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true }) as Promise<ResolvedAddress[]>;

export interface UrlPolicy {
  allowedProtocols?: readonly string[];
  allowedPorts?: readonly number[];
  resolve?: AddressResolver;
  isAddressAllowed?: (address: string) => boolean;
}

const DEFAULT_PROTOCOLS = ['http:', 'https:'];
const DEFAULT_PORTS = [80, 443];

export interface SafeTarget {
  url: URL;
  addresses: ResolvedAddress[];
  /** 连接时钉死的地址，避免校验后再解析被 DNS 重绑定绕过 */
  pinned: ResolvedAddress;
}

export async function assertSafeUrl(input: string, policy: UrlPolicy = {}): Promise<SafeTarget> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new GuardError('E_URL_INVALID', '链接格式不合法');
  }

  const protocols = policy.allowedProtocols ?? DEFAULT_PROTOCOLS;
  if (!protocols.includes(url.protocol)) {
    throw new GuardError('E_URL_PROTOCOL', `只允许 ${protocols.map((p) => p.replace(':', '')).join(' / ')} 协议`);
  }
  if (url.username || url.password) {
    throw new GuardError('E_URL_CREDENTIALS', '链接中不能包含账号密码');
  }
  if (!url.hostname) {
    throw new GuardError('E_URL_INVALID', '链接缺少主机名');
  }

  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  const allowedPorts = policy.allowedPorts ?? DEFAULT_PORTS;
  if (!allowedPorts.includes(port)) {
    throw new GuardError('E_URL_PORT', `不允许访问端口 ${port}`);
  }

  const literalFamily = net.isIP(url.hostname);
  let addresses: ResolvedAddress[];
  if (literalFamily !== 0) {
    addresses = [{ address: url.hostname, family: literalFamily }];
  } else {
    const resolve = policy.resolve ?? defaultResolver;
    try {
      addresses = await resolve(url.hostname);
    } catch {
      throw new GuardError('E_DNS_FAILED', `无法解析域名 ${url.hostname}`);
    }
  }
  if (addresses.length === 0) {
    throw new GuardError('E_DNS_FAILED', `无法解析域名 ${url.hostname}`);
  }

  const allow = policy.isAddressAllowed ?? ((address: string) => !isBlockedAddress(address));
  const blocked = addresses.filter((entry) => !allow(entry.address));
  if (blocked.length > 0) {
    throw new GuardError('E_URL_ADDRESS_BLOCKED', '目标地址属于内网、回环或保留地址，已拒绝访问');
  }

  return { url, addresses, pinned: addresses[0]! };
}

export interface SafeFetchOptions extends UrlPolicy {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  userAgent?: string;
  accept?: string;
}

export interface SafeFetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  finalUrl: string;
  redirects: number;
}

interface SingleResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function requestOnce(target: SafeTarget, options: SafeFetchOptions): Promise<SingleResponse> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;

  return new Promise<SingleResponse>((resolve, reject) => {
    const isHttps = target.url.protocol === 'https:';
    const client = isHttps ? https : http;
    let settled = false;
    let request: http.ClientRequest | undefined;
    let overallTimer: NodeJS.Timeout | undefined;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (overallTimer) clearTimeout(overallTimer);
      request?.destroy();
      reject(error);
    };

    const onResponse = (response: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          fail(new GuardError('E_BODY_TOO_LARGE', `响应超过 ${maxBytes} 字节上限`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        if (overallTimer) clearTimeout(overallTimer);
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
      });
      response.on('error', (error) => fail(new GuardError('E_NETWORK', error.message)));
    };

    request = client.request(
      {
        protocol: target.url.protocol,
        hostname: target.url.hostname,
        port: target.url.port ? Number(target.url.port) : isHttps ? 443 : 80,
        path: `${target.url.pathname}${target.url.search}`,
        method: 'GET',
        servername: isHttps ? target.url.hostname : undefined,
        headers: {
          'user-agent': options.userAgent ?? 'PersonalNewspaper/0.1 (+local)',
          accept: options.accept ?? 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8',
          'accept-encoding': 'identity',
          ...options.headers,
        },
        // 关键：连接目标固定为已校验的地址，避免二次解析造成 DNS 重绑定
        lookup: (_hostname, lookupOptions, callback) => {
          if ((lookupOptions as { all?: boolean }).all) {
            callback(null, [target.pinned] as never);
          } else {
            callback(null, target.pinned.address, target.pinned.family);
          }
        },
      },
      onResponse,
    );

    overallTimer = setTimeout(() => {
      fail(new GuardError('E_TIMEOUT', `请求超过 ${timeoutMs}ms 未完成`));
    }, timeoutMs);
    overallTimer.unref?.();

    request.setTimeout(timeoutMs, () => fail(new GuardError('E_TIMEOUT', `请求超过 ${timeoutMs}ms 未完成`)));
    request.on('error', (error) =>
      fail(error instanceof GuardError ? error : new GuardError('E_NETWORK', error.message)),
    );
    request.end();
  });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** 带 SSRF 防护的 GET：每次跳转都重新校验目标地址、限制次数、超时与响应体大小 */
export async function safeFetch(input: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 3;
  let current = input;
  let redirects = 0;

  for (;;) {
    const target = await assertSafeUrl(current, options);
    const response = await requestOnce(target, options);
    const location = response.headers.location;

    if (REDIRECT_STATUSES.has(response.status) && typeof location === 'string') {
      if (redirects >= maxRedirects) {
        throw new GuardError('E_REDIRECT_LIMIT', `跳转超过 ${maxRedirects} 次上限`);
      }
      let next: string;
      try {
        next = new URL(location, target.url).toString();
      } catch {
        throw new GuardError('E_URL_INVALID', '跳转目标不是合法链接');
      }
      redirects += 1;
      current = next;
      continue;
    }

    return {
      status: response.status,
      headers: response.headers,
      body: response.body.toString('utf8'),
      finalUrl: target.url.toString(),
      redirects,
    };
  }
}
