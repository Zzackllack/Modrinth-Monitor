FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PNPM_HOME=/app/.pnpm-home \
    PATH="/app/node_modules/.bin:/app/.pnpm-home:${PATH}"

RUN npm install -g pnpm@10.13.1

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY playwright.config.ts ./playwright.config.ts
COPY src ./src
COPY tests ./tests

# Proxy and geo caches plus the egress journal are written at runtime.
RUN mkdir -p /app/data /app/logs

CMD ["pnpm", "run", "monitor"]
