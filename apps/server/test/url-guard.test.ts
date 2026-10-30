import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { GuardError, assertSafeUrl, isBlockedAddress, safeFetch } from '../src/security/url-guard.js';

test('阻断回环、私网、链路本地与保留地址', () => {
  const blocked = [
    '127.0.0.1',
    '127.10.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.0.2.10',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '2001:db8::1',
    'ff02::1',
  ];
  for (const address of blocked) {
    assert.equal(isBlockedAddress(address), true, `${address} 应当被阻断`);
  }
});

test('放行公网地址', () => {
  const allowed = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'];
  for (const address of allowed) {
    assert.equal(isBlockedAddress(address), false, `${address} 不应被阻断`);
  }
});

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];
const privateResolver = async () => [{ address: '10.0.0.8', family: 4 }];

test('只允许 http/https，拒绝 file 协议', async () => {
  await assert.rejects(
    () => assertSafeUrl('file:///etc/passwd', { resolve: publicResolver }),
    (error: unknown) => error instanceof GuardError && error.code === 'E_URL_PROTOCOL',
  );
});

test('拒绝带账号密码的链接', async () => {
  await assert.rejects(
    () => assertSafeUrl('https://user:pass@example.com/feed', { resolve: publicResolver }),
    (error: unknown) => error instanceof GuardError && error.code === 'E_URL_CREDENTIALS',
  );
});

test('拒绝非白名单端口', async () => {
  await assert.rejects(
    () => assertSafeUrl('http://example.com:6379/', { resolve: publicResolver }),
    (error: unknown) => error instanceof GuardError && error.code === 'E_URL_PORT',
  );
});

test('域名解析到私网时拒绝', async () => {
  await assert.rejects(
    () => assertSafeUrl('https://intranet.example/feed', { resolve: privateResolver }),
    (error: unknown) => error instanceof GuardError && error.code === 'E_URL_ADDRESS_BLOCKED',
  );
});

test('解析出多个地址时，只要有一个是内网就拒绝', async () => {
  const mixed = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '192.168.0.10', family: 4 },
  ];
  await assert.rejects(
    () => assertSafeUrl('https://rebind.example/feed', { resolve: mixed }),
    (error: unknown) => error instanceof GuardError && error.code === 'E_URL_ADDRESS_BLOCKED',
  );
});

test('合法公网地址返回钉死的连接地址', async () => {
  const target = await assertSafeUrl('https://example.com/feed?x=1', { resolve: publicResolver });
  assert.equal(target.pinned.address, '93.184.216.34');
  assert.equal(target.url.search, '?x=1');
});

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** 测试里显式放宽本机地址与随机端口，其余策略保持默认 */
function localPolicy(port: number) {
  return {
    allowedPorts: [port],
    isAddressAllowed: () => true,
  };
}

test('safeFetch 能取回响应正文', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end('<rss>hello</rss>');
  });
  const port = Number(new URL(server.url).port);
  try {
    const result = await safeFetch(`${server.url}/feed.xml`, { ...localPolicy(port), timeoutMs: 2000 });
    assert.equal(result.status, 200);
    assert.match(result.body, /hello/);
    assert.equal(result.redirects, 0);
  } finally {
    await server.close();
  }
});

test('safeFetch 跟随跳转，但跳转到内网时拒绝', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: 'http://intranet.internal/secret' });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end('should not reach');
  });
  const port = Number(new URL(server.url).port);
  const resolver = async (hostname: string) =>
    hostname === 'intranet.internal'
      ? [{ address: '169.254.169.254', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }];

  try {
    await assert.rejects(
      () =>
        safeFetch(`${server.url}/start`, {
          allowedPorts: [port],
          resolve: resolver,
          isAddressAllowed: (address) => !isBlockedAddress(address),
        }),
      (error: unknown) => error instanceof GuardError && error.code === 'E_URL_ADDRESS_BLOCKED',
    );
  } finally {
    await server.close();
  }
});

test('safeFetch 超过响应体上限时报错', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200);
    res.end('x'.repeat(8192));
  });
  const port = Number(new URL(server.url).port);
  try {
    await assert.rejects(
      () => safeFetch(`${server.url}/big`, { ...localPolicy(port), maxBytes: 1024 }),
      (error: unknown) => error instanceof GuardError && error.code === 'E_BODY_TOO_LARGE',
    );
  } finally {
    await server.close();
  }
});

test('safeFetch 超时中断', async () => {
  const server = await startServer(() => {
    // 永不响应
  });
  const port = Number(new URL(server.url).port);
  try {
    await assert.rejects(
      () => safeFetch(`${server.url}/hang`, { ...localPolicy(port), timeoutMs: 120 }),
      (error: unknown) => error instanceof GuardError && error.code === 'E_TIMEOUT',
    );
  } finally {
    await server.close();
  }
});
