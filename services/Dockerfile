# One image recipe for every service: docker build --build-arg SERVICE=user-service .
FROM node:24-alpine
ARG SERVICE
WORKDIR /app

COPY package.json package-lock.json ./
COPY common/package.json common/
COPY user-service/package.json user-service/
COPY post-service/package.json post-service/
COPY feed-service/package.json feed-service/
RUN npm ci --omit=dev --workspace ${SERVICE} --workspace common && npm cache clean --force

COPY common common
COPY ${SERVICE} ${SERVICE}

ENV NODE_ENV=production
WORKDIR /app/${SERVICE}
USER node
CMD ["node", "src/index.js"]
