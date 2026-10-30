/** 限制并发的小工具：按顺序启动任务，同时最多 limit 个在跑。 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const size = Math.max(1, Math.min(limit, items.length || 1));
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index]!);
    }
  }

  await Promise.all(Array.from({ length: size }, worker));
  return results;
}
