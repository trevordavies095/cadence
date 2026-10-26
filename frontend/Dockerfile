# Build stage
FROM node:22-alpine AS build
WORKDIR /app

ARG APP_VERSION=0.1.0
ARG BUILD_DATE
ARG GIT_COMMIT
# Next.js reads these when it builds, not when the container starts: the /api proxy is
# written into the image. The compose service is called "api", listening on 5001.
ARG API_SERVICE_URL=http://api:5001
# Coach replies can take minutes; keep this above the API's own cap (default 15 min).
ARG FRONTEND_PROXY_TIMEOUT_MS=960000

COPY package*.json ./
RUN npm ci

COPY . .

RUN if [ ! -f VERSION ]; then \
      echo "${APP_VERSION}" > VERSION; \
    fi

ENV NEXT_PUBLIC_VERSION=$APP_VERSION
ENV NEXT_PUBLIC_BUILD_DATE=$BUILD_DATE
ENV NEXT_PUBLIC_GIT_COMMIT=$GIT_COMMIT
ENV API_SERVICE_URL=$API_SERVICE_URL
ENV FRONTEND_PROXY_TIMEOUT_MS=$FRONTEND_PROXY_TIMEOUT_MS
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# Production stage
FROM node:22-alpine AS runner
WORKDIR /app

ARG APP_VERSION=0.1.0
ARG BUILD_DATE
ARG GIT_COMMIT

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build /app/VERSION /app/VERSION

LABEL org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.title="Cadence Frontend"

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV CADENCE_VERSION="${APP_VERSION}"
ENV CADENCE_BUILD_DATE="${BUILD_DATE}"
ENV CADENCE_GIT_COMMIT="${GIT_COMMIT}"

USER node

EXPOSE 3000

CMD ["node", "server.js"]
