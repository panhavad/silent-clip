FROM docker:27-cli
RUN apk add --no-cache git nodejs
WORKDIR /updater
COPY updater.js package.json ./
ENTRYPOINT ["node", "updater.js"]
