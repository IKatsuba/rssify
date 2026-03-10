# Implementation Plan: Rssify — RSS Proxy Service

## Overview

Пошаговая реализация сервиса на Deno, генерирующего Atom-фиды для сайтов без RSS. Начинаем с фундамента (конфиг, типы), затем core-библиотеки, потом provider и HTTP-сервер, в конце — Docker.

## Tasks

- [x] 1. Project Foundation
  - [x] 1.1 Create `deno.json` with imports and tasks
    - Create `deno.json` with JSR imports for all dependencies: `@hono/hono`, `@b-fuze/deno-dom`, `@astral/astral`, `@feed/feed`, `@iuioiua/redis`, `@std/assert`
    - Add tasks: `dev` (with `--watch`), `start`, `test`
    - File: `deno.json`
    - _Requirements: 7_

  - [x] 1.2 Create shared types
    - Define interfaces: `FeedEntry`, `FeedMeta`, `Provider`
    - File: `lib/types.ts`
    - _Requirements: 2, 5_

- [ ] 2. Checkpoint — Foundation
  - Run `deno check lib/types.ts` to verify types compile
  - Run `deno install` to verify all imports resolve

- [ ] 3. Core Libraries
  - [ ] 3.1 Implement Feed Composer
    - Create `buildAtomFeed(meta, entries)` using `@feed/feed` Atom class
    - Handle empty entries (return valid empty feed)
    - Handle categories mapping
    - File: `lib/feed.ts`
    - _Requirements: 5_

  - [ ] 3.2 Write Feed Composer tests
    - Test: generates valid Atom XML with entries
    - Test: generates valid empty feed
    - Test: includes categories as Atom category elements
    - Test: escapes HTML in summary/content
    - File: `lib/feed_test.ts`
    - _Requirements: 5_

  - [ ] 3.3 Implement HTML Scraper
    - Create `scrape(url)` — HTTP fetch with User-Agent header
    - Create `hasContent(html)` — heuristic check using deno-dom
    - Create `scrapeWithBrowser(url)` — Astral headless browser fallback (dynamic import)
    - Create `parseHTML(html)` — helper for providers
    - File: `lib/scraper.ts`
    - _Requirements: 3_

  - [ ] 3.4 Write Scraper tests
    - Test: `hasContent` returns true for substantial HTML
    - Test: `hasContent` returns false for empty/minimal HTML
    - Test: `parseHTML` returns valid Document
    - Note: skip network-dependent tests, test pure functions only
    - File: `lib/scraper_test.ts`
    - _Requirements: 3_

  - [ ] 3.5 Implement Cache Layer
    - Create `initCache()` — connect to Redis via `REDIS_URL`, handle auth, graceful failure
    - Create `getCached(key)` — GET with prefix, silently fail on error
    - Create `setCache(key, value, ttl)` — SET with EX, default TTL 900s, silently fail on error
    - Parse `REDIS_URL` as standard URL format (`redis://host:port` or `redis://:password@host:port`)
    - File: `lib/cache.ts`
    - _Requirements: 6_

  - [ ] 3.6 Write Cache Layer tests
    - Test: `getCached` returns null when client is null (no Redis)
    - Test: `setCache` does not throw when client is null
    - Note: integration tests with real Redis deferred to final checkpoint
    - File: `lib/cache_test.ts`
    - _Requirements: 6_

- [ ] 4. Checkpoint — Core Libraries
  - Run `deno test lib/` to verify all library tests pass
  - Run `deno check lib/feed.ts lib/scraper.ts lib/cache.ts` to verify type correctness

- [ ] 5. Provider System
  - [ ] 5.1 Implement Provider Registry
    - Create `registerProvider(provider)` — stores in Map by `namespace/route`
    - Create `getProvider(namespace, route)` — lookup
    - Create `getAllProviders()` — list all registered
    - Auto-import provider modules at the bottom
    - File: `providers/mod.ts`
    - _Requirements: 2_

  - [ ] 5.2 Implement Anthropic Blog Provider
    - Create `parseEmbeddedPosts(html)` — extract posts from Next.js RSC streaming data (`self.__next_f.push([...])`)
    - Fields to extract: `title`, `slug.current`, `publishedOn`, `summary`, `subjects`
    - Map to `FeedEntry[]` with full URLs: `https://www.anthropic.com/research/{slug}`
    - Register provider with namespace `blogs`, route `claude-code`
    - File: `providers/blogs/claude-code.ts`
    - _Requirements: 4_

  - [ ] 5.3 Write Provider tests
    - Test: `parseEmbeddedPosts` extracts posts from fixture HTML
    - Test: returns empty array for HTML without expected data
    - Test: correctly maps slug to full URL
    - Test: parses publishedOn as valid Date
    - Create HTML fixture with sample Next.js RSC data for testing
    - File: `providers/blogs/claude-code_test.ts`
    - _Requirements: 4_

