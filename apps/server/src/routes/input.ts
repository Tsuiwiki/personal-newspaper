import type { ZodType } from 'zod';
import { ApiError } from '../errors.js';

export function parseInput<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(
      400,
      'E_VALIDATION',
      '请求参数不合法',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}
