# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Rssify is a Deno-based service that transforms web content into Atom RSS feeds using a modular provider system. Currently serves the Claude Code blog feed.

## Commands

```bash
deno task dev      # Run dev server with --watch (port 8000)
deno task start    # Run production server
deno task test     # Run all tests
deno fmt           # Format (single quotes enforced)
deno lint          # Lint
```

Run a single test file: `deno test --allow-net --allow-env --allow-read path/to/file_test.ts`

Local development with Redis: `docker compose up`

## Architecture

**Entry point**: `main.ts` — Hono HTTP server with routes:
- `GET /health` — health check
- `GET /` — lists available feeds
- `GET /:namespace/:route` — returns Atom XML feed

**Provider system** (`providers/`):
- Each provider implements `Provider` interface from `lib/types.ts` (namespace, route, meta, fetch())
- Providers are registered in `providers/mod.ts`
- Provider path maps to URL: `blogs/claude-code` → `/blogs/claude-code`
- Tests are colocated: `claude-code.ts` / `claude-code_test.ts`

**Core libraries** (`lib/`):
- `cache.ts` — Redis cache with graceful degradation (fails silently if Redis unavailable)
- `feed.ts` — Converts FeedEntry[] to Atom XML using @feed/feed
- `scraper.ts` — Dual-mode: static fetch first, headless Chromium fallback via Astral if content < 200 chars
- `types.ts` — Provider, FeedMeta, FeedEntry interfaces

**Key patterns**:
- Cache keys prefixed with `rssify:`, feed TTL 15min, individual post TTL 7 days
- Fire-and-forget async caching (don't await cache writes)
- HTML parsing with deno-dom, HTML→Markdown with Turndown
- Providers scrape source sites and return structured FeedEntry objects

## Dependencies

Hono (web framework), deno-dom (HTML parsing), Astral (headless browser), @feed/feed (Atom generation), @iuioiua/redis (cache), Turndown (HTML→Markdown).

## Environment Variables

- `PORT` — server port (default 8000)
- `REDIS_URL` — Redis connection URL (optional, caching degrades gracefully)
- `CHROME_BIN` — Chromium path (set in Docker)
