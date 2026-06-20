import * as fs from "node:fs";

export const DEFAULT_FILE_PREFIX_MAX_BYTES = 512_000;

/** Read only the beginning of a file without materializing the full contents. */
export async function readFilePrefix(
  filePath: string,
  maxBytes: number = DEFAULT_FILE_PREFIX_MAX_BYTES,
): Promise<string> {
  const boundedMax = Math.max(1, Math.floor(maxBytes));
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(boundedMax);
    const { bytesRead } = await handle.read(buffer, 0, boundedMax, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index]);
    }
  }));
  return results;
}
