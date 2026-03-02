# Multi-stage build for Regent Mothership

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ ./dist/
COPY src/db/migrations/ ./dist/db/migrations/

ENV PORT=3001
ENV DB_PATH=/data/mothership.db
ENV LOG_LEVEL=info
VOLUME /data

EXPOSE 3001
CMD ["node", "dist/index.js"]
