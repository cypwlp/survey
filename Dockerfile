# 微信雲托管用的建置檔。
# 雲托管「代碼倉庫 / 本地代碼」部署時只認倉庫根目錄的 Dockerfile，
# 所以這裡多放一份，內容就是 server/ 那顆（把服務程式裝進映像）。
# 自架／213 Docker 那條路仍然用 server/Dockerfile + server/docker-compose.yml。
FROM node:20-alpine

WORKDIR /app

# 只裝生產依賴（先複製 lockfile 以利用層快取）
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server/src ./src

ENV NODE_ENV=production
# 雲托管容器監聽埠預設是 80（服務設置裡也要填 80）
ENV PORT=80
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:80/api/health || exit 1

CMD ["node", "src/index.js"]
