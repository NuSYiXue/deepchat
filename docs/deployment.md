# 部署：内网 HTTP + 公网 NPM 反代

服务端只监听 HTTP，不处理 TLS。两种访问方式并存：

```
内网设备 ──http://<内网IP>:3000──────────┐
                                        ├──> Node :3000（数据 + 静态 + API）
公网设备 ──https://<域名>──> NPM ──http──┘
```

`Secure` Cookie 由 `X-Forwarded-Proto` 决定，因此两种路径都能正常登录。

---

## 一、启动

镜像由 GitHub Actions 自动构建，推到 GitHub Container Registry（GHCR）。
`docker-compose.yml` 默认拉 `ghcr.io/<owner>/<repo>:latest`；仓库名与默认值不同时
在 `.env` 里设 `DEEPCHAT_IMAGE` 覆盖：

```sh
cat > .env <<EOF
APP_PASSWORD=$(openssl rand -base64 24)
DEEPSEEK_API_KEY=sk-你的key
DEEPCHAT_IMAGE=ghcr.io/你的用户名/你的仓库名:latest
EOF

docker compose pull
docker compose up -d
docker compose logs -f
```

如果 GHCR 上的包是私有的，先登录一次：

```sh
echo <你的 GitHub PAT> | docker login ghcr.io -u <你的用户名> --password-stdin
```

不想用预构建镜像、要跑本地源码时，取消 `docker-compose.yml` 里 `build: .` 的注释，
然后 `docker compose up -d --build`。

首次启动会在 `./data/` 下生成：

| 文件 | 用途 |
|---|---|
| `app.db` | SQLite 数据库（会话、消息、人设、端点、模型、附件元数据） |
| `app.db-wal` / `app.db-shm` | WAL 模式日志，备份时一并拷贝 |
| `files/` | 附件原件 |
| `secret` | Cookie 签名密钥（**丢失会导致所有设备需要重新登录**） |

`DEEPSEEK_API_KEY` 只在**首次启动**（端点表为空）时用于创建内置端点与默认模型；
之后在界面里改过的配置不会被它覆盖。

> `data/` 由容器内进程写入，宿主用户默认无权删除。需要重建数据时用
> `sudo rm -rf data`，或 `docker compose down` 后再操作。

## 二、内网访问

直接打开 `http://<内网IP>:3000`，用 `APP_PASSWORD` 登录。

**已知限制：语音输入不可用。** `getUserMedia` 要求安全上下文，浏览器只对
`https://`、`localhost`、`file://` 放行。通过局域网 IP 的 HTTP 访问时，
代码里的 `window.isSecureContext` 为 false，语音按钮会置灰。这是浏览器策略，
不是配置问题。其他功能（聊天、上传、朗读、复制）都正常。

> `src/utils/clipboard.ts` 已经为这种情况准备了 `execCommand` 降级，
> 手机上的复制按钮依然可用。

## 三、公网访问（Nginx Proxy Manager）

### 1. Proxy Host

| 字段 | 值 |
|---|---|
| Domain Names | 你的域名 |
| Scheme | `http` |
| Forward Hostname / IP | 运行 Docker 的机器内网 IP |
| Forward Port | `3000` |
| Block Common Exploits | 开 |
| Websockets Support | **不需要**（SSE 是普通 HTTP 流，不是 WebSocket） |

