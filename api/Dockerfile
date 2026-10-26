# Build stage
FROM node:22-alpine AS build
WORKDIR /app

ARG APP_VERSION=0.1.0
ARG BUILD_DATE
ARG GIT_COMMIT

COPY package*.json ./
RUN npm ci

COPY . .

RUN if [ ! -f VERSION ]; then \
      echo "${APP_VERSION}" > VERSION; \
    fi

RUN npm run build

# Production stage
FROM node:22-alpine AS runner
WORKDIR /app

ARG APP_VERSION=0.1.0
ARG BUILD_DATE
ARG GIT_COMMIT

# curl is for the container health check.
RUN apk add --no-cache curl

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/VERSION /app/VERSION

LABEL org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.title="Cadence API"

ENV PORT=5001
ENV CADENCE_VERSION="${APP_VERSION}"
ENV CADENCE_BUILD_DATE="${BUILD_DATE}"
ENV CADENCE_GIT_COMMIT="${GIT_COMMIT}"

# The API only talks to Postgres and the network; it needs no write access to its own files.
USER node

EXPOSE 5001

CMD ["node", "dist/index.js"]
