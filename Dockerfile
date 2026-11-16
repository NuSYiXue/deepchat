# 构建阶段：装依赖并产出 dist/
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
# NODE_ENV 必须在命令内联；package.json 里的写法依赖 POSIX shell
RUN NODE_ENV=production pnpm exec rspack build -c rspack.config.ts

# 运行阶段：只要 Node 内置模块，无需 node_modules
FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server

# 数据卷：SQLite 数据库、附件原件与签名密钥都在这里
VOLUME ["/data"]
EXPOSE 3000

# 服务端是纯 TypeScript，Node 24+ 默认开启类型擦除，可直接运行
CMD ["node", "server/index.ts"]
