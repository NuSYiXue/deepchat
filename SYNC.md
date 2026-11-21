# 与上游同步指南

本项目 fork 自 [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo)，在上游基础上改造成了自带 Node 服务端的自托管聊天应用（DeepChat）。上游仍会继续更新，本文整理**我们相对上游做了哪些改动**，供合并上游更新时对照。

> 本文只记录**经代码核实**的事实。每条结论都可以用文末「核对方法」里的命令复现。
> 上游基线：`8ad7b56`（v0.1.3）。本项目版本：`0.2.1`。

---

## 一、最根本的一条：架构变了

**上游是纯静态前端，直接由浏览器访问 DeepSeek API；我们是「浏览器 → 自建 Node 服务 → 上游 API」。**

这一条决定了后面几乎所有改动，也是合并上游时最容易出问题的地方：**上游任何「浏览器直接请求上游」的代码，在我们的分支上都必须是错的**。

| | 上游 | 本项目 |
|---|---|---|
| 运行时 | 浏览器静态站 | Node 服务（`server/`）+ 静态产物（`dist/`） |
| API Key 位置 | 浏览器（`localStorage`） | 仅服务端（SQLite `endpoints.api_key`） |
| 请求地址 | `https://api.deepseek.com` | 同源 `/api/*` |
| 部署 | GitHub Pages | Docker |
| 鉴权 | 无 | 单密码 + 签名 Cookie |
| 数据存储 | 浏览器 IndexedDB | SQLite（`node:sqlite`） |

### 合并上游时必须做的判断

拿到上游补丁后，先看它是否**直接请求上游 API**：

- 若改动在 `src/services/api/client.ts` —— 大概率要重写，不能直接接受上游版本。我们的 `CHAT_ENDPOINT = '/api/chat'`、`UPLOAD_ENDPOINT = '/api/upload'`。
- 若改动引入新的浏览器端密钥读取（`apiKey` 参数、`localStorage` 里的 key）—— 必须改成服务端取。
- 若改动是纯 UI / 纯本地逻辑（渲染、样式、i18n）—— 通常可以直接接受。

### 已知的、合并上游时踩过或差点踩的坑

1. **`ensureServerId(apiKey, file)` 这类签名变化**
   上游 v0.1.3 给它加了 `apiKey` 参数。我们没有前端密钥，合并时去掉了该参数，只保留 `serverId !== file.serverId` 的判断。合并任何涉及文件上传的参数改动时，都要检查它是否假设了前端持有密钥。

2. **`uploadFile` 的上游改动要保留，但请求地址要换**
   上游 v0.1.3 在 `uploadFile` 里加了 `resizeUploadImage`（长边超 4096px 缩放）。合并时保留缩放调用，只把 `${ANTHROPIC_BASE_URL}/files` 换回 `${UPLOAD_ENDPOINT}${query}`。

3. **`package.json` 的 name / version / description 每次都会冲突**
   保留本项目的 `deepchat` / `0.2.x` / 中文描述，忽略上游的 `chat-demo` / `0.1.x`。

4. **`latest_reminder` 是 DeepSeek 私有消息角色，必须按能力过滤**
   `buildUpstreamBody` 在 `capabilities.latestReminder` 为假时会把这些消息整条剔除；`toOpenAIMessages` 也显式跳过它。合并时若上游新增了私有字段，同样要在服务端做能力过滤，而不是原样转发给陌生端点。

---

## 二、服务端（`server/`，全部为新增）

上游**没有任何服务端代码**，这 17 个文件（15 个实现 + 1 个类型声明 + 1 个 tsconfig）都是我们新增的。它们不参与前端构建，由 Node 24+ 直接运行 TypeScript（原生类型擦除，无构建步骤）。

