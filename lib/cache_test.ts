import { assertEquals } from '@std/assert';
import { getCached, setCache } from './cache.ts';

Deno.test('getCached returns null when no Redis client is initialized', async () => {
  const result = await getCached('nonexistent-key');
  assertEquals(result, null);
});

Deno.test('setCache does not throw when no Redis client is initialized', async () => {
  await setCache('some-key', 'some-value');
});
