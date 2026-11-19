# DeepChat

English | [简体中文](README.zh-CN.md)

> **This is a fork.** DeepChat is derived from [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo),
> which is MIT-licensed and Copyright (c) 2026 DeepSeek. The upstream project is a
> browser-only static demo; this fork adds a Node server so the app can be self-hosted
> and shared across devices. See [License](#license) for details.

DeepChat is a chat UI for DeepSeek-compatible APIs, packaged as a small self-hosted server.
One Node process serves the static frontend and the API; any browser on your network
(or behind your own reverse proxy) can use it, and conversations stay in one place
instead of being scattered across browser profiles.

What this fork changes relative to upstream:

- Conversations, attachments, and settings live in SQLite on the server instead of IndexedDB per browser.
- API keys stay on the server and never reach the browser.
- Multiple devices share the same data with no sync step.
- You can register several endpoints and models, not just the official DeepSeek one.

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.
- **Personas**: named system prompts, chosen per conversation. A built-in default persona cannot be edited or deleted. The persona is locked once a conversation has messages.
- **Custom endpoints and models**: register any Anthropic- or OpenAI-compatible endpoint, fetch its model list, and configure each model's input types, context window, output limit, and reasoning level.
- **Per-model reasoning**: the built-in DeepSeek endpoint keeps the original deep-thinking toggle; custom-endpoint models use their own reasoning level setting instead.
- **Search**: a model can declare native web search, and the built-in DeepSeek endpoint can backstop search for models that lack it.

## Deploy

You need an always-on machine with Docker installed. Images are built by GitHub Actions
and published to GHCR, so the server needs neither Node.js nor a frontend build.

### 1. Get the files

```sh
git clone https://github.com/NuSYiXue/deepchat.git
cd deepchat
```

No `git`? Use **Code → Download ZIP** on the repo page and unzip.

### 2. Set the access password

This is the only thing you must configure up front — without it you cannot get in.

```sh
cp .env.example .env
```

Open `.env` and find this line:

```ini
APP_PASSWORD=
```

Type your own password after the equals sign, for example:

```ini
APP_PASSWORD=my-secret-2026
```

Any password works; around 20 characters and not a common word is plenty.
**Don't touch the left side of the equals sign — only change what's after it.**

> Leaving it empty makes startup fail with `APP_PASSWORD is missing a value`.
> That's deliberate: an empty password means no login protection at all.

### 3. Start

```sh
docker compose pull
docker compose up -d
docker compose logs -f
```

Seeing `listening on http://0.0.0.0:3000` means it worked. Press Ctrl+C to stop
following the log.

### 4. Open and configure

Open <http://localhost:3000> and log in with the password you just set.

Everything else happens in the UI — no more command line needed:

- **DeepSeek API key**: Settings → Models → click **Edit** on the DeepSeek row →
  paste the key → confirm. The dot next to the endpoint is red until a key is set.
- **Other endpoints**: on the same page click **Add endpoint**. Both Anthropic and
  OpenAI dialects are supported; after filling in the address you can click
  **Fetch models** to pull the list.
- **Personas**: Settings → Personas to create or edit system prompts.

> `DEEPSEEK_API_KEY` in `.env` is optional. Its only job is to pre-fill the key on
> first start, saving you the step above. Leaving it blank is fine — configuring it in
> the UI does exactly the same thing.

### 5. LAN access

```sh
ip addr | grep 'inet ' | grep -v 127.0.0.1     # Linux: find this machine's IP
ipconfig                                        # Windows
```

On a phone connected to the same Wi-Fi, open `http://<that-ip>:3000` and log in with
the same password. Conversations, attachments, and settings live on the server, so every
device sees the same data.

> Voice input does not work over plain HTTP on a LAN (browsers only grant microphone
> access over HTTPS); the button greys out. Everything else works. For voice, put it
> behind public HTTPS — see the next section.

### 6. Public access (optional)

The server speaks plain HTTP and does not terminate TLS. Public access needs a reverse
proxy in front; the full checklist is in [docs/deployment.md](docs/deployment.md) (Chinese).

---

## Day-to-day operations

**Update** (`latest` follows the newest build on `main`):

```sh
cd deepchat
docker compose pull
docker compose up -d
```

**Back up** (`data/` is the entire application state, including the login secret):

```sh
docker compose stop
sudo tar czf deepchat-$(date +%F).tar.gz data/
docker compose start
```

Restore with `docker compose down` → extract the archive → `docker compose up -d`.
Losing `data/secret` logs every device out; losing `data/app.db` loses every conversation.

**Stop**:

```sh
docker compose stop      # stop, keep the container
docker compose down      # stop and remove the container (./data is untouched)
```

---

## Run from source

To modify the code:

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts the API server on port 3000 and the frontend dev server on
<http://localhost:8090>, with `/api` proxied to the backend. Open <http://localhost:8090>.

Requires Node.js 24 or newer and pnpm.

For a production build locally use `pnpm serve` (builds `dist/`, then starts on port 3000).
To use Docker but build from local source, uncomment the `build: .` line in
`docker-compose.yml` and run `docker compose up -d --build`.


## Configuration

Settings come from environment variables. For local development you can put them in `.env`;
Docker Compose reads that file automatically.

| Variable | Purpose |
| --- | --- |
| `APP_PASSWORD` | Access password for every device. Required under Docker; **empty disables the login screen** and is only appropriate for local debugging. |
| `DEEPSEEK_API_KEY` | **Optional.** When set, the first start pre-fills the key for the built-in endpoint. Leave blank and paste it in the UI instead (Settings → Models). |
| `API_ORIGIN` | Optional: origin for the seeded endpoint instead of `https://api.deepseek.com`. |
| `API_MODEL` | Optional: default model name for the seeded endpoint instead of `deepseek-flash`. |
| `DEEPCHAT_IMAGE` | Docker only: image to run. Defaults to `ghcr.io/nusyixue/deepchat:latest`. |
| `DATA_DIR` | Node only. Where the database, attachments, and signing secret live. Ignored under Docker (fixed to `/data`). Default `./data`. |
| `PORT` | Node only. Listen port. Ignored under Docker (fixed to `3000`). |

Under Docker, `DATA_DIR` and `PORT` are set by `docker-compose.yml` and cannot be overridden
from `.env` — change the `volumes` mapping instead if you want a different host directory.

The server always listens on plain HTTP and does not terminate TLS. Put a reverse proxy
in front for public HTTPS access.

## Data and storage

Everything lives under `DATA_DIR`:

| Path | Contents |
| --- | --- |
| `app.db` (+ `-wal`, `-shm`) | SQLite database: conversations, messages, personas, endpoints, models, attachment metadata |
| `files/` | Attachment originals |
| `secret` | Cookie signing key. Losing it logs every device out. |

Back up by copying the whole directory while the service is stopped, or use the in-app
export (ZIP archive without API keys or settings).

Settings → Data → Delete all chats clears every conversation and attachment after
confirmation. Endpoints, models, personas, and the access password are preserved.

## Deployment notes

See [docs/deployment.md](docs/deployment.md) (Chinese) for the reverse-proxy checklist,
streaming caveats, backup/restore, and a list of verified environments.

The two settings people most often miss behind a reverse proxy:

```nginx
proxy_buffering off;          # without this, replies arrive in one burst instead of streaming
client_max_body_size 100m;    # without this, attachment uploads fail with 413
```

## About the GHCR image

- The repository is public, so the GHCR image is public too — **pulling needs no login**.
- If you make your fork private, the image becomes private as well and you have to log in
  once:

  ```sh
  echo <your-github-pat> | docker login ghcr.io -u <your-username> --password-stdin
  ```

  The PAT only needs the `read:packages` scope.

- Available tags: `latest` (newest `main` build), `main` (same), `sha-xxxxxxx` (a specific
  commit), `v0.2.0` (when a `v*` tag is pushed). For production, pin to a `sha-` or version
  tag so upgrades are intentional.

## Development

| Command | Description |
| --- | --- |
| `pnpm dev` | Run backend and frontend dev server together |
| `pnpm build` | Build the frontend into `dist/` |
| `pnpm start` | Start the server against an existing `dist/` |
| `pnpm serve` | Build, then start the server |
| `pnpm type` | Run TypeScript type checks |
| `pnpm lint` | Lint with oxlint |
| `pnpm format` | Format with oxfmt |

```text
server/                 HTTP server, auth, SQLite, upstream proxying
  routes/               chat, config, sessions
  search.ts             search fallback (borrow a search-capable endpoint)
  url.ts                upstream URL construction per dialect
  db.ts                 schema, migrations, seeding
src/
  app/                  Application layout, themes, and global styles
  components/           Chat, settings, Markdown, and other UI components
  i18n/                 English and Chinese translations
  services/
    api/                Chat requests, SSE parsing, and protocol types
    chat/               Conversations, message branches, history import/export
    markdown/           Markdown parsing, syntax highlighting, and diagrams
    server/             Client for the self-hosted config and session API
    speech/             Audio recording and read-aloud playback
  utils/                Shared utilities
scripts/dev.mjs         Development launcher (backend + dev server)
```

The frontend speaks the Anthropic Messages protocol with DeepSeek's private extensions
(`latest_reminder`, `safety_check`, `title`, `deepseek_web_search`, `deepseek_read_url`).
OpenAI-dialect endpoints are translated to and from that protocol on the server, so the
UI never needs to know which upstream it is talking to.

### CI

- `.github/workflows/ci.yml` — type check, lint, build, and a server smoke test on every push and PR.
- `.github/workflows/docker.yml` — builds and pushes the container image to GHCR on `main` and on `v*` tags.

## License

MIT. This project is a derivative work of
[deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo):

> MIT License — Copyright (c) 2026 DeepSeek

The original copyright notice is retained in [LICENSE](LICENSE) as required by the MIT
License. Modifications and additions in this fork are released under the same MIT terms.
The build copies the license to `dist/LICENSE`; include it when distributing the app.
Third-party dependencies are subject to their own licenses.
