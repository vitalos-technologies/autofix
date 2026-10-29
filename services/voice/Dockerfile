# syntax=docker/dockerfile:1.7
# autofix-voice: the AI front desk on calls (Twilio ConversationRelay + Claude). Multi-stage, non-root.
ARG NODE_IMAGE=node:22.21.1-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
