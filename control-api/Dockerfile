FROM node:22-alpine

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
    && pnpm install --prod --frozen-lockfile --ignore-scripts \
    && pnpm store prune

COPY src ./src
COPY bin ./bin

ENV NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

USER node
CMD ["node", "src/server.js"]
