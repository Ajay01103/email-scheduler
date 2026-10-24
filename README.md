# Email Scheduler

A TypeScript service for scheduling one-recipient emails through SMTP, with a REST API, durable PostgreSQL state, BullMQ delayed jobs, Elasticsearch search, and a read-only queue dashboard. API and worker are separate processes; **both must run** for scheduled messages to be delivered and indexed.

## Stack and prerequisites

- **Node.js 24+**, **pnpm 11.12.0** (`packageManager` pin), **TypeScript 7.0.2**.
- **Podman Desktop on Windows**, a running Podman machine, and a working Compose provider (`podman compose version`). Initialize a machine with `podman machine init` if needed, then `podman machine start`, or start it through Podman Desktop.
- Compose supplies PostgreSQL 17, Redis 7, Elasticsearch 8.17.0, and Mailpit. Allow enough VM memory for all services; Elasticsearch alone has a 1 GiB container limit and 512 MiB heap.
- Express 5, BullMQ, Nodemailer, and Drizzle ORM/Kit **1.0.0-rc.5**, pinned together.

The Drizzle pins follow the [live PostgreSQL getting-started guide](https://orm.drizzle.team/docs/get-started/postgresql-new), which currently recommends the `rc` channel. The database client uses the object form `drizzle({ client: pool })` with `pg.Pool`; migrations use `drizzle({ client })`. This project uses SQL-style queries and joins, not old relations APIs. Drizzle v1 documentation may still carry beta banners/examples: do not mix older relational-query APIs or floating release tags into this pinned project.

## Quick start: application on Windows, infrastructure in Podman

Run commands from the repository root. Use one shell environment consistently rather than mixing Windows Node/pnpm with WSL installations.

### 1. Configure the environment

POSIX shell:

```sh
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

Do not overwrite an existing `.env`. Edit the copy before starting services:

- Set a strong `POSTGRES_PASSWORD`; keep the password in `DATABASE_URL` consistent (URL-encode special characters in the URL).
- Set a random `API_KEY` of at least **32 characters**.
- Set `DASHBOARD_USER` and a random `DASHBOARD_PASSWORD` of at least **16 characters**.
- Keep host-development connection addresses on `localhost`, not Compose service names. Set host-port overrides below if the defaults are occupied.
- Do not commit `.env` or reuse example credentials outside local development.

Generate random secret material locally, once per secret:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

### 2. Resolve occupied host ports

If you already have Redis on **6379** or Mailpit on **1025/8025**, leave those services alone and publish this project's containers on different host ports. These variables are read by Compose from `.env`:

| Variable | Default host port | Example alternate | Container port |
| --- | ---: | ---: | ---: |
| `POSTGRES_HOST_PORT` | 5432 | 15432 | 5432 |
| `REDIS_HOST_PORT` | 6379 | 16379 | 6379 |
| `SMTP_HOST_PORT` | 1025 | 11025 | 1025 |
| `MAILPIT_UI_PORT` | 8025 | 18025 | 8025 |
| `ELASTICSEARCH_HOST_PORT` | 9200 | 19200 | 9200 |

For example, add/change these assignments in `.env` (choose ports that are actually free):

```dotenv
POSTGRES_HOST_PORT=15432
REDIS_HOST_PORT=16379
SMTP_HOST_PORT=11025
MAILPIT_UI_PORT=18025
ELASTICSEARCH_HOST_PORT=19200
```

**Host port overrides do not rewrite application connection settings.** For locally running API/worker processes, also update:

```dotenv
DATABASE_URL=postgresql://emails:YOUR_URL_ENCODED_PASSWORD@localhost:15432/emails
REDIS_URL=redis://localhost:16379
ELASTICSEARCH_URL=http://localhost:19200
SMTP_HOST=localhost
SMTP_PORT=11025
```

Replace `YOUR_URL_ENCODED_PASSWORD` with your configured password. With default published ports, use `localhost:5432`, `localhost:6379`, `localhost:9200`, and SMTP `localhost:1025` instead. Open Mailpit at `http://localhost:18025` for the alternate example, or `http://localhost:8025` by default.

`SMTP_HOST_PORT` controls only the published **Mailpit** port; it is not the SMTP server port setting for an external provider.

### 3. Install, start dependencies, and migrate

```sh
pnpm install
pnpm infra:up
podman compose ps
```

`infra:up` starts only PostgreSQL, Redis, Mailpit, and Elasticsearch. Wait for database/Redis/Elasticsearch health checks to become healthy; the first Elasticsearch startup can take a while. Then:

```sh
pnpm db:migrate
```

### 4. Run API and worker in separate terminals

Terminal 1, from the repository root:

```sh
pnpm dev
```

Terminal 2, from the repository root:

```sh
pnpm dev:worker
```

Both load `.env`. Restart the processes after configuration changes. `dev` and `dev:worker` are watchers intended for local development.

Default URLs:

- API: `http://localhost:3000`
- Liveness: `http://localhost:3000/health/live`
- Readiness: `http://localhost:3000/health/ready`
- Queue dashboard: `http://localhost:3000/admin/queues` (HTTP Basic authentication)
- Mailpit inbox: `http://localhost:8025` (or your `MAILPIT_UI_PORT`)

Readiness checks PostgreSQL, Redis, and Elasticsearch; it does **not** verify worker activity or SMTP reachability. The API also checks these dependencies before listening.

## Alternative: run everything in containers

Copy/configure `.env` as above, then stop any host API/worker processes to avoid competing deployments or API port conflicts.

For bundled Mailpit, use these application settings even if its published host port is `11025`:

```dotenv
CONTAINER_SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_REQUIRE_TLS=false
```

```sh
podman compose up --build -d
podman compose ps -a
podman compose logs -f api worker
```

Compose builds the Node 24 image, runs the one-shot `migrate` service after PostgreSQL is healthy, then starts API and worker after successful migration and healthy Redis/Elasticsearch dependencies. Use a Compose provider supporting these dependency conditions. Exit code 0 for `migrate` is expected; it is not a long-running service.

The `.env` connection URLs are for **host development**. Compose explicitly overrides `DATABASE_URL`, `REDIS_URL`, and `ELASTICSEARCH_URL` with internal addresses `postgres:5432`, `redis:6379`, and `elasticsearch:9200`. It overrides `SMTP_HOST` using `CONTAINER_SMTP_HOST` (default `mailpit`). Host-port variables change published bindings, not these internal addresses.

**`SMTP_PORT` is shared by both workflows.** Set it back to the published port (for example `11025`) when returning to a host worker, and to `1025` for container-to-Mailpit delivery. Published Mailpit ports may remain alternate ports in both workflows.

Useful lifecycle commands:

```sh
podman compose logs --tail=100 api worker migrate
pnpm infra:down
```

`infra:down` runs `podman compose down`, stopping the **entire** Compose project, including API/worker if started. Named PostgreSQL, Redis, and Elasticsearch volumes survive ordinary `down`/`up`. **Do not use `down -v` unless you intend to delete persistent data.**

## API

Every `/v1` request requires `X-API-Key: <your API_KEY>`. Scheduling also requires `Idempotency-Key`. Health endpoints are unauthenticated. The dashboard uses separate HTTP Basic credentials and Bull Board `readOnlyMode: true`; retry deliveries through the API, not dashboard mutations.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health/live` | Process liveness; 503 while stopping |
| `GET` | `/health/ready` | Dependency readiness; 503 when unavailable/stopping |
| `POST` | `/v1/senders` | Create `{ "name", "email" }`; returns 201, duplicate address 409 |
| `GET` | `/v1/senders` | List senders as `{ items }` |
| `POST` | `/v1/emails` | Schedule an email; returns 201, or 200 for an identical replay |
| `GET` | `/v1/emails` | PostgreSQL listing; filters `status`, `senderId`, plus `offset`, `limit` |
| `GET` | `/v1/emails/search` | Elasticsearch search; `q`, `status`, `senderId`, `offset`, `limit` |
| `GET` | `/v1/emails/:id` | Read authoritative PostgreSQL email state; 404 if absent |
| `POST` | `/v1/emails/:id/retry` | Operator retry of `failed` or explicitly acknowledged `uncertain` state |
| `GET` | `/admin/queues` | Read-only Bull Board dashboard, HTTP Basic authentication |

### Create a sender and schedule an email with curl

The following examples are for a **POSIX shell** (Git Bash/WSL/Linux/macOS). Set `API_KEY` to the same value as `.env`; shell variables are not automatically loaded from that file.

```sh
API_KEY='replace-with-your-configured-api-key'
curl --fail-with-body -sS http://localhost:3000/v1/senders \
  -H "X-API-Key: $API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"name":"Example Sender","email":"sender@example.test"}'
```

Copy the returned sender `id` into `SENDER_ID`, then schedule:

```sh
SENDER_ID='paste-the-returned-sender-uuid'
curl --fail-with-body -sS http://localhost:3000/v1/emails \
  -H "X-API-Key: $API_KEY" \
  -H 'Idempotency-Key: example-message-2030-01' \
  -H 'Content-Type: application/json' \
  --data "{\"senderId\":\"$SENDER_ID\",\"to\":\"recipient@example.test\",\"subject\":\"Scheduled hello\",\"text\":\"Hello from Email Scheduler\",\"scheduledAt\":\"2030-01-02T03:04:05Z\"}"

curl --fail-with-body -sS 'http://localhost:3000/v1/emails?status=scheduled&limit=20' \
  -H "X-API-Key: $API_KEY"
curl --fail-with-body -sS 'http://localhost:3000/v1/emails/search?q=hello&limit=20' \
  -H "X-API-Key: $API_KEY"
```

**PowerShell equivalent**, using `curl.exe` rather than the legacy `curl` alias. Piping JSON to stdin avoids native-command JSON quoting differences:

```powershell
$apiKey = 'replace-with-your-configured-api-key'
$senderJson = @{ name = 'Example Sender'; email = 'sender@example.test' } | ConvertTo-Json -Compress
$sender = $senderJson | curl.exe --fail-with-body -sS http://localhost:3000/v1/senders -H "X-API-Key: $apiKey" -H 'Content-Type: application/json' --data-binary '@-' | ConvertFrom-Json

$emailJson = @{
    senderId = $sender.id
    to = 'recipient@example.test'
    subject = 'Scheduled hello'
    text = 'Hello from Email Scheduler'
    scheduledAt = '2030-01-02T03:04:05Z'
} | ConvertTo-Json -Compress
$email = $emailJson | curl.exe --fail-with-body -sS http://localhost:3000/v1/emails -H "X-API-Key: $apiKey" -H 'Idempotency-Key: example-message-2030-01' -H 'Content-Type: application/json' --data-binary '@-' | ConvertFrom-Json
curl.exe --fail-with-body -sS "http://localhost:3000/v1/emails/$($email.id)" -H "X-API-Key: $apiKey"
```

Use one example flow, not both with the same sender address: duplicate sender creation returns 409. The explicit **2030** timestamp demonstrates the required future ISO 8601 format with `Z`/UTC offset. For an immediate Mailpit test, choose a timestamp a minute or two ahead of the current time before submitting, and use a fresh idempotency key. The 2030 example will not arrive until its scheduled time.

### Request rules and responses

- Scheduling fields: `senderId` (existing UUID), `to` (one email address), `subject`, `text`, optional `html`, and `scheduledAt` (ISO 8601 with explicit timezone). New schedules must be in the future.
- Sender names are trimmed, 1–200 characters; sender addresses are normalized to lowercase. Subjects are 1–998 characters, text/HTML each at most 100,000 characters. Header fields reject CR/LF/NUL; unknown body/query properties are rejected. JSON body limit is 1 MiB.
- Idempotency keys are 1–128 printable non-space ASCII characters. Reusing a key with the same normalized request returns the existing record, even after its scheduled time. A different payload with the same key returns **409**. Keys are shared globally, not scoped to a tenant or sender. A fresh key creates a separate email and can send a duplicate.
- Statuses: `scheduled`, `sending`, `sent`, `failed`, `uncertain`. `sent` means **accepted by SMTP**, not confirmed inbox delivery.
- List pagination defaults to `offset=0&limit=20`; limit is 1–100, offset at most 1,000,000. Search additionally requires `offset + limit <= 10000`; optional `q` is 1–500 non-whitespace characters. Search returns `{ items, total, offset, limit }`; database listing returns `{ items, offset, limit }`.
- Common errors: 400 invalid input/sender reference, 401 missing/wrong API key, 404 missing resource, 409 conflict/unsafe retry, 413 oversized body, 429 request throttling. `/v1` is limited to 120 requests/minute/IP; dashboard to 60/minute/IP, per API process.
- There are **no email cancellation, editing, or rescheduling endpoints**. Do not infer those capabilities from Bull Board or BullMQ internals.

### Operator retry

First inspect the email and SMTP/provider logs. For a `failed` email, use an empty JSON object:

```sh
EMAIL_ID='paste-the-email-uuid'
curl --fail-with-body -sS "http://localhost:3000/v1/emails/$EMAIL_ID/retry" \
  -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' --data '{}'
```

For an `uncertain` email, the endpoint requires the explicit body:

```json
{ "acknowledgeDuplicateRisk": true }
```

This acknowledgement is not a deduplication mechanism. A retry sets `scheduledAt` to now, resets attempts, increments the delivery generation, and creates new schedule/index outbox events. Other states cannot be manually retried (409).

## Delivery guarantees and limits

### Durable scheduling and recovery

1. The API commits the email plus schedule/index events in **one PostgreSQL transaction**. PostgreSQL is the source of truth; a successful scheduling response does not require immediate enqueue/index completion.
2. The worker runs a transactional outbox loop, polling every **1 second** by default (`OUTBOX_POLL_MS`). Events are locked with `FOR UPDATE SKIP LOCKED`; failed dispatches remain durable and are deferred for 5 seconds. This is polling plus BullMQ delayed jobs, **not cron** or an in-memory-only timer.
3. BullMQ job IDs are deterministic: `<email UUID>-<generation>`. Repeated enqueue is deduplicated within a generation; an operator retry increments generation so stale jobs cannot deliver the new generation.
4. Reconciliation runs at worker startup and approximately every **30 seconds** (`RECONCILE_INTERVAL_MS`). It rebuilds schedule events for still-`scheduled` records, including after Redis queue loss, and replaces terminal queue records that would otherwise strand pending database work.
5. Sending claims have a **120-second lease** by default (`SEND_LEASE_MS`, minimum 120000). After expiry, reconciliation turns `sending` into `uncertain`, not automatically resendable. Detection can take an additional reconciliation interval and requires a running, healthy worker.

Compose configures Redis with **AOF enabled**, `appendfsync always`, `maxmemory-policy noeviction`, and a persistent volume. PostgreSQL and Elasticsearch also have named volumes. These settings improve local durability but do not replace backups, hardware durability, or high availability.

If Redis data is lost, pending scheduled jobs can be rebuilt from PostgreSQL, but **Redis quota/lock/cooldown state is lost**. The hourly quota cannot be reconstructed from queue recovery; review rate-limit exposure before resuming delivery. PostgreSQL data loss requires backup recovery, not a Redis rebuild.

### Rate limiting and concurrency

- One **global Redis send gate serializes SMTP attempts** across workers sharing its Redis keys. Default `MIN_SEND_INTERVAL_MS=1000` applies **after the previous attempt finishes/releases the gate**, including failed attempts. It is not simply one new send every wall-clock second; SMTP duration adds to the gap. The gate is lease-based, so process pauses/outages exceeding the lease are not a hard distributed fencing guarantee.
- `WORKER_CONCURRENCY=8` allows concurrent preparation/database work and pending job handling; it does **not** allow eight simultaneous SMTP sends through the global gate.
- A Redis Lua script atomically checks the shared gate and a per-sender **fixed UTC hourly window**, using **Redis `TIME`** rather than each worker's clock. Default quota: **200 admissions per sender per hour** (`MAX_EMAILS_PER_HOUR_PER_SENDER`), reset at the next UTC hour, not a rolling 60-minute window. Bursts across an hour boundary are possible.
- Denied jobs use BullMQ `moveToDelayed`/`DelayedError`: rate-limit waiting does **not** consume a failed attempt. A sender at quota waits until the next hour; other senders may proceed.
- Hourly slots are charged on **admission**, including admissions followed by failed SMTP attempts (or a failed claim). They are not refunded; this is intentionally conservative, not a count of successful deliveries.
- Scheduling, retries, concurrent workers, and delayed re-admission provide **best-effort ordering, not strict FIFO**, fairness, or an exact delivery-time SLA. Work runs no earlier than its scheduled time under normal clock operation, but congestion and outages can delay it.

### Retries and SMTP ambiguity

Explicit transient SMTP 4xx responses and recognized connection-setup failures (`EPRESMTP`, `EDNS`, `EAUTH`) are safe-retry candidates: at most **5 SMTP attempts per generation**, with exponential delays beginning at **2 seconds** (2, 4, 8, 16 seconds between the five attempts). Queue-level failures also have a five-attempt/exponential-backoff policy. Rate gates may delay retries further. Explicit permanent SMTP 5xx responses fail immediately; exhausted safe retries become `failed` and require operator action.

The SMTP socket has a hard **60-second total deadline**, below the minimum 120-second send lease, plus connection/greeting/inactivity timeouts. Safe retry deadlines are committed to PostgreSQL before requeueing, so recovery retains backoff. `ECONNECTION` alone is not safe to retry: Nodemailer also uses it after submission. A timeout, broken connection, missing final acknowledgement after possible acceptance, or crash after SMTP accepts but before the database records `sent` can leave delivery **ambiguous**. These become `uncertain` immediately or after lease recovery and are **not automatically retried**.

**Exactly-once SMTP delivery is impossible to guarantee here:** PostgreSQL and an SMTP server do not share an atomic transaction. Each generation uses a stable Message-ID, `<email UUID>.<generation>@SMTP_FROM_DOMAIN`, but SMTP/recipient systems are not required to deduplicate it. Stable IDs help investigation; they do not guarantee deduplication. Manually retrying `uncertain` mail can send duplicates, and a new generation has a different Message-ID.

## Search and reindexing

Elasticsearch is a derived, **eventually consistent** view of PostgreSQL. State changes create index events transactionally; the worker indexes the latest database row. Documents use PostgreSQL `version` with Elasticsearch `version_type: external_gte` to prevent older writes from replacing newer versions. Visibility also waits for Elasticsearch's refresh interval.

The index has an explicit strict mapping: identifiers/status are keywords, dates are dates, `version` is an integer, and recipient/content/sender fields are searchable text. Search covers subject, text, HTML, recipient, sender email, and sender name. Use `GET /v1/emails/:id` for authoritative current state rather than waiting for search refresh.

After Elasticsearch data loss or when populating a new `ELASTICSEARCH_INDEX`, restore connectivity and run:

```sh
pnpm search:reindex
```

For the full-container workflow:

```sh
podman compose exec worker pnpm search:reindex
```

Reindex creates the index if absent and scans PostgreSQL in batches. It **does not enqueue delivery or resend emails**. Outbox retry alone does not restore historical documents whose index events were already consumed. Existing incompatible mappings are not migrated automatically; use an appropriately configured new index and reindex. Keep the worker running to process ongoing updates.

## SMTP testing and external providers

**Mailpit is the default local sink**, not an Internet delivery service. Use `SMTP_SECURE=false`, `SMTP_REQUIRE_TLS=false`, and empty `SMTP_USER`/`SMTP_PASS`. Inspect messages in its UI; the current Compose service has no Mailpit storage volume, so do not treat that inbox as durable application history.

Optionally use an [Ethereal](https://ethereal.email/) test account or another SMTP provider. For Ethereal STARTTLS, for example:

```dotenv
SMTP_HOST=smtp.ethereal.email
CONTAINER_SMTP_HOST=smtp.ethereal.email
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_USER=YOUR_ETHEREAL_USERNAME
SMTP_PASS=YOUR_ETHEREAL_PASSWORD
```

Use credentials issued to you, never real secrets in checked-in files. View test messages through your Ethereal account; the API does not return preview URLs. External SMTP sends message bodies/addresses to that provider and may incur costs or provider limits. Ensure registered sender addresses are authorized by the provider.

- `SMTP_HOST` is used by a **host worker**. Compose replaces it with `CONTAINER_SMTP_HOST`; set both when switching to an external provider.
- `SMTP_PORT` is the actual destination port. Changing `SMTP_HOST_PORT` only changes local Mailpit publishing and has no effect on external SMTP.
- `SMTP_SECURE=true` selects implicit TLS (typically port 465). `false` permits STARTTLS (typically port 587); **`SMTP_REQUIRE_TLS=true` is recommended for external STARTTLS** so delivery cannot silently proceed without TLS. Follow the provider's port/TLS requirements.
- `SMTP_USER` and `SMTP_PASS` must either both be configured or both be empty. `SMTP_FROM_DOMAIN` controls the generated Message-ID domain, not the sender's From address, authentication, or DNS setup.

## Configuration reference

Application configuration is validated in `src/config.ts`; booleans must be literal `true` or `false`. Connection URLs and credentials are required unless a default is listed. `.env` is loaded for host processes; Compose passes an explicit environment to containers.

| Variable | Default / requirement | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, or `production`; Compose sets `production` |
| `PORT` | `3000` | API listen/published port |
| `DATABASE_URL` | Required | PostgreSQL URL; local database/user are `emails` |
| `REDIS_URL` | Required | BullMQ, global send gate, hourly quota |
| `ELASTICSEARCH_URL` | Required | Search service URL |
| `ELASTICSEARCH_INDEX` | `emails` | Index name; lowercase initial letter, then lowercase letters/digits/`_`/`-` |
| `API_KEY` | Required, ≥32 characters | Shared `/v1` administrative credential |
| `DASHBOARD_USER` | `admin` in app; explicitly required by Compose | Basic-auth username |
| `DASHBOARD_PASSWORD` | Required, ≥16 characters | Basic-auth password |
| `SMTP_HOST` | `localhost` | Host-worker SMTP destination; overridden in Compose |
| `SMTP_PORT` | `1025` | Destination SMTP port, including inside containers |
| `SMTP_SECURE` | `false` | Implicit TLS |
| `SMTP_REQUIRE_TLS` | `false` | Require STARTTLS when not using implicit TLS |
| `SMTP_USER`, `SMTP_PASS` | Optional pair | SMTP authentication |
| `SMTP_FROM_DOMAIN` | `example.test` | Generated Message-ID domain |
| `WORKER_CONCURRENCY` | `8` | Concurrent BullMQ processors, not parallel SMTP sends |
| `MIN_SEND_INTERVAL_MS` | `1000` | Positive minimum cooldown after attempt completion |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | `200` | Positive fixed-hour sender admission limit |
| `OUTBOX_POLL_MS` | `1000` | Positive polling interval |
| `RECONCILE_INTERVAL_MS` | `30000` | Positive recovery interval |
| `SEND_LEASE_MS` | `120000`, minimum `120000` | Database/send-gate lease and BullMQ lock duration |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |

Compose-only settings:

| Variable | Default / requirement | Purpose |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | Required | Database initialization and internal app URL; changing it does not rotate an existing volume's database password |
| `POSTGRES_HOST_PORT` | `5432` | Host PostgreSQL binding |
| `REDIS_HOST_PORT` | `6379` | Host Redis binding |
| `SMTP_HOST_PORT` | `1025` | Host Mailpit SMTP binding |
| `MAILPIT_UI_PORT` | `8025` | Host Mailpit web binding |
| `ELASTICSEARCH_HOST_PORT` | `9200` | Host Elasticsearch binding |
| `CONTAINER_SMTP_HOST` | `mailpit` | Overrides `SMTP_HOST` in app containers |

Changing published ports requires recreating the affected services with `pnpm infra:up` or `podman compose up -d`. Changing container application environment requires recreating API/worker too. Preserve existing data when updating database credentials.

## Stress testing

Run `pnpm test:stress` against the running API, worker, and Mailpit to schedule 300 real test emails across five senders. The runner measures API latency, throughput, scheduling lag, idempotency, and final Mailpit Message-ID verification. Keep the inbox unchanged until verification finishes.

See [STRESS_TEST.md](STRESS_TEST.md) for the actual run's statistics and log excerpt, its manual-deletion caveat, configuration options, and PowerShell log-capture commands. Generated JSON reports are written to `stress-results/` and ignored by Git.

## Development and tests

```sh
pnpm typecheck
pnpm build
pnpm test
```

`pnpm test` runs top-level unit tests with Node's test runner through `tsx` (validation and SMTP error classification); it does not run the integration directory. Build output is in `dist`; after building, run `pnpm start` and `pnpm start:worker` as separate processes.

Opt-in integration tests require running services and applied migrations. Use a **dedicated disposable test environment**, not production or an inbox/queue containing valuable work. Export connection settings matching that environment; the standalone Redis gate tests read `process.env.REDIS_URL` directly and otherwise default to `redis://localhost:6379`, so do not rely on `.env` alone for an alternate Redis port.

POSIX (default Redis port):

```sh
RUN_INTEGRATION=1 pnpm test:integration
```

POSIX with the alternate Redis port above:

```sh
RUN_INTEGRATION=1 REDIS_URL=redis://localhost:16379 pnpm test:integration
```

PowerShell:

```powershell
$env:RUN_INTEGRATION = '1'
$env:REDIS_URL = 'redis://localhost:16379' # Use 6379 if you kept the default
pnpm test:integration
Remove-Item Env:RUN_INTEGRATION
Remove-Item Env:REDIS_URL
```

`test:integration` runs `tests/integration/*.test.ts` serially; integration suites are opt-in with `RUN_INTEGRATION=1`. Check the test files for additional service-specific prerequisites. Without opt-in, skipped tests are not evidence that the backend works.

Other commands:

| Command | Purpose |
| --- | --- |
| `pnpm db:generate` | Generate migrations from `src/db/schema.ts`; review generated SQL |
| `pnpm db:migrate` | Apply committed migrations; uses a PostgreSQL advisory lock to serialize migration runs |
| `pnpm search:reindex` | Rebuild derived search documents without sending mail |

## Operations and production boundaries

The supplied Compose stack is **local-development infrastructure, not an Internet-ready production deployment**. Published ports bind to `127.0.0.1`; Redis, Elasticsearch (security disabled), and Mailpit have no service authentication in this configuration. Keep them off public networks.

Before production:

- Put API/dashboard behind TLS ingress and appropriate network/access controls. Basic authentication and API keys must not travel over plaintext public HTTP. The shared API key is an **administrator credential, not tenant isolation**, user authorization, or a sender-ownership boundary.
- Move secrets to a secret vault/managed secret delivery, rotate credentials, and enable authenticated/encrypted database, Redis, search, and SMTP connections appropriate to the deployment. Current Compose does not implement this hardening.
- Back up PostgreSQL and Redis, test restore procedures, plan Elasticsearch reindexing, and deploy monitored persistent storage/HA according to your recovery objectives. AOF/volumes are not backups or HA.
- Monitor dependency health **and worker activity**, `failed`/`uncertain` email counts, pending/aged outbox rows, queue depth/delayed backlog, Redis memory/storage, and SMTP errors/latency. A healthy API alone does not mean delivery is progressing.
- Keep clocks synchronized on Windows/Podman hosts and deployed nodes. Quotas use Redis time, but scheduling, delays, and database leases also depend on application clocks.
- Preserve graceful shutdown windows. The worker waits up to 90 seconds for active work; Compose gives it 100 seconds. Forced termination during SMTP can require uncertain-delivery review.
- Protect email bodies/recipient data in PostgreSQL, Elasticsearch, SMTP providers, and test inboxes; define retention and access policies. Request logging avoids bodies, query strings, and credentials, but operational storage still contains sensitive content.

Troubleshooting:

| Symptom | Check |
| --- | --- |
| Port already allocated | Set the relevant host-port variable, update host URLs/`SMTP_PORT`, then recreate services; don't stop unrelated user services |
| Worker cannot connect to Mailpit | Host worker: `localhost` + published port; container worker: `mailpit:1025`; external provider: set `CONTAINER_SMTP_HOST` too |
| API exits before listening | Valid secrets/config, completed migrations, and healthy PostgreSQL/Redis/Elasticsearch |
| Scheduled messages do not send | Worker running, actual future timestamp, quota/cooldown, SMTP settings, outbox/backlog, and authoritative email status |
| Search missing/stale | Worker/index outbox, Elasticsearch refresh, correct index; run reindex after search-data loss |
| Email is `uncertain` | Inspect SMTP acceptance/provider logs before acknowledging duplicate risk and retrying; never bulk-retry blindly |
| Full-container startup stalls | `podman compose ps -a` and `podman compose logs migrate postgres redis elasticsearch`; check VM memory and Compose dependency-condition support |

## Source map

- `src/api.ts`, `src/validation.ts`: authenticated routes, idempotency, operator retry, validation, dashboard, health checks.
- `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrate.ts`, `drizzle/`: durable state, database pool, migrations.
- `src/worker.ts`, `src/delivery.ts`, `src/queue.ts`: worker lifecycle, SMTP state machine, delayed queue jobs.
- `src/outbox.ts`, `src/rate-limit.ts`: durable dispatch/recovery and atomic Redis admission gate.
- `src/search.ts`, `src/reindex.ts`: strict mappings, versioned indexing, search, rebuild CLI.
- `docker-compose.yaml`, `Dockerfile`: Podman-compatible local infrastructure and full-container workflow.