| 文件 | 职责 |
|---|---|
| `index.ts` | 入口：环境变量、路由注册、鉴权守卫、错误兜底 |
| `router.ts` | 极简路由（方法 + 路径模板匹配） |
| `http.ts` | 请求/响应辅助：`toRequest`、`json`、`HttpError`、`sendResponse` |
| `auth.ts` | 单密码登录、HMAC 签名 Cookie、按 IP 失败锁定 |
| `db.ts` | SQLite schema、增量迁移、首次启动播种 |
| `context.ts` | 上下文预算裁剪与 token 估算 |
| `reasoning.ts` | 推理档位（`reasoningEfforts`）的读写与兼容 |
| `url.ts` | 按方言构造上游 URL |
| `static.ts` | 静态文件服务，br / gzip 协商压缩 |
| `search.ts` | 独立的搜索服务（与模型端点解耦） |
| `tools.ts` | 工具声明、工具结果格式、合成 SSE 块 |
| `routes/chat.ts` | 核心代理：请求体构造、SSE 透传、工具循环 |
| `routes/config.ts` | 端点 / 模型 / 人设 / 设置的读写接口 |
| `routes/sessions.ts` | 会话与文件存取 |
| `routes/openai.ts` | OpenAI Chat Completions ⇄ Anthropic Messages 的双向协议转换 |
| `node-sqlite.d.ts` | `node:sqlite` 的最小类型声明 |
| `tsconfig.json` | 服务端独立类型检查配置 |

### 完整接口清单

同步上游时如果它新增了前端调用，需要在这里补对应服务端路由：

```
POST   /api/auth                      登录
GET    /api/auth                      登录态
DELETE /api/auth                      退出

GET    /api/sessions                  会话列表
GET    /api/sessions/:id              会话详情
PUT    /api/sessions/:id              整会话覆盖保存
PATCH  /api/sessions/:id              重命名
DELETE /api/sessions/:id              删除单个
DELETE /api/sessions                  清空全部

POST   /api/files/lookup              批量查询附件元数据
POST   /api/files/:id                 存原件到服务端
GET    /api/files/:id                 取原件

POST   /api/chat                      聊天代理（SSE 透传）
POST   /api/chat/title                自动标题
POST   /api/upload                    附件上传到上游 Files API
POST   /api/search                    搜索服务自测
POST   /api/asr                       语音转写
POST   /api/tts                       语音合成

GET    /api/config                    全量配置
POST   /api/config/endpoints          保存端点
DELETE /api/config/endpoints/:id      删除端点
POST   /api/config/models             保存模型
POST   /api/config/models/list        拉取端点可用模型
POST   /api/config/models/:id/set-default  设默认模型
DELETE /api/config/models/:id         删除模型
POST   /api/config/personas           保存人设
DELETE /api/config/personas/:id       删除人设
POST   /api/config/settings           保存设置键值
POST   /api/config/test-endpoint      测试端点连通
POST   /api/config/test-model         测试单个模型
GET    /api/config/search             读搜索配置
POST   /api/config/search             写搜索配置
POST   /api/config/search/test        测试搜索服务
```

### 关键实现细节

**数据库**
- 用 `node:sqlite` 的 `DatabaseSync`，**不是** `better-sqlite3`——镜像里不需要原生编译工具链。
- 保存会话是**整会话覆盖**（一个事务里删光该会话消息再按快照写回），不是增量 diff。
- `migrate()` 只补列不重建表；schema 用 `create table if not exists`，老库不会自动获得新列。
- 内置端点（`builtin = 1`）在每次启动时被强制 `native_search = 1`（幂等 SQL）。

**鉴权**（`auth.ts`）
- Cookie 值 = `过期时间.HMAC(过期时间)`，服务端验签，**没有 session 存储**。
- `Secure` 标记按实际协议决定：内网 HTTP 直连时若强行加 `Secure`，浏览器会丢弃 Cookie，表现为「登录成功却跳回登录页」。
- 失败锁定按 IP，5 次 / 15 分钟。
- IP 取 `X-Forwarded-For` 的**链尾**，不是链首——链首由客户端控制，取链首等于让人换个假 IP 就绕过锁定。

**CSRF**
- 所有非 GET/HEAD/OPTIONS 的 `/api/*` 请求必须带 `X-Requested-With: XMLHttpRequest`，否则 403。表单无法伪造该头。

**路由守卫顺序**（`index.ts` 的 `handle`）
1. 非 `/api/` → 静态文件（登录页必须能加载）
2. `/api/auth` → 直接放行（否则无法登录）
3. 其余 `/api/*` → 先验 Cookie，再验 CSRF 头，最后进路由

