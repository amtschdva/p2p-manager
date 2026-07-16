# All dependencies are pure JavaScript now (no native builds needed)
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
# data/ (uploads, vendor KYC docs, branding) is a bind mount owned by uid 1000
RUN mkdir -p data && chown -R node:node /app
USER node
# 9139 = combined app / core; 9140 = standalone vendor portal (src/vendor-server.js)
EXPOSE 9139 9140
CMD ["node", "src/server.js"]
