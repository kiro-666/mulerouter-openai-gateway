# Node + native http target. Zero runtime dependencies — nothing to install.
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787

EXPOSE 8787

# Runs the Node native-http entry; shares src/core.js with the Worker target.
CMD ["node", "src/server.js"]