**SSE 透传**
- 上游 SSE **原样回吐**，不重新组装。
- 响应头必须带 `cache-control: no-cache, no-transform` 与 `x-accel-buffering: no`。
- 前置 nginx 还需要 `proxy_buffering off`，否则会攒完才发。

**静态资源**（`static.ts`）
- 按 `Accept-Encoding` 协商 br / gzip，优先 br。
- 只压缩 ≥ 1KB 的 html/js/css/json/svg/txt/map，压缩结果按 `编码:路径` 缓存在内存。
- 必须带 `Vary: accept-encoding`。

**上游 URL 构造**（`url.ts`）
- `deepseek` 方言 → `{origin}/anthropic/v1/{path}`（`/anthropic` 是 DeepSeek 专属前缀）
- `anthropic` 方言 → `{origin}/v1/{path}`
- `openai` 方言 → `{origin}/v1/{path}`
- **origin 已带 `/vN` 时不再重复拼接**（用户常填 `http://host:port/v1`），否则得到 `/v1/v1/...`

---

## 三、核心代理：`server/routes/chat.ts`

这是整个项目最复杂的文件（约 1500 行），合并上游时**不要整体覆盖**。

### 请求体构造 `buildUpstreamBody`

按方言与端点能力裁剪，**幂等地**决定发什么字段：

| 逻辑 | 说明 |
|---|---|
| `latest_reminder` | 仅 `capabilities.latestReminder` 为真时保留 |
| `thinking` | 内置端点用聊天窗口的「深度思考」开关；自定义端点用模型配置的推理等级 |
| `tools` | 见下方「工具声明」 |
| `max_tokens` | **内置端点不发送**（与原版一致，由上游决定）；自定义端点发送模型配置的 `maxOutput` |
| `safety_check` / `title` | 各自看对应 capability |

### 工具声明：按方言三分支，互斥

```ts
if (dialect === 'deepseek') {
  payload.tools = body.tools                       // 原样透传（只有内置端点）
} else if (anthropic && nativeSearch && body.search) {
  payload.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
} else if ((useSearchTool || useFetchTool) && body.search) {
  // 声明我们自己的 search_web / read_url
}
```

**几个必须理解的点：**

1. **前端始终会发 `deepseek_read_url`**（`store.ts` 的 `serverTools()` 无条件带上），但服务端会重新决定。服务端才是唯一决策点。
2. **`body.search === true` 是必要条件**。部分中转端点只要看到 `web_search_20250305` 就初始化搜索会话，实测首字延迟从 1.6s 涨到 8–10s，即使模型不调用。关掉搜索按钮仍被拖慢就是这个判断漏了。
3. **两个自定义工具都受「智能搜索」开关控制**，不只是 `search_web`。关掉搜索就一个工具都不声明。

### 工具循环 `runSearchToolLoop`

模型自主决定是否调用搜索/读网页，服务端执行后回灌结果，最多 `MAX_ROUNDS = 5` 轮。

**判断这一轮是工具还是回答**（`inspectChunk`）——这是最容易改坏的地方：

- 出现 `text` 块 → 判定为最终回答，**立刻转流式**（首字延迟 = 思考时间）
- 出现 `tool_use` 块 → 工具轮，整轮丢弃（模型在酝酿参数，不该显示）
- 只有 `thinking` → 还判断不了，继续缓冲

> **不要**用缓冲区大小或静默窗口做判断。曾经用 128KB 静默窗口兜底，导致正常长度的回答永远攒不到阈值、整段吐出，流式完全消失。

**索引隔离**——多轮块会拼进同一条 SSE 流交给前端，前端按 `index` 建映射，重号会让后一个块覆盖前一个：

- 每轮分配独立区间：`round * ROUND_INDEX_STRIDE`（`ROUND_INDEX_STRIDE = 100`）
- 合成块（我们自己造的搜索/抓取结果）用更高位起点：`SYNTHETIC_BLOCK_BASE = 10000`

