# chat-demo

English | [简体中文](README.zh-CN.md)

A chat UI for DeepSeek-compatible APIs, packaged as a small self-hosted server. One Node process serves the static frontend and the API; any browser on your network (or behind your own reverse proxy) can use it, and conversations stay in one place instead of being scattered across browser profiles.

Compared with the original static demo, this fork adds a backend so that:

- conversations, attachments, and settings live in SQLite on the server, not in IndexedDB per browser;
- API keys stay on the server and never reach the browser;
- multiple devices share the same data with no sync step;
- you can register several endpoints and models, not just the official DeepSeek one.

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

## Getting started

Requires Node.js 24 or newer (the server runs TypeScript directly via native type stripping) and pnpm.

```sh
git clone <your fork>
cd chat-demo
pnpm install
pnpm dev
```

`pnpm dev` starts the API server on port 3000 and the frontend dev server on <http://localhost:8090>, with `/api` proxied to the backend. Open <http://localhost:8090>.

To run the production build locally:

```sh
pnpm serve
```

This builds `dist/` and starts the server on <http://localhost:3000>.

## Configuration

Settings come from environment variables. For local development you can put them in `.env`; Docker Compose reads that file automatically.

| Variable | Purpose |
| --- | --- |
| `APP_PASSWORD` | Access password for every device. **Empty disables the login screen** — only appropriate for local debugging. |
| `DATA_DIR` | Where the SQLite database, attachment originals, and cookie signing secret live. Default `./data`. |
| `PORT` | Listen port. Default `3000`. |
| `DEEPSEEK_API_KEY` | Used **only on first start** to seed the built-in endpoint and its default model. Later changes made in the UI are never overwritten. |
| `API_ORIGIN` | Optional: origin for the seeded endpoint instead of `https://api.deepseek.com`. |
| `API_MODEL` | Optional: default model name for the seeded endpoint instead of `deepseek-flash`. |

The server always listens on plain HTTP and does not terminate TLS. Put a reverse proxy in front for public HTTPS access.

## Data and storage

Everything lives under `DATA_DIR`:

| Path | Contents |
| --- | --- |
| `app.db` (+ `-wal`, `-shm`) | SQLite database: conversations, messages, personas, endpoints, models, attachment metadata |
| `files/` | Attachment originals |
| `secret` | Cookie signing key. Losing it logs every device out. |

Back up by copying the whole directory while the service is stopped, or use the in-app export (ZIP archive without API keys or settings).

Settings → Data → Delete all chats clears every conversation and attachment after confirmation. Endpoints, models, personas, and the access password are preserved.

## Deployment

Docker is the intended path:

```sh
cat > .env <<EOF
APP_PASSWORD=$(openssl rand -base64 24)
DEEPSEEK_API_KEY=sk-your-key
EOF

docker compose up -d --build
```

See [docs/deployment.md](docs/deployment.md) (Chinese) for the reverse-proxy checklist, streaming caveats, backup/restore, and a list of verified environments.

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

The frontend speaks the Anthropic Messages protocol with DeepSeek's private extensions (`latest_reminder`, `safety_check`, `title`, `deepseek_web_search`, `deepseek_read_url`). OpenAI-dialect endpoints are translated to and from that protocol on the server, so the UI never needs to know which upstream it is talking to.

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