### 2. Advanced 标签页（必须）

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 300s;
proxy_send_timeout 300s;
client_max_body_size 100m;
```

**`proxy_buffering off` 是最容易漏的一项。** nginx 默认把上游响应攒成块再发，
表现为：回复不是逐字出现，而是沉默很久后一次性蹦出，或长回复中途超时断开。
服务端已经回了 `x-accel-buffering: no`，但 nginx 仍需要这一行。

`client_max_body_size` 对应附件上限 64MB（`attachments.ts` 的 `MAX_SIZE_MB`），
不设会在上传时收到 413。

### 3. SSL 标签页

- 申请 Let's Encrypt 证书
- 开 **Force SSL**
- 开 **HTTP/2 Support**（HTTP/1.1 下同域最多 6 个并发连接，多标签页同时
  流式回复会排队）

### 4. 验证两件事

**① `X-Forwarded-Proto` 是否传到了后端**

```sh
# 公网访问后，登录一次；若成功后立刻跳回登录页，说明没传
```

NPM 默认会传，但请确认 Cookies 正常写入：
浏览器 DevTools → Application → Cookies → 应看到 `chat_demo_session`，
且带 `Secure` + `HttpOnly`。如果没带 `Secure`，说明 NPM 没传
`X-Forwarded-Proto: https`，此时在 Advanced 里补一行：

```nginx
proxy_set_header X-Forwarded-Proto $scheme;
```

**② SSE 是否真的逐字流式**

发一条长回复，观察文字是逐渐出现还是一次性出现。一次性出现 = 缓冲没关。

## 四、安全建议

| 项 | 做法 |
|---|---|
| 端口暴露 | 只把 NPM 的 443 暴露到公网；**不要**把 3000 端口转发出去 |
| 密码强度 | `APP_PASSWORD` 用 `openssl rand -base64 24` 生成 |
| 暴力破解 | 应用层已有锁定：15 分钟内 5 次失败即拒绝该来源 IP |
| 额外防护 | 可在 NPM 给 `/api/auth` 加 Access List 或限速 |
| 备份 | 定时拷 `data/` 整个目录（含 `secret`，否则恢复后要重新登录） |

## 五、备份与恢复

```sh
# 备份（服务运行时也可执行；WAL 模式下单拷 app.db 可能不完整）
docker compose stop
tar czf deepchat-backup-$(date +%F).tar.gz data/
docker compose start

# 恢复
docker compose down
tar xzf deepchat-backup-YYYY-MM-DD.tar.gz
docker compose up -d
```

也可以在应用内「设置 → 数据管理 → 导出」生成 ZIP 归档（不含 API Key 与设置）。

## 六、升级

镜像由 CI 自动构建，升级只需重新拉取：

```sh
docker compose pull
docker compose up -d
```

`latest` 标签跟随 main 分支最新一次构建。想固定版本，把 `DEEPCHAT_IMAGE` 指向
某个 tag（如 `:v0.2.0`）或某个 commit（如 `:sha-abc1234`），再 `docker compose pull`。

跑本地源码时则用：

```sh
git pull
docker compose up -d --build
```

数据库 schema 使用 `create table if not exists`，新增表会自动创建。
若后续修改了已有列结构，需要手动迁移——目前版本没有实现迁移框架。

## 七、常见问题

| 现象 | 原因 |
|---|---|
| 登录成功但立刻跳回登录页 | `Secure` Cookie 被 HTTP 丢弃，见上文 ①② |
| 回复不流式 | `proxy_buffering off` 缺失 |
| 上传附件 413 | `client_max_body_size` 未设置 |
| 语音按钮灰 | 用 `http://<内网IP>` 访问，改成 HTTPS 或 `localhost` |
| 重启后需要重新登录 | `data/secret` 丢失或被覆盖 |
| 所有设备数据消失 | `data/` 卷未正确挂载 |

## 八、已验证的环境

以下在 Ubuntu 26.04 虚拟机（5.2G 内存、Docker 29.10.0、Compose v5.7.2）上实测通过：

| 项 | 结果 |
|---|---|
| `docker compose build` | 成功，镜像约含 dist + server，无 node_modules |
| 容器启动 | `listening on http://0.0.0.0:3000 (data: /data)` |
| 首页 / 未登录 API | 200 / 401 |
| 密码登录 | 200，Cookie 为 HttpOnly（`document.cookie` 读不到） |
| 真实 DeepSeek 对话 | 200，流式返回，思考过程 133 字 |
| 自动标题 | 由服务端 `title` 扩展生成，侧栏正确显示 |
| 环境变量播种 | 首次启动自动建内置端点与默认模型 |
| 重启容器 | 会话数据完好（`./data` 卷持久化） |
| 多端同步 | 两套独立 Cookie 读写同一会话，双向可见 |
| 跨机访问 | 从宿主 `http://<VM IP>:3000` 正常 |
| 语音按钮 | 内网 HTTP 下置灰并提示原因（预期行为） |