**多工具并发**——模型一轮可能发多个调用（实测见过同时搜两个关键词）。全部执行并按顺序回灌，只回第一个会让模型以为信息不全而反复搜索。上限 `MAX_PARALLEL = 4`。

**收尾策略**——接近轮次上限时，把「写总结、别再调工具」注入到工具结果里，而不是硬切断 turn。这是 DeepSeekRuntime 的 goal-round wrap-up 设计：循环靠「没有工具调用」这个普通条件自然结束。

### 模型解析 `resolveEndpoint`

- 只考虑 `enabled = 1` 的模型。
- **指定了模型却解析不到时，绝不回退默认模型**：被停用返回 409，不存在返回 404。回退会让用户以为还在用原端点，实际计费与效果都变了。
- 前端会据此提示「模型已停用，请重新选择」，并**禁用发送按钮**。

---

## 四、搜索服务：`server/search.ts`

**与模型端点完全解耦。** 该文件不读取 `endpoints` 表，API Key 独立配置，存在 `settings` 表的 `search.config` 键里。

```
enabled / preset('deepseek' | 'custom') / url / apiKey / headers
resultsPath / titleField / urlField / snippetField / fetchUrl
```

- `isSearchConfigured()` = `enabled && url 非空 && apiKey 非空`
- `runSearch()` 走 DeepSeek 预设或自定义字段映射（`pick()` 支持 `data.items.0.title` 这样的路径）
- `runFetch()` 取网页正文，供 `read_url` 工具用
- 上限：`MAX_HITS = 8`，单条正文 `MAX_HIT_CONTENT_CHARS = 3000`

**不要让它复用端点 Key**——这是明确的产品决策：搜索用量与模型用量分开计费。

---

## 五、前端改动

### `src/services/api/client.ts`

`CHAT_ENDPOINT = '/api/chat'`、`UPLOAD_ENDPOINT = '/api/upload'`，删除所有直连上游的代码与 `__API_ORIGIN__` 注入。密钥相关参数从函数签名中移除。

### 附件：三条路径，按端点能力分流

这是改动最深、也最容易出问题的地方。

**判定依据：`isBuiltinModel()`——只有内置 DeepSeek 官方端点用 Files API，其余全部内联。**

（注意：判定看的是「端点是否 `builtin`」，**不是**端点 `capabilities` 里有没有 `filesApi` 标记。）

| 附件类型 | 内置端点 | 自定义端点 |
|---|---|---|
| 图片 | Files API → `image` + `file_id` | `image` + `base64` |
| 文本类（txt/md/code/json…） | Files API（`user_data`） | **展开成 `text` 块** |
| PDF 等文档 | Files API | `document` + `base64` |

**为什么文本要走 text 块而不是 `document`**：Anthropic 的 `document` 块只承载 PDF 一类可解析文档。把 `.txt` 塞进 `document`，模型读不到内容（实测会回「我看不到文件」）。

**原件的来源**：`FileAttachment.blob`（可选字段）。
- 草稿阶段的附件原件只在内存里；浏览器 IndexedDB 只用于「历史导入」的暂存（`chat-demo-staging` 库）。
- 发送时 `sendMessage` 把原件记进 `pendingFiles`，`saveSession` 随即 `POST /api/files/:id` 上传到服务端落盘。
- 因此内联必须先读 `file.blob`（草稿），缺失时才回退 `loadFile(id)`（历史，实际是 `GET /api/files/:id`）。
- `saveSession` 落库前必须剥掉 `blob`（`withoutBlobs`），否则 `JSON.stringify` 会把它变成 `{}`。

> 踩过的坑：内联实现最初只用 `loadFile(id)` 取原件。草稿阶段的附件原件还没上传到服务端（`pendingFiles` 只在 `sendMessage` 时才写入并落盘），所以那一刻取不到，附件块被静默跳过，模型只收到文字——表现为「图片已发送但模型说看不到」。现在草稿优先用 `file.blob`，只有历史轮次才走 `loadFile`。

**已知代价**：**历史轮次的附件也会重复内联**。`toRequestMessages` 对 `getContextRounds(history)` 的每一轮都调用同一套 `toFileBlocks`，多轮对话会显著增大请求体积（每轮图片都重新 base64 一遍）。内置端点用 `file_id` 没有这个问题。

