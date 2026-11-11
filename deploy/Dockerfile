# 智能文档填充 - Docker 镜像
# 构建: docker build -f deploy/Dockerfile -t autofill .
# 运行: docker run -d --name autofill -p 3000:3000 -e HOST=0.0.0.0 \
#         -v autofill-data:/data autofill
FROM node:20-alpine

WORKDIR /app

# 只装生产依赖
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    STORAGE_DIR=/data

RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server/index.js"]
