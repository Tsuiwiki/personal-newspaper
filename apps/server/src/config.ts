import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const repoRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(repoRoot, '.env'));

const envSchema = z.object({
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_PATH: z.string().trim().optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  TZ: z.string().trim().default('Asia/Shanghai'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`环境变量配置有误 — ${detail}`);
}

const env = parsed.data;
const databasePath = env.DATABASE_PATH
  ? path.resolve(repoRoot, env.DATABASE_PATH)
  : path.join(repoRoot, 'data', 'newspaper.db');

export const config = {
  host: env.HOST,
  port: env.PORT,
  databasePath,
  backupDir: path.join(repoRoot, 'data', 'backups'),
  logLevel: env.LOG_LEVEL,
  timezone: env.TZ,
  /** 绑定在回环地址时，只接受来自本机的管理请求 */
  loopbackOnly: env.HOST === '127.0.0.1' || env.HOST === 'localhost' || env.HOST === '::1',
  webOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
} as const;

export type Config = typeof config;
