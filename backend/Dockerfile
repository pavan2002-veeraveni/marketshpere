# Multi-stage Dockerfile for MarketSphere Backend & BullMQ Workers
FROM node:22-alpine AS builder
WORKDIR /app

RUN apk add --no-cache openssl

COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci

COPY tsconfig.json ./
COPY src ./src/
RUN npx prisma generate && npm run build

FROM node:22-alpine AS production
WORKDIR /app

RUN apk add --no-cache openssl && \
    addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/uploads && chown -R appuser:appgroup /app

USER appuser
ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "dist/server.js"]
