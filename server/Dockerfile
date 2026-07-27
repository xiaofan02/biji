# biji 协同服务器镜像。用 tsx 直接运行 TypeScript(无需单独编译步骤)。
# 用 node:20-slim(Debian/glibc)而非 alpine —— 避免 esbuild(tsx 依赖)在 musl 上的兼容问题。
FROM node:20-slim

WORKDIR /app

# 先装依赖,利用 Docker 层缓存(仅 package.json 变化时才重装)
COPY package.json ./
RUN npm install --omit=dev

# 复制源码
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "run", "start"]
