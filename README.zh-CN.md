# DeepChat

[English](README.md) | 简体中文

> **这是一个衍生分支。** DeepChat 基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 改造，
> 原项目采用 MIT 协议，版权归 Copyright (c) 2026 DeepSeek 所有。上游是一个纯浏览器端的静态示例；
> 本分支增加了 Node 服务端，使其可以自建部署、多端共用。协议细节见[许可证](#许可证)。

DeepChat 是一个面向 DeepSeek 兼容接口的聊天界面，改造成可自建的服务端应用。一个 Node 进程
同时提供前端页面与 API，局域网内任何浏览器（或经自己的反代暴露到公网）都能用，会话集中
存放而不是散落在各个浏览器里。

相对上游的改动：

- 会话、附件和设置存在服务端的 SQLite 里，不再按浏览器分散在 IndexedDB；
- API Key 只留在服务端，不会下发到浏览器；
- 多台设备共享同一份数据，不需要任何同步步骤；
- 可以登记多个端点与模型，不再只支持 DeepSeek 官方。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。
- **人设**：可命名的 system prompt，按会话选择。内置默认人设不可修改、不可删除；会话有消息后不能再切换。
- **自定义端点与模型**：支持任何 Anthropic 或 OpenAI 方言的端点，可拉取其模型列表，并为每个模型配置输入类型、上下文窗口、输出上限和推理等级。
- **按模型配置推理**：内置 DeepSeek 端点保留原有的「深度思考」开关；自定义端点的模型改用自己的推理等级设置。
- **搜索**：模型可声明原生联网搜索；不支持时可由内置 DeepSeek 端点代为搜索。

## 快速开始（Docker）

镜像由 GitHub Actions 自动构建，发布到 GitHub Container Registry。

```sh
cat > .env <<EOF
APP_PASSWORD=$(openssl rand -base64 24)
DEEPSEEK_API_KEY=sk-你的key
DEEPCHAT_IMAGE=ghcr.io/<你的用户名>/<你的仓库名>:latest
EOF

docker compose pull
docker compose up -d
```

打开 <http://localhost:3000>，用 `APP_PASSWORD` 登录。

GHCR 上的包如果是私有的，先登录一次：

```sh
echo <你的 GitHub PAT> | docker login ghcr.io -u <你的用户名> --password-stdin
```

## 快速开始（源码）

需要 Node.js 24 及以上（服务端直接用原生类型擦除运行 TypeScript）和 pnpm。

```sh
pnpm install
pnpm dev
```

`pnpm dev` 会同时启动 3000 端口的 API 服务与 <http://localhost:8090> 的前端开发服务器，
并把 `/api` 代理到后端。打开 <http://localhost:8090> 。

在本机跑生产构建：

```sh
pnpm serve
```

该命令先构建 `dist/`，然后在 <http://localhost:3000> 启动服务。

## 配置

配置全部来自环境变量。本地开发可写入 `.env`；Docker Compose 会自动读取该文件。

| 变量 | 用途 |
| --- | --- |
| `APP_PASSWORD` | 所有设备共用的访问密码。**留空表示关闭登录**，仅适合本机调试。 |
| `DATA_DIR` | SQLite 数据库、附件原件与 Cookie 签名密钥的存放目录，默认 `./data`。 |
| `PORT` | 监听端口，默认 `3000`。 |
| `DEEPSEEK_API_KEY` | **仅首次启动**用于创建内置端点与默认模型；之后在界面里改过的配置不会被覆盖。 |
| `API_ORIGIN` | 可选：播种端点的地址，默认 `https://api.deepseek.com`。 |
| `API_MODEL` | 可选：播种端点的默认模型名，默认 `deepseek-flash`。 |
| `DEEPCHAT_IMAGE` | 仅 Docker：要运行的镜像，默认 `ghcr.io/nusyixue/deepchat:latest`。 |

服务端始终以明文 HTTP 监听，不处理 TLS。公网 HTTPS 访问请在前面加一层反向代理。

## 数据

所有内容都在 `DATA_DIR` 下：

| 路径 | 内容 |
| --- | --- |
| `app.db`（含 `-wal`、`-shm`） | SQLite 数据库：会话、消息、人设、端点、模型、附件元数据 |
| `files/` | 附件原件 |
| `secret` | Cookie 签名密钥，丢失会导致所有设备需要重新登录 |

备份时停掉服务再整体拷贝该目录，或用应用内导出（ZIP 归档，不含 API Key 与设置）。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部会话与附件；端点、模型、人设和访问密码保留。

## 部署

反向代理清单、流式输出注意事项、备份恢复与已验证环境见 [docs/deployment.md](docs/deployment.md)。

反代最容易漏的两项：

```nginx
proxy_buffering off;          # 不设会导致回复一次性蹦出，而不是逐字流式
client_max_body_size 100m;    # 不设会导致上传附件 413
```

## 开发

| 命令          | 用途                     |
| ------------- | ------------------------ |
| `pnpm dev`    | 同时启动后端与前端开发服务器 |
| `pnpm build`  | 构建前端到 `dist/`       |
| `pnpm start`  | 用已有的 `dist/` 启动服务 |
| `pnpm serve`  | 先构建再启动服务          |
| `pnpm type`   | TypeScript 类型检查      |
| `pnpm lint`   | oxlint 检查              |
| `pnpm format` | oxfmt 格式化             |

```text
server/                  HTTP 服务、认证、SQLite、上游转发
  routes/                chat、config、sessions
  search.ts              搜索兜底（借用支持搜索的端点）
  url.ts                 按方言构造上游地址
  db.ts                  schema、迁移、播种
src/
  app/                   应用布局、主题与全局样式
  components/            聊天、设置、Markdown 等界面组件
  i18n/                  中英文文案
  services/
    api/                 对话请求、SSE 解析与协议类型
    chat/                会话、消息分支、历史导入导出
    markdown/            Markdown 解析、代码高亮与图表
    server/              自建配置与会话接口的客户端
    speech/              录音与朗读
  utils/                 通用工具
scripts/dev.mjs          开发启动器（后端 + 开发服务器）
```

前端使用 Anthropic Messages 协议并带上 DeepSeek 的私有扩展（`latest_reminder`、
`safety_check`、`title`、`deepseek_web_search`、`deepseek_read_url`）。OpenAI 方言的
端点在服务端做双向转换，界面不需要知道上游是谁。

### 持续集成

- `.github/workflows/ci.yml`：每次 push 与 PR 做类型检查、lint、构建，外加服务端冒烟测试。
- `.github/workflows/docker.yml`：main 分支与 `v*` 标签触发，构建并推送镜像到 GHCR。

## 许可证

MIT。本项目是 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 的衍生作品：

> MIT License — Copyright (c) 2026 DeepSeek

按 MIT 协议要求，原始版权声明保留在 [LICENSE](LICENSE) 中。本分支的修改与新增内容同样以
MIT 协议发布。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自
的许可证。
