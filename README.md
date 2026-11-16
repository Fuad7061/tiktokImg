# Image Studio

A small, dependency-free image generation service with a web dashboard and an OpenAI-compatible API. It drives the TikTok Creative Studio image endpoints through a pool of imported browser sessions, so requests keep working when an individual account fails or runs out of credits.

- Node 24, built-in `node:http` and `node:sqlite` — no npm dependencies
- Text-to-image and image-to-image (`gemini` / Nano Banana Pro, `genai_seedream4.5` / Seedream 4.5)
- Account pool with per-account concurrency, failover, and reference reuse between attempts
- Dashboard for cookie profiles, session expiry (when the export includes it), credits, jobs, playground, and API keys
- Images are streamed through signed links; nothing is written to disk except metadata
- OpenAPI-friendly surface: `GET /v1/models`, `POST /v1/images/generations`, `POST /v1/images/edits`

## Requirements

- Node.js 24 or newer, or Docker
- A TikTok Creative Studio cookie export (`tiktok_cookies.txt`), JSON or Netscape format
- Outbound HTTPS access to `ads.tiktok.com`, `tos-my216-up.tiktokcdn.com`, and `p19-creative-tool-sg.ibyteimg.com`

## Quick start

```bash
cd image-studio
cp .env.example .env
# set ADMIN_PASSWORD in .env
npm start
```

Open `http://localhost:4175`, sign in, then:

1. **Accounts → Import cookies** — paste the cookie export, name the profile, submit. Or set `COOKIE_FILE` to import it automatically on every boot.
2. **Settings** — choose defaults, limits, retention, and the automatic sync interval.
3. **API keys → Create key** — copy the key when it is shown; it is hashed afterwards.
4. **Playground** — run a test generation.

Accounts, credits, cookie expiry, and the account pool remain in sync automatically. Change the interval in **Settings** (`AUTO_SYNC_MINUTES`, default 15) or press **Sync accounts & credits now**. A background refresh also runs shortly after boot.

## Docker

```bash
cp .env.example .env
docker compose build
docker compose up -d
```

The `./data` directory is mounted into the container and holds `studio.db`, `master.key`, and `session.key`. Back up that directory; losing `master.key` makes stored cookies unreadable.

### Coolify

1. Create a new service from the Git repository.
2. Build pack: Dockerfile (or Docker Compose). Port: `4175`.
3. Add a persistent volume mounted at `/app/data` (required — without it, redeploys reset accounts, keys, settings, and job history).
4. Set environment variables: `ADMIN_PASSWORD`, optionally `API_KEY`, `PUBLIC_BASE_URL`, `SESSION_SECRET`, `COOKIE_FILE`.
5. Deploy, then import cookies from the dashboard or let `COOKIE_FILE` import them on boot.

`PUBLIC_BASE_URL` should be the external HTTPS URL (for example `https://images.example.com`). Generated media links use it when set.

## Configuration

All variables are optional except where noted.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `4175` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `ADMIN_PASSWORD` | — | Dashboard password. Empty means the dashboard is open |
| `SESSION_SECRET` | generated | Stable HMAC secret for dashboard sessions |
| `API_KEY` | — | Optional bootstrap key accepted by `/v1/*` |
| `COOKIE_FILE` | — | Cookie export imported automatically on boot (skipped if that profile already exists) |
| `COOKIE_PROFILE_NAME` | `Main account` | Profile name used for the auto-imported cookie file |
| `PUBLIC_BASE_URL` | request origin | Absolute base URL used in media links |
| `DEFAULT_MODEL` | `nano-banana-pro` | Default model |
| `DEFAULT_RATIO` | `1:1` | Default aspect ratio |
| `ACCOUNT_CONCURRENCY` | `1` | Parallel jobs per account (1–5) |
| `MAX_ATTEMPTS` | `3` | Attempts per job including failover (1–5) |
| `JOB_TIMEOUT_MS` | `300000` | Polling deadline (30s–15min) |
| `RETENTION_DAYS` | `30` | Job and upload-cache cleanup age (1–365) |
| `RATE_LIMIT_RPM` | `60` | Requests per minute per API key |
| `AUTO_SYNC_MINUTES` | `15` | Background account/credit/expiry refresh interval; `0` disables it |
| `DATA_DIR` | `./data` | SQLite database, keys, and session secret |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Settings changed in the dashboard override the defaults above and are stored in SQLite.

