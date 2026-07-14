# Build + run the KobeDB server.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/server/package.json ./packages/server/package.json
RUN npm install --workspaces --include-workspace-root --omit=optional || npm install
COPY packages/server ./packages/server
RUN npm run build --workspace @kobedb/server

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# postgresql-client provides pg_dump / pg_restore for the backup & restore API.
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY packages/server/src/studio ./packages/server/dist/studio
EXPOSE 8000
CMD ["node", "packages/server/dist/index.js"]
