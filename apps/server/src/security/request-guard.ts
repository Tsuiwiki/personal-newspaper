import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(0, end + 1) : value;
  }
  const colon = value.lastIndexOf(':');
  return colon > 0 ? value.slice(0, colon) : value;
}

function allowedOrigins(): Set<string> {
  const origins = new Set<string>(config.webOrigins);
  origins.add(`http://localhost:${config.port}`);
  origins.add(`http://127.0.0.1:${config.port}`);
  return origins;
}

/**
 * 本地服务的两道门：
 * 1. Host 头必须指向本机 —— 防止恶意网页借 DNS 重绑定访问 127.0.0.1 的管理接口。
 * 2. 写请求若带 Origin，必须在白名单内 —— 防止跨站表单/脚本直接调用。
 */
export function registerRequestGuard(app: FastifyInstance): void {
  const origins = allowedOrigins();

  app.addHook('onRequest', async (request, reply) => {
    if (config.loopbackOnly) {
      const host = request.headers.host ?? '';
      if (!LOOPBACK_HOSTNAMES.has(hostnameOf(host))) {
        return reply.code(403).send({
          error: { code: 'E_HOST_NOT_ALLOWED', message: `拒绝非本机来源的访问（Host: ${host || '空'}）` },
        });
      }
    }

    if (WRITE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      if (typeof origin === 'string' && origin !== 'null' && !origins.has(origin.toLowerCase())) {
        return reply.code(403).send({
          error: { code: 'E_ORIGIN_NOT_ALLOWED', message: '跨站写请求已拒绝' },
        });
      }
    }
  });
}
