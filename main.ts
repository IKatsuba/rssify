import { Hono } from '@hono/hono';
import { logger } from '@hono/hono/logger';
import { getAllProviders, getProvider } from './providers/mod.ts';
import { buildAtomFeed } from './lib/feed.ts';
import { getCached, initCache, setCache } from './lib/cache.ts';

const app = new Hono();

// Middleware
app.use('*', logger());

// Error handler
app.onError((err, c) => {
  console.error(`${c.req.method} ${c.req.url}:`, err.message);
  return c.json({ error: err.message }, 502);
});

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// Index: list available feeds
app.get('/', (c) => {
  const feeds = getAllProviders().map((p) => ({
    name: `${p.namespace}/${p.route}`,
    title: p.meta.title,
    url: `/${p.namespace}/${p.route}`,
  }));
  return c.json({ feeds });
});

// Provider routes: /:namespace/:route
app.get('/:namespace/:route', async (c) => {
  const { namespace, route } = c.req.param();
  const provider = getProvider(namespace, route);

  if (!provider) {
    return c.json({ error: 'Feed not found' }, 404);
  }

  const cacheKey = `${namespace}:${route}`;

  // Try cache first
  const cached = await getCached(cacheKey);
  if (cached) {
    return c.body(cached, 200, {
      'Content-Type': 'application/atom+xml; charset=utf-8',
    });
  }

  // Fetch and build feed
  const entries = await provider.fetch();
  const xml = buildAtomFeed(provider.meta, entries);

  // Cache asynchronously (fire and forget)
  setCache(cacheKey, xml);

  return c.body(xml, 200, {
    'Content-Type': 'application/atom+xml; charset=utf-8',
  });
});

export { app };

if (import.meta.main) {
  await initCache();
  const port = Number(Deno.env.get('PORT')) || 8000;
  Deno.serve({ port }, app.fetch);
}
