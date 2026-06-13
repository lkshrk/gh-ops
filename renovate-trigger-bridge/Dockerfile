FROM node:22-alpine

WORKDIR /app

COPY renovate ./renovate
COPY renovate-trigger-bridge ./renovate-trigger-bridge

USER node

EXPOSE 3000

CMD ["node", "renovate-trigger-bridge/server.js"]
