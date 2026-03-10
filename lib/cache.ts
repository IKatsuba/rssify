import { RedisClient } from '@iuioiua/redis';

const DEFAULT_TTL = 900; // 15 minutes
const KEY_PREFIX = 'rssify:';

let client: RedisClient | null = null;

export async function initCache(): Promise<void> {
  const redisUrl = Deno.env.get('REDIS_URL') ?? 'redis://localhost:6379';
  const url = new URL(redisUrl);

  try {
    const conn = await Deno.connect({
      hostname: url.hostname,
      port: Number(url.port) || 6379,
    });
    client = new RedisClient(conn);

    if (url.password) {
      await client.sendCommand(['AUTH', url.password]);
    }
  } catch (error) {
    console.warn(
      'Redis unavailable, running without cache:',
      (error as Error).message,
    );
    client = null;
  }
}

export async function getCached(key: string): Promise<string | null> {
  if (!client) return null;
  try {
    const result = await client.sendCommand(['GET', KEY_PREFIX + key]);
    return result as string | null;
  } catch {
    return null;
  }
}

export async function setCache(
  key: string,
  value: string,
  ttl: number = DEFAULT_TTL,
): Promise<void> {
  if (!client) return;
  try {
    await client.sendCommand([
      'SET',
      KEY_PREFIX + key,
      value,
      'EX',
      String(ttl),
    ]);
  } catch {
    // Ignore cache write failures — graceful degradation
  }
}
