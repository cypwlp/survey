FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY cloudrun ./cloudrun
COPY web ./web

ENV PORT=80
EXPOSE 80

CMD ["node", "cloudrun/server.js"]
