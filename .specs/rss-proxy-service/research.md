# Research: Rssify — RSS Proxy Service

## Problem Statement

Нужно создать сервис на Deno, который парсит сайты без RSS и генерирует для них
Atom-фиды. Сервис работает по принципу RSSHub — пользователь указывает URL в
определённом формате и получает фид. MVP: `claude.com/blog`.

## Problem Areas

### 1. HTTP Routing & Server

_Related requirements: 1, 2, 7_

#### Variant A: Hono — CHOSEN

**How it works:** Ultrafast web-фреймворк с нативной поддержкой Deno.
Типизированные роуты, middleware (логирование, error handling), минимальный
overhead. Providers автоматически регистрируются как Hono-роуты.

**Pros:**

- Быстрый RegExpRouter — самый быстрый роутер в JS
- Middleware из коробки (logger, error handler, CORS)
- Типизированные параметры роутов
- Нативная поддержка Deno, работает с `Deno.serve`
- Активное сообщество, регулярные обновления (v4.12+)

**Cons:**

- Дополнительная зависимость (хотя легковесная)

**Effort:** Low | **Risk:** Low

**Why chosen:** Идеальный баланс между простотой и функциональностью. Встроенные
middleware покрывают требования логирования и обработки ошибок без
дополнительного кода.

#### Variant B: @std/http route — Rejected

**How it works:** Встроенный в Deno std роутинг через URLPattern. Нулевые
зависимости.

**Pros:**

- Нет внешних зависимостей
- Часть Deno стандартной библиотеки

**Cons:**

- API помечен как `unstable-route`
- Нет middleware — логирование, error handling нужно писать вручную
- Менее удобный API для динамических маршрутов

**Effort:** Medium | **Risk:** Medium

**Why rejected:** Больше boilerplate-кода для базовых задач (логирование,
ошибки). Unstable API — риск breaking changes.

#### Variant C: URLPattern вручную — Rejected

**How it works:** Голый `Deno.serve` + ручной маппинг URLPattern на handlers.

**Pros:**

- Нулевые зависимости, максимальный контроль

**Cons:**

- Весь middleware-стек нужно писать с нуля
- Больше кода, больше потенциальных багов

**Effort:** High | **Risk:** Low

**Why rejected:** Слишком много ручной работы для задачи, которую Hono решает
элегантно.

---

### 2. HTML Parsing

_Related requirements: 3, 4_

#### Variant A: deno-dom — CHOSEN

**How it works:** Нативная реализация DOM для Deno, написана на Rust/WASM.
Поддерживает стандартный DOM API: `querySelector`, `querySelectorAll`,
`textContent`, `getAttribute`.

**Pros:**

- Написана специально для Deno — максимальная совместимость
- Быстрая (Rust + WASM)
- Стандартный DOM API — привычный код
- Доступна на JSR (`jsr:@b-fuze/deno-dom`)
- Высокий Benchmark Score (84.7)

**Cons:**

- Не полная реализация DOM (достаточна для парсинга)

**Effort:** Low | **Risk:** Low

**Why chosen:** Нативная библиотека для Deno с высокой производительностью и
стандартным DOM API. Идеально подходит для задачи парсинга HTML-страниц.

#### Variant B: linkedom — Rejected

**How it works:** npm-совместимая DOM-реализация через `npm:linkedom`.

**Pros:**

- Полная реализация DOM API
- Кроссплатформенная

**Cons:**

- npm-зависимость, тяжелее deno-dom
- Не оптимизирована для Deno

**Effort:** Low | **Risk:** Low

**Why rejected:** Нет преимуществ перед deno-dom для задачи парсинга.
Дополнительный вес без пользы.

#### Variant C: cheerio — Rejected

**How it works:** jQuery-подобный API для парсинга HTML через `npm:cheerio`.

**Pros:**

- Знакомый API из Node.js экосистемы
- Хорошо подходит для scraping

**Cons:**

- Не DOM-совместимый API
- npm-зависимость
- Другая ментальная модель (jQuery vs DOM)

**Effort:** Low | **Risk:** Low

**Why rejected:** Нестандартный API. deno-dom даёт стандартный DOM, что проще и
универсальнее.

---

### 3. Headless Browser (Fallback)

_Related requirements: 3_

#### Variant A: Astral — CHOSEN

**How it works:** Высокоуровневая Puppeteer-подобная библиотека, написанная
специально для Deno. Автоматически скачивает Chrome, предоставляет API для
навигации, ожидания и извлечения контента.

**Pros:**

- Написана с нуля для Deno — нативная интеграция
- Доступна на JSR (`jsr:@astral/astral`)
- Простой API: `launch()`, `page.goto()`, `page.evaluate()`
- Автоматическая загрузка Chromium
- Активно поддерживается

**Cons:**

- Требует Chrome/Chromium в Docker-образе
- Более тяжёлый по ресурсам (как любой headless browser)

**Effort:** Low | **Risk:** Medium

**Why chosen:** Нативная Deno-библиотека, простой API, активная поддержка.
Лучший выбор для Deno-проекта.

#### Variant B: Puppeteer for Deno — Rejected

**How it works:** Порт Puppeteer для Deno через `deno.land/x/puppeteer`.

**Pros:**

- Знакомый API из Node.js
- Большая экосистема рецептов и решений

**Cons:**

