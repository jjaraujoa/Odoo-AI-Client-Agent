FROM node:24.15.0-alpine3.22

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
    && pnpm install --prod --frozen-lockfile --ignore-scripts \
    && pnpm store prune
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