### 上传链路必须带 `modelId`

`uploadFile(..., modelId)` → `/api/upload?modelId=...`。

**服务端按模型定位端点；不传就回退默认模型。** 默认模型若是不支持 Files API 的第三方端点，上传返回错误、附件永远到不了完成态、**连纯文字都发不出去**（发送按钮灰着）。

三个解析器都用「注册」模式解决循环依赖（`drafts` 被 `store` 引用，反向 import 会成环）：

| 注册函数 | 用途 |
|---|---|
| `registerInputTypeResolver` | 当前模型接受哪些输入类型（过滤文件选择器） |
| `registerModelIdResolver` | 草稿附件上传用哪个模型 |
| `registerInlineFilesResolver` | 是否内联发送 |

三者必须与聊天请求**同一口径**：新会话看 `usePendingSelection`，已有会话看 `session.modelId`。

### `parseEvent.ts`：双格式归一化

同时认两种 `server_tool_use`：

- **DeepSeek 私有**：`name` 是 `deepseek_web_search` / `deepseek_read_url`，带 `kind` 字段，`input.action` 决定结构
- **标准 Anthropic**：`name` 是 `web_search`，没有 `kind`，`input` 是 `{ query }`

后者归一化成前者，下游 `view.ts` / `toArchive.ts` 只需处理一种形状。

> 踩过的坑：最初只认私有格式，导致第三方 Anthropic 端点的来源卡片完全不渲染。

### `ReplyArea.tsx`：思考折叠

- 判定用 `message.thinking === true || view.steps.some(...)`，**不能用 `??`**。自定义端点的 `thinking` 字段是 `false`（不是 undefined），`??` 会短路成 `false`，导致思考内容无法折叠。
- 三种模式：`keep`（默认）/ `onAnswer` / `onFinish`，存在 `settings.thinkingCollapse`。
- 有 `touched` 守卫：用户手动展开/收起后不再自动操作。

### 服务端化带来的删除

- 删除 `__API_ORIGIN__` 的 DefinePlugin 注入与 `src/env.d.ts` 声明
- `ApiKeyField` / `useApiKeyForm` 改为服务端存 key（只回显 `keyHint`）
- 语音（ASR/TTS）改为经 `/api/asr`、`/api/tts` 转发

---

## 六、设置界面

五个页签：**通用设置 / 模型 / 人设 / 搜索服务 / 数据管理**。

上游只有「通用设置 / 数据管理」。

- **模型**：端点卡片 → 模型内嵌；启用开关、原生搜索开关、推理档位、输入类型、按模型测连接、获取可用模型（勾选式）
- **人设**：增删改
- **搜索服务**：独立页面。预设（DeepSeek / 自定义）、请求地址、网页读取地址、API Key、自定义字段映射、测试搜索
- **通用设置**：新增「思考内容折叠」三选项

---

## 七、构建与部署

### 脚本

```json
"dev":   "node scripts/dev.mjs",           // 同时起后端 + rspack dev server
"build": "rm -rf dist && NODE_ENV=production rspack build -c rspack.config.ts",
"start": "node server/index.ts",
"serve": "NODE_ENV=production rspack build -c rspack.config.ts && node server/index.ts",
"type":  "tsc -p tsconfig.json && tsc -p server/tsconfig.json",   // 前端 + 服务端分别检查
"lint":  "oxlint src server scripts rspack.config.ts"
```

**`dev` 必须走 `scripts/dev.mjs`**：前端只请求同源的 `/api/*`，rspack dev server 不提供这些接口。`rspack.config.ts` 里必须保留：

```ts
devServer: { proxy: [{ context: ['/api'], target: 'http://127.0.0.1:3000', changeOrigin: true }] }
```

漏了它页面能打开但所有 `/api/*` 返回 404。

### Docker

- 两阶段：`node:24-alpine` 构建 → 运行阶段**只拷 `dist/` 和 `server/`，不拷 `node_modules`**（服务端只用 Node 内置模块）
- `CMD ["node", "server/index.ts"]`，依赖 Node 24+ 的类型擦除
- 数据卷 `/data`：SQLite、附件原件、Cookie 签名密钥

