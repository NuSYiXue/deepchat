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

## 部署

需要一台常开、装好 Docker 的机器。镜像由 GitHub Actions 自动构建并发布到 GHCR，
服务器上不需要装 Node，也不用构建前端。

### 1. 拿到文件

```sh
git clone https://github.com/NuSYiXue/deepchat.git
cd deepchat
```

没有 `git` 就在仓库页面点 **Code → Download ZIP**，解压后进入目录。

### 2. 设置访问密码

这是唯一必须提前配的东西——没有密码进不了界面。

```sh
cp .env.example .env
```

打开 `.env`，找到这一行：

```ini
APP_PASSWORD=
```

在等号后面写上你自己定的密码，比如：

```ini
APP_PASSWORD=wo-de-mi-ma-2026
```

密码随便定，20 位左右、别用常见词就行。**等号左边不要动，只改等号右边。**

> 留空会启动失败并提示 `APP_PASSWORD is missing a value`。这是故意的——空密码
> 等于没有登录保护。

### 3. 启动

```sh
docker compose pull
docker compose up -d
docker compose logs -f
```

看到 `listening on http://0.0.0.0:3000` 就是成功了，按 Ctrl+C 退出日志。

### 4. 打开并配置

浏览器访问 <http://localhost:3000>，用刚才设的密码登录。

接下来都在界面里完成，不用回到命令行：

- **填 DeepSeek API Key**：设置 → 模型 → DeepSeek 那一行点「编辑」→ 粘贴 Key → 确定。
  右上角圆点是红的就是还没填。
- **添加其他端点**：同一个页面点「添加端点」，支持 Anthropic 和 OpenAI 两种方言，
  填完可以点「获取可用模型」拉列表。
- **人设**：设置 → 人设，新建或修改 system prompt。

> `.env` 里的 `DEEPSEEK_API_KEY` 是可选的。它的作用只是让第一次启动时自动把 Key
> 配好，省掉上面那一步。不填完全没问题，界面里填完效果一样。

### 5. 局域网访问

```sh
ip addr | grep 'inet ' | grep -v 127.0.0.1     # Linux 查本机 IP
ipconfig                                        # Windows
```

手机连同一个 WiFi，打开 `http://<上面查到的 IP>:3000`，用同一个密码登录。
会话、附件、设置都存服务端，多台设备看到的是同一份。

> 内网走 HTTP 时语音输入不可用（浏览器要求 HTTPS 才给麦克风权限），按钮会置灰。
> 其他功能不受影响。要语音就配公网 HTTPS，见下一节。

### 6. 公网访问（可选）

服务端只监听明文 HTTP，不处理 TLS。公网需要自己在前面加一层反向代理，
完整配置清单见 [docs/deployment.md](docs/deployment.md)。

---

## 日常运维

**更新**（`latest` 跟随 main 最新构建）：

```sh
cd deepchat
docker compose pull
docker compose up -d
```

**备份**（`data/` 是全部状态，含登录密钥）：

```sh
docker compose stop
sudo tar czf deepchat-$(date +%F).tar.gz data/
docker compose start
```

恢复：`docker compose down` → 解开归档 → `docker compose up -d`。
丢了 `data/secret` 会导致所有设备重新登录，丢了 `data/app.db` 就是全部会话丢失。

**停止**：

```sh
docker compose stop      # 停止，保留容器
docker compose down      # 停止并删除容器（./data 不动）
```

---

## 从源码跑

想改代码时：

```sh
pnpm install
pnpm dev
```

`pnpm dev` 同时启动 3000 端口的 API 服务与 <http://localhost:8090> 的前端开发服务器，
并把 `/api` 代理到后端。打开 <http://localhost:8090>。

需要 Node.js 24 及以上和 pnpm。

在本机跑生产构建用 `pnpm serve`（先构建 `dist/` 再在 3000 端口启动）。
用 Docker 但想跑本地源码，取消 `docker-compose.yml` 里 `build: .` 的注释，
然后 `docker compose up -d --build`。

## 配置

配置全部来自环境变量。本地开发可写入 `.env`；Docker Compose 会自动读取该文件。

| 变量 | 用途 |
| --- | --- |
| `APP_PASSWORD` | 所有设备共用的访问密码。Docker 部署必填；**留空表示关闭登录**，仅适合本机调试。 |
| `DEEPSEEK_API_KEY` | **可选。** 填了会在首次启动时预置内置端点的 Key；不填就在界面里配（设置 → 模型），效果一样。 |
| `API_ORIGIN` | 可选：播种端点的地址，默认 `https://api.deepseek.com`。 |
| `API_MODEL` | 可选：播种端点的默认模型名，默认 `deepseek-flash`。 |
| `DEEPCHAT_IMAGE` | 仅 Docker：要运行的镜像，默认 `ghcr.io/nusyixue/deepchat:latest`。 |
| `DATA_DIR` | 仅本机直跑：数据库、附件与签名密钥的目录。Docker 下被固定为 `/data`，此处无效。默认 `./data`。 |
| `PORT` | 仅本机直跑：监听端口。Docker 下被固定为 `3000`，此处无效。 |

Docker 部署时 `DATA_DIR` 与 `PORT` 由 `docker-compose.yml` 写死，改 `.env` 不起作用；
要换宿主目录请改 compose 里的 `volumes`（`- ./data:/data` 左边那段）。

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

## 关于 GHCR 镜像

- 仓库是公开的，所以 GHCR 上的镜像也是公开的，**拉取不需要登录**。
- 如果你把仓库改成私有，镜像会跟着变私有，届时需要先登录一次：

  ```sh
  echo <你的 GitHub PAT> | docker login ghcr.io -u <你的用户名> --password-stdin
  ```

  PAT 只需勾选 `read:packages` 权限。

- 可用标签：`latest`（main 最新构建）、`main`（同上）、`sha-xxxxxxx`（某个提交）、
  `v0.2.0`（打了 `v*` 标签时）。生产环境建议固定到 `sha-` 或版本号，避免意外升级。

## 反向代理要点

完整的 NPM 配置清单、流式输出注意事项、备份恢复与已验证环境见
[docs/deployment.md](docs/deployment.md)。

反代里最容易漏的两项：

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