- Последнее обновление давно — может быть устаревшим
- Не на JSR, только на deno.land/x
- Менее нативная интеграция с Deno

**Effort:** Low | **Risk:** High

**Why rejected:** Потенциально заброшенный проект. Astral активно развивается и
лучше интегрирован с Deno.

---

### 4. Atom Feed Generation

_Related requirements: 5_

#### Variant A: @feed/feed — CHOSEN

**How it works:** JSR-библиотека для генерации Atom/RSS/JSON Feed. Нулевые
зависимости, простой API: создаёшь `Atom`, добавляешь items, вызываешь
`build()`.

**Pros:**

- Доступна на JSR (`jsr:@feed/feed`)
- Поддерживает Atom 1.0, RSS 2.0, JSON Feed
- Нулевые зависимости
- Простое API: `new Atom(config)`, `addItem()`, `build()`
- Автоматическое экранирование XML

**Cons:**

- Относительно новая библиотека

**Effort:** Low | **Risk:** Low

**Why chosen:** Готовое решение с правильным экранированием XML и поддержкой
Atom 1.0. Экономит время и снижает риск ошибок.

#### Variant B: Ручная генерация XML — Rejected

**How it works:** Сборка Atom XML через template literals с ручным
экранированием.

**Pros:**

- Нулевые зависимости
- Полный контроль над форматом

**Cons:**

- Нужно самостоятельно экранировать XML (потенциал для ошибок)
- Больше кода для поддержки
- Нужно самим проверять соответствие RFC 4287

**Effort:** Medium | **Risk:** Medium

**Why rejected:** Ручное экранирование XML — источник багов. @feed/feed решает
эту задачу надёжнее.

---

### 5. Redis Client

_Related requirements: 6_

#### Variant A: @iuioiua/redis — CHOSEN

**How it works:** Минимальный Redis-клиент для Deno от того же автора, что и
r2d2 (замена r2d2). Работает напрямую с Redis-командами через `sendCommand`.

**Pros:**

- Быстрый (наследник r2d2, который был 1.4x быстрее denodrivers)
- Минимальный, легковесный
- Нативный Deno — использует `Deno.connect`
- Прямая работа с Redis-командами — нет абстракций

**Cons:**

- Низкоуровневый API — нужно знать Redis-команды
- Нет высокоуровневых абстракций (pipelines, clustering)

**Effort:** Low | **Risk:** Low

**Why chosen:** Максимальная производительность при минимальном footprint. Для
задачи кеширования (GET/SET с TTL) высокоуровневые абстракции не нужны.

#### Variant B: denodrivers/redis — Rejected

**How it works:** Высокоуровневый Redis-клиент с поддержкой кластеров,
пайплайнов, клиентского кеша.

**Pros:**

- Богатый API: `.set()`, `.get()`, `.subscribe()`
- Поддержка кластеров и пайплайнов

**Cons:**

- Медленнее @iuioiua/redis
- Избыточен для задачи простого кеширования
- Помечен как "experimental"

**Effort:** Low | **Risk:** Low

**Why rejected:** Избыточные возможности. Для GET/SET с TTL хватит минимального
клиента.

#### Variant C: npm:ioredis — Rejected

**How it works:** Популярный Node.js Redis-клиент через npm-совместимость Deno.

**Pros:**

- Зрелый, проверенный клиент
- Богатый API

**Cons:**

- Самый медленный вариант (2.9x медленнее r2d2)
- npm-зависимость, не нативный для Deno
- Избыточен

**Effort:** Low | **Risk:** Low

**Why rejected:** Медленнее нативных вариантов, npm-зависимость без преимуществ.

---

## Summary

| Problem Area          | Chosen Variant | Effort | Risk   |
| --------------------- | -------------- | ------ | ------ |
| HTTP Routing & Server | Hono           | Low    | Low    |
| HTML Parsing          | deno-dom       | Low    | Low    |
| Headless Browser      | Astral         | Low    | Medium |
| Atom Feed Generation  | @feed/feed     | Low    | Low    |
| Redis Client          | @iuioiua/redis | Low    | Low    |

## Tech Stack

| Компонент        | Пакет                  | Источник |
| ---------------- | ---------------------- | -------- |
| HTTP framework   | `jsr:@hono/hono`       | JSR      |
| HTML parsing     | `jsr:@b-fuze/deno-dom` | JSR      |
| Headless browser | `jsr:@astral/astral`   | JSR      |
| Atom generation  | `jsr:@feed/feed`       | JSR      |
| Redis client     | `jsr:@iuioiua/redis`   | JSR      |

## Codebase Insights

- Проект начинается с нуля — нет legacy-ограничений
- Все зависимости доступны на JSR — единый реестр, нативный для Deno
- Provider-архитектура позволит легко добавлять новые источники
- Гибридный подход (HTML scraping → headless browser fallback) требует Chrome в
  Docker-образе

## Open Questions

- [ ] Точная структура HTML на `anthropic.com/research` / `claude.com/blog` —
      нужно исследовать при реализации provider'а
- [ ] Конфигурация Chrome в Docker — нужно ли использовать
      `chrome-headless-shell` или полный Chrome
- [ ] Формат `REDIS_URL` — стандартный `redis://host:port` или кастомный

## Next Steps

Ready for `/spec-design rss-proxy-service` to create the technical design based
on these chosen solutions.
