# Kokoro-82M text to speech for Sylva tips. Built and pushed by
# `wrangler deploy` in workers/edge (see [[containers]] in wrangler.toml).

FROM node:22-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
# No install scripts: onnxruntime-node ships its CPU build in the package.
RUN npm ci --ignore-scripts --omit=dev
COPY prepare.sh ./
RUN sh prepare.sh /build/node_modules /app

FROM node:22-slim
WORKDIR /app
COPY --from=build /app /app
COPY server.mjs vocab.mjs ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
