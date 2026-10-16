# 微信群公告問卷 — 後端 API
# 部署到 10.241.50.213 的 Docker（內網機器，由 10.241.48.3 反向代理對外）
FROM node:20-alpine

WORKDIR /app

# 只裝生產依賴（先複製 lockfile 以利用層快取）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

# 健康檢查：容器編排可據此判斷是否存活（/api/health 會回 DB 連線狀況）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "src/index.js"]
