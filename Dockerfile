FROM node:22-slim AS deps
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
COPY /certificates ./certificates
RUN npm ci --omit=dev

FROM node:22-slim AS runner
WORKDIR /usr/src/app
ENV NODE_ENV=production

COPY --from=deps --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --chown=node:node . .

USER node

EXPOSE 3001

CMD ["npx", "tsx", "server.js"]