## API

Authenticate with `Authorization: Bearer sk-...`.

### Models

```bash
curl -s https://images.example.com/v1/models \
  -H "Authorization: Bearer $IMAGE_STUDIO_KEY"
```

### Text to image

```bash
curl -s https://images.example.com/v1/images/generations \
  -H "Authorization: Bearer $IMAGE_STUDIO_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nano-banana-pro",
    "prompt": "A ceramic mug on a linen tablecloth, soft morning light",
    "ratio": "1:1",
    "n": 1,
    "response_format": "url"
  }'
```

`n` defaults to 1 and is clamped to 1–4. `ratio` accepts `1:1`, `9:16`, `16:9`, `4:3`, `3:4`, `3:2`, `2:3`, `21:9`, `5:4`, `4:5`. A custom `size` such as `864x1536` is also accepted for text-to-image.

### Image to image

Send references as data URLs in JSON:

```bash
curl -s https://images.example.com/v1/images/edits \
  -H "Authorization: Bearer $IMAGE_STUDIO_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "genai_seedream4.5",
    "prompt": "Repaint this scene as a soft watercolor",
    "images": ["data:image/png;base64,..."]
  }'
```

Multipart uploads are supported for OpenAI SDK compatibility:

```bash
curl -s https://images.example.com/v1/images/edits \
  -H "Authorization: Bearer $IMAGE_STUDIO_KEY" \
  -F model=genai_seedream4.5 \
  -F prompt="Repaint this scene as a soft watercolor" \
  -F image=@photo.png
```

Up to 4 references, 20 MB each, 25 MB per remote download. Image-to-image output follows the reference aspect ratio; a `size`/`ratio` on an edit request does not change it. Public remote URLs are accepted with SSRF protection.

### Asynchronous jobs

Add `Prefer: respond-async` to receive `202` with a job id, then poll:

```bash
curl -s https://images.example.com/v1/images/generations \
  -H "Authorization: Bearer $IMAGE_STUDIO_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: respond-async" \
  -d '{"model":"gemini","prompt":"A lighthouse at dusk","ratio":"16:9"}'

curl -s https://images.example.com/api/jobs/JOB_ID \
  -H "Authorization: Bearer $IMAGE_STUDIO_KEY"
```

The polling endpoint accepts the same `Authorization: Bearer` key that created the job (a dashboard session also works). `Idempotency-Key` is supported so retries return the existing job instead of billing twice.

### Responses

Synchronous success:

```json
{
  "created": 1760000000,
  "data": [
    { "url": "https://images.example.com/api/media/job_.../0?t=...", "revised_prompt": "..." }
  ],
  "model": "gemini",
  "output": { "ratio": "16:9", "size": "1536x864", "partial": false }
}
```

`response_format` accepts `url` (default) or `b64_json`; the aliases `base64`, `base_64`, `output_format`, and `output` also work. Signed media links expire after 7 days and do not require the API key, even though the upstream provider URL may expire sooner. `output.size` reports the requested canvas; the provider may return a slightly scaled image, so trust the real dimensions of the downloaded file.

Errors use the OpenAI shape:

```json
{ "error": { "message": "A prompt is required.", "type": "invalid_request_error", "param": "prompt", "code": "invalid_prompt" } }
```

`401` authentication, `429` rate limit or busy accounts, `502` generation failure, `503` no usable accounts.

### Dashboard maintenance endpoints

These use the dashboard session cookie, not an API key:

