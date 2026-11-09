FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json ./
COPY package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Shared with the Python scraper; also holds Baileys auth state and JSON config.
ENV DATA_DIR=/data
RUN mkdir -p /data

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
