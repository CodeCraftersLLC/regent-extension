# Multi-stage build for Regent Mothership

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:22-slim
RUN addgroup --system mothership && adduser --system --ingroup mothership mothership
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && chown -R mothership:mothership /app
COPY --from=build --chown=mothership:mothership /app/dist/ ./dist/
COPY --chown=mothership:mothership src/db/migrations/ ./dist/db/migrations/

ENV PORT=3001
ENV DB_PATH=/data/mothership.db
ENV LOG_LEVEL=info
VOLUME /data

RUN mkdir -p /data && chown mothership:mothership /data

USER mothership
EXPOSE 3001
CMD ["node", "dist/index.js"]