### CI（`.github/workflows/`）

| 文件 | 作用 |
|---|---|
| `ci.yml` | 类型、lint、构建，并启动服务做冒烟测试（未认证 `/api/config` 必须返回 401） |
| `docker.yml` | push 到 `main` 或 `v*` tag 时构建推送到 GHCR，打 branch / tag / sha / `latest` 标签 |

**上游的 `pages.yml` 已删除**：服务端化后前端不是可直接托管的静态站，单独发布到 GitHub Pages 会得到「页面正常但所有接口 404」的空壳。

### 文档

`README.md` / `README.zh-CN.md` 已按 Docker 部署重写；`docs/deployment.md` 是更详细的部署说明。
上游同名的纯静态部署步骤不再适用。

---

## 八、环境变量

| 变量 | 说明 |
|---|---|
| `APP_PASSWORD` | 访问密码，**必填**（compose 里用 `:?` 校验）。本机直跑时留空表示不启用登录 |
| `DEEPSEEK_API_KEY` | 首次启动播种官方端点用；已配置过的不会被覆盖 |
| `API_ORIGIN` / `API_MODEL` | 播种端点时的自定义地址与模型名 |
| `DATA_DIR` | 数据目录，默认 `./data`；Docker 下固定 `/data` |
| `PORT` | 监听端口，默认 3000 |
| `DIST_DIR` | 静态产物目录，默认 `./dist` |
| `DEEPCHAT_IMAGE` | 仅 compose：要拉取的镜像 |

`seedEndpoints()` 的语义：**只在没有对应记录时写入**。重启服务不会把 Key 重置回环境变量的值。

---

## 九、合并上游的建议流程

```bash
git fetch origin
git log --oneline $(git merge-base HEAD origin/main)..origin/main   # 先看有哪些提交
git diff --stat $(git merge-base HEAD origin/main)..origin/main     # 再看改了哪些文件
```

然后按文件归类：

1. **纯 UI / i18n / 样式** → 通常可直接接受
2. **`src/services/api/*`** → 逐个检查是否引入了浏览器端密钥或直连上游
3. **`src/services/chat/store.ts` / `reply.ts` / `drafts.ts`** → 我们改动很多，冲突概率高，需手工合并
4. **`server/*`** → 上游不会有，除非它开始加服务端代码
5. **`package.json`** → 保留我们的 name / version / description

合并后必须跑：

```bash
pnpm type    # 前端 + 服务端
pnpm lint
pnpm build
# 然后实际启动验证：登录、发消息、附件、搜索
```

### 冲突高发文件（按经验排序）

| 文件 | 原因 |
|---|---|
| `package.json` | name / version / description / scripts 全部不同 |
| `src/services/chat/store.ts` | 我们加了三个解析器注册、内联附件、搜索开关透传 |
| `src/services/api/client.ts` | 请求地址、密钥参数完全不同 |
| `src/services/chat/reply.ts` | 附件块构造被完全重写 |
| `src/components/chatInput/ChatInput.tsx` | 发送条件、附件就绪判定、图标布局 |
| `src/components/messages/ReplyArea.tsx` | 思考折叠 |

---

## 十、核对方法

本文所有结论都可以用以下方式验证：

```bash
# 全部差异文件
git diff --name-status $(git merge-base HEAD origin/main)..HEAD

# 单独看某个文件的差异
git diff $(git merge-base HEAD origin/main)..HEAD -- server/url.ts

# 确认某个行为在代码里的真实写法
grep -n "inlineFilesFor" -A 10 src/services/chat/store.ts
grep -n "buildUrl" -A 15 server/url.ts
grep -n "isBuiltinModel" -A 10 src/services/chat/store.ts

# 确认服务端不做某件事（例如搜索服务不读 endpoints 表）
grep -n "endpoints" server/search.ts
```

**最后一条尤其重要**：本文描述的是「代码现在怎么做的」，不是「设计意图」。同步上游后如果行为变了，以代码为准更新本文。
