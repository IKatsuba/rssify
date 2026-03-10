FROM denoland/deno:2.1.4

# Install Chromium for headless browser fallback
RUN apt-get update && apt-get install -y \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium
ENV DENO_DIR=/deno-dir

WORKDIR /app

# Cache dependencies
COPY deno.json deno.lock* ./
RUN deno install

# Copy source
COPY . .

# Cache compilation
RUN deno cache main.ts

USER deno
EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-run", "main.ts"]