- [ ] 6. Checkpoint — Provider System
  - Run `deno test providers/` to verify provider tests pass
  - Run `deno check providers/mod.ts` to verify registry compiles with provider imports

- [ ] 7. HTTP Server
  - [ ] 7.1 Implement main application
    - Create Hono app with logger middleware
    - Add `onError` handler returning appropriate status codes (404, 502)
    - Add `GET /health` endpoint returning `{"status": "ok"}`
    - Add `GET /` endpoint listing available feeds as JSON
    - Add `GET /:namespace/:route` endpoint with cache check → provider fetch → feed build → response
    - Set Content-Type `application/atom+xml; charset=utf-8` for feed responses
    - Initialize cache on startup
    - Start server with `Deno.serve` on `PORT` env (default 8000)
    - File: `main.ts`
    - _Requirements: 1, 7_

  - [ ] 7.2 Write integration tests
    - Test: `GET /health` returns 200 with status ok
    - Test: `GET /` lists available feeds
    - Test: `GET /blogs/claude-code` returns Atom XML (mock scraper)
    - Test: `GET /unknown/route` returns 404
    - Test: Content-Type header is correct for feed responses
    - File: `main_test.ts`
    - _Requirements: 1, 7_

- [ ] 8. Checkpoint — Working Server
  - Run `deno test` to verify all tests pass
  - Manually test: `deno task dev` and `curl http://localhost:8000/health`
  - Manually test: `curl http://localhost:8000/blogs/claude-code` returns Atom XML

- [ ] 9. Docker Deployment
  - [ ] 9.1 Create Dockerfile
    - Use `denoland/deno` base image
    - Install Chromium for headless browser fallback
    - Set `CHROME_BIN` environment variable
    - Cache dependencies with `deno install` and `deno cache main.ts`
    - Run as `deno` user (non-root)
    - Expose port 8000
    - Add `--allow-run` permission for Astral
    - File: `Dockerfile`
    - _Requirements: 8_

  - [ ] 9.2 Create docker-compose.yml
    - Define `app` service: build from Dockerfile, port 8000, env vars (PORT, REDIS_URL)
    - Define `redis` service: `redis:7-alpine`, volume for persistence, healthcheck
    - Add `depends_on` with health condition
    - File: `docker-compose.yml`
    - _Requirements: 8_

- [ ] 10. Final Checkpoint — Complete Verification
  - Run `deno test` — all unit and integration tests pass
  - Run `deno check main.ts` — full type check
  - Run `deno lint` — no lint errors
  - Run `docker compose build` — Docker image builds successfully
  - Run `docker compose up` and verify `curl http://localhost:8000/blogs/claude-code` returns valid Atom XML
  - Verify all 8 requirements are met:
    - [1] RSSHub-style routing works
    - [2] Provider architecture is modular
    - [3] Hybrid parsing (HTML + headless fallback)
    - [4] Anthropic blog provider works
    - [5] Valid Atom 1.0 feed generated
    - [6] Redis caching with graceful degradation
    - [7] Deno HTTP server with health endpoint
    - [8] Docker deployment ready

## Notes

- Anthropic research page uses Next.js RSC streaming — post data is embedded as JSON in `self.__next_f.push([...])`. The parsing logic in task 5.2 needs to be tested against the real page structure during implementation.
- Astral (headless browser) is dynamically imported to avoid loading Chrome binaries when not needed.
- The `@iuioiua/redis` client uses raw Redis commands — cache layer wraps this in a simple get/set API.
- For tests, network-dependent functionality (real HTTP scraping, Redis) should be mocked or tested only in integration checkpoints.
