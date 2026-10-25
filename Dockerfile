FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY services ./services
COPY shared ./shared
COPY packages ./packages
COPY apps/api-gateway ./apps/api-gateway
COPY scripts ./scripts
COPY tests ./tests
USER node
CMD ["node","services/menu/src/server.mjs"]
