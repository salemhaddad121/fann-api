# Official images via AWS's mirror: avoids Docker Hub auth/rate limits, and
# older Docker Desktop builds choke on docker.io's Let's Encrypt chain.
# ---- Stage 1: build ----
FROM public.ecr.aws/docker/library/node:22-alpine AS builder
WORKDIR /app

# bcrypt ships no musl prebuilds, so it compiles from source on alpine
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- Stage 2: runtime ----
FROM public.ecr.aws/docker/library/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

EXPOSE 4000
CMD ["node", "dist/main"]
