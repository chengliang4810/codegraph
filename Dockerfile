FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
RUN chmod +x dist/bin/codegraph.js

RUN mkdir -p /data/repos /root/.codegraph

EXPOSE 3100

ENTRYPOINT ["node", "dist/bin/codegraph.js"]
CMD ["serve", "--http", "--config", "/root/.codegraph/server.json"]
