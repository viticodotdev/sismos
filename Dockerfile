# Self-hosted build. Bun runtime — no build step beyond install; the app runs
# straight from TS via src/index.ts.
FROM oven/bun:1 AS base
WORKDIR /app

# Install deps first (layer cache), then copy source.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .
ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "src/index.ts"]