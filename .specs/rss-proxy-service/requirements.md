# Requirements Document

## Introduction

Rssify — сервис на Deno, который выступает прослойкой для генерации RSS (Atom) фидов для блогов и сайтов, не предоставляющих собственный RSS. Сервис работает по принципу RSSHub: пользователь указывает в своём RSS-ридере URL сервиса в определённом формате (например, `/blogs/claude-code`), и получает Atom-фид с актуальными постами. MVP включает поддержку только `claude.com/blog`.

## Glossary

- **Route** — маршрут сервиса, соответствующий конкретному источнику контента (например, `/blogs/claude-code`)
- **Provider** — модуль, реализующий логику парсинга для конкретного сайта или типа сайтов
- **Atom feed** — XML-документ в формате Atom 1.0 (RFC 4287), описывающий список записей
- **Scraping** — извлечение структурированных данных из HTML-страниц
- **Headless browser** — браузер без UI, используемый для рендеринга JS-heavy страниц

## Requirements

### Requirement 1: Routing по формату RSSHub

**User Story:** Как пользователь RSS-ридера, я хочу указать URL вида `https://rssify.example.com/blogs/claude-code` и получить Atom-фид, чтобы подписаться на блог без нативной RSS-поддержки.

#### Acceptance Criteria

1. THE сервис SHALL обрабатывать HTTP GET-запросы по маршрутам вида `/<namespace>/<route-params>`
2. THE сервис SHALL маппить маршрут на соответствующий provider
3. WHEN маршрут не соответствует ни одному зарегистрированному provider THEN сервис SHALL вернуть HTTP 404 с понятным сообщением об ошибке
4. THE сервис SHALL возвращать ответ с Content-Type `application/atom+xml; charset=utf-8`

### Requirement 2: Provider-архитектура

**User Story:** Как разработчик, я хочу легко добавлять новые источники контента, реализуя provider-модуль с единым интерфейсом.

#### Acceptance Criteria

1. THE система SHALL определять единый интерфейс provider, включающий: namespace, описание маршрутов и функцию получения записей
2. THE система SHALL автоматически регистрировать providers из директории `providers/`
3. WHEN добавляется новый provider THEN он SHALL быть доступен по соответствующему маршруту без изменения кода роутера
4. THE provider SHALL возвращать массив записей с полями: `title`, `link`, `content`, `published`, `id`

### Requirement 3: Парсинг контента (гибридный подход)

**User Story:** Как пользователь, я хочу получать актуальный контент независимо от того, рендерится ли сайт на сервере или клиенте.

#### Acceptance Criteria

1. THE provider SHALL сначала пытаться получить контент через HTTP-запрос и парсинг HTML
2. WHEN HTML-парсинг не возвращает ожидаемых данных (страница требует JS-рендеринга) THEN provider SHALL использовать headless browser (Puppeteer) как fallback
3. THE система SHALL использовать библиотеку для парсинга HTML (deno-dom или аналог) для извлечения данных из DOM
4. THE provider SHALL корректно обрабатывать ошибки сети и парсинга, возвращая понятные сообщения

### Requirement 4: Provider для claude.com/blog (MVP)

**User Story:** Как пользователь, я хочу подписаться на блог Anthropic (claude.com/blog) через RSS-ридер.

#### Acceptance Criteria

1. THE provider SHALL быть доступен по маршруту `/blogs/claude-code`
2. THE provider SHALL парсить страницу `https://www.anthropic.com/research` (или соответствующую страницу блога)
3. THE provider SHALL извлекать из каждого поста: заголовок, дату публикации, краткое описание и ссылку на полный пост
4. THE provider SHALL генерировать уникальный `id` для каждой записи на основе URL поста
5. WHEN пост содержит категорию/тег THEN provider SHALL включать её в запись фида как `category`

### Requirement 5: Генерация Atom 1.0 фида

**User Story:** Как RSS-ридер, я хочу получать валидный Atom 1.0 XML, чтобы корректно отображать записи.

#### Acceptance Criteria

1. THE сервис SHALL генерировать XML-документ, соответствующий спецификации Atom 1.0 (RFC 4287)
2. THE фид SHALL включать обязательные элементы: `<feed>`, `<title>`, `<link>`, `<updated>`, `<id>`, `<author>`
3. EACH запись SHALL включать: `<entry>`, `<title>`, `<link>`, `<id>`, `<updated>`, `<summary>` или `<content>`
4. THE фид SHALL корректно экранировать HTML-контент внутри XML
5. THE фид SHALL использовать кодировку UTF-8

### Requirement 6: Кеширование через Redis

**User Story:** Как оператор сервиса, я хочу минимизировать нагрузку на целевые сайты и ускорить ответы, кешируя результаты парсинга.

#### Acceptance Criteria

1. THE сервис SHALL подключаться к Redis для хранения закешированных фидов
2. WHEN фид запрашивается и есть валидный кеш THEN сервис SHALL вернуть данные из кеша без обращения к целевому сайту
3. THE кеш SHALL иметь настраиваемый TTL (по умолчанию 15 минут)
4. WHEN кеш истёк или отсутствует THEN сервис SHALL выполнить парсинг и сохранить результат в кеш
5. WHEN Redis недоступен THEN сервис SHALL продолжать работу, выполняя парсинг при каждом запросе (graceful degradation)
6. THE подключение к Redis SHALL настраиваться через переменную окружения `REDIS_URL`

### Requirement 7: HTTP-сервер на Deno

**User Story:** Как оператор, я хочу запустить сервис командой `deno run` с минимальной конфигурацией.

#### Acceptance Criteria

1. THE сервис SHALL использовать встроенный HTTP-сервер Deno (`Deno.serve`)
2. THE сервис SHALL слушать порт, заданный переменной окружения `PORT` (по умолчанию `8000`)
3. THE сервис SHALL предоставлять эндпоинт `GET /health` для проверки работоспособности
4. THE сервис SHALL логировать входящие запросы (метод, URL, статус, время ответа)
5. THE сервис SHALL корректно обрабатывать graceful shutdown по SIGTERM/SIGINT

### Requirement 8: Docker-деплоймент

**User Story:** Как оператор, я хочу развернуть сервис через Docker на VPS.

#### Acceptance Criteria

1. THE проект SHALL содержать `Dockerfile` для сборки production-образа
2. THE Dockerfile SHALL использовать официальный образ Deno
3. THE проект SHALL содержать `docker-compose.yml` с сервисами: приложение + Redis
4. THE образ SHALL быть оптимизирован по размеру (multi-stage build если нужно)
5. THE контейнер SHALL запускаться от непривилегированного пользователя
