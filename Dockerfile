# Prepared for later phases; not built or deployed in phase 1.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN npm install --no-audit --no-fund typescript@5 @types/node@22 && npx tsc -p tsconfig.json

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
RUN useradd --system --uid 10001 app && mkdir -p /app/.media && chown app /app/.media
COPY --from=build /app/dist ./dist
COPY db ./db
COPY public ./public
COPY package.json ./
USER app
EXPOSE 8787
CMD ["node", "dist/src/main.js"]