```bash
curl -s -X POST https://images.example.com/api/automation/sync -b cookies.txt
curl -s -X DELETE https://images.example.com/api/jobs -b cookies.txt
curl -s -X POST https://images.example.com/api/settings/password \
  -H "Content-Type: application/json" \
  -d '{"currentPassword":"old","newPassword":"new-password"}' -b cookies.txt
curl -s -X PATCH https://images.example.com/api/accounts/PROFILE_ID \
  -H "Content-Type: application/json" \
  -d "$(jq -n --rawfile f cookies.txt '{content:$f}')" -b cookies.txt
```

`PATCH /api/accounts/:id` accepts `name`, `enabled`, and `content` (a fresh cookie export). When `content` is sent the stored cookies are replaced after an identity check, then the profile re-syncs automatically; the response includes `synced` or `syncError`.

## Accounts and sessions

- Imported cookies are encrypted with AES-256-GCM using `data/master.key`.
- The dashboard shows a cookie expiry date and days-left badge when the export includes expiry metadata (JSON or Netscape format). Plain `name=value;` header exports carry no expiry, so the UI shows "No expiry"; TikTok sessions cannot be refreshed without an interactive login, so use **Edit cookies** on the profile card (or re-import) whenever a session starts failing. Any `Set-Cookie` headers TikTok returns are absorbed into the stored profile automatically and retried once.
- **Sync** discovers sub-accounts and tiers. **Credits** refreshes balances. **Validate** checks one account against the platform.
- A failed account is retried on another account automatically (`MAX_ATTEMPTS`), and already-uploaded references are reused so failures do not re-upload.
- Disable a profile or account to remove it from the pool without deleting its record.
- The account pool header totals credits and estimates how many images remain (4 points each). Unknown balances are marked with `+`.
- **Settings → Admin password** changes the dashboard password (stored as a salted scrypt hash). `ADMIN_PASSWORD` remains a recovery password, and existing sessions stay valid.
- **Jobs → Clear history** deletes every job record (`DELETE /api/jobs`). Generated images stay at the provider until its CDN expires.

Each generated image costs 4 platform points.

## Storage and privacy

- SQLite holds profiles, encrypted cookies, accounts, jobs, API key hashes, and uploaded-reference URLs.
- Generated images are never stored locally; media links are proxied from the provider with a short-lived signature.
- Retention cleanup runs at boot and every six hours; expired jobs and upload-cache entries are removed.
- All state lives in `DATA_DIR`. Mount it as a persistent volume (Docker/Coolify: `/app/data`). If you lose `master.key`, stored cookies cannot be decrypted.
- Deleting a profile removes its accounts and revoked upload cache; job history remains but no longer has a usable account reference.

## Development

```bash
npm run dev    # node --watch
node --check src/server.js
```

Layout:

```
src/
  server.js        static server, CORS, boot tasks
  api.js           dashboard + OpenAI routes
  jobs.js          job lifecycle, failover, polling
  accounts.js      cookie profiles, sync, credits
  provider/
    client.js      submit / check / poll
    upload.js      TOS upload + AWS4 signing
    png.js         blank canvas for text-to-image
    refs.js        SSRF-guarded reference fetcher
    pool.js        account slots and waiters
public/            dashboard (vanilla HTML/CSS/JS)
```

## Troubleshooting

- **`no_accounts`** — import a cookie file and press Sync; check the expiry badge.
- **`invalid_cookies`** — use the exported cookie file, not a copied request header from a browser devtools session that omits `HttpOnly` cookies.
- **Session expired** — re-export cookies from an authenticated browser and import them again.
- **Partial results** — some drafts fail while others succeed; the service returns the images it has and marks the job `partial`.
- **Missing images** — media links expire after 7 days; regenerate the job.
- **SQLite `ExperimentalWarning`** — expected on Node 24; the built-in module is stable enough for this workload.

## License

Private project. Use it only with accounts and content you are allowed to use.
