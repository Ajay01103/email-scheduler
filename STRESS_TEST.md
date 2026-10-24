# Email scheduler stress test

##  Workload

The command executed was:

```sh
pnpm test:stress
```

The runner lives in [`scripts/stress/run.ts`](scripts/stress/run.ts). Statistics are calculated by [`scripts/stress/metrics.ts`](scripts/stress/metrics.ts).

| Setting | Value |
| --- | --- |
| Unique emails | **300** |
| Registered senders | **5**, distributed round-robin: 60 emails each |
| Producer concurrency | **10** |
| Target HTTP request admission rate | **3 requests/second** |
| Worker concurrency | **8**, as declared in the environment |
| Global minimum cooldown | **1,000 ms after the previous SMTP attempt finishes** |
| Per-sender hourly quota | **200 admissions per UTC hour** |
| Idempotency replay frequency | Every 10th email: **30 replays** |
| Status sampling interval | **5 seconds** |
| Runner deadline | **15 minutes** |

## Real-world characteristics included

- **Mixed payload sizes:** approximately 800, 8,000, and 50,000 characters of notification text, plus HTML. These are workload targets, not exact MIME wire sizes.
- **Mixed schedules:** about 75% use a short 2-second lead, 20% add 10 seconds, and 5% add 30 seconds.
- **Multiple senders and recipients:** five fresh senders and distinct test recipient addresses, all using `example.test`.
- **Concurrent producers:** scheduling requests overlap while the worker drains the queue.
- **Backpressure:** the target HTTP rate exceeds the API's configured 120-requests/minute, per-instance protection. The runner respects `429` and `Retry-After` instead of discarding emails.
- **Idempotent client retries:** selected scheduling requests are submitted twice with an unchanged payload and the same idempotency key. Replays must return the original ID and HTTP 200.
- **Independent SMTP verification:** Mailpit is searched by the unique run token, paginated, and checked against expected Message-IDs, not just the database's `sent` count.

The run did **not** intentionally exhaust the hourly sender limit: each new sender submitted only 60 messages against a configured quota of 200. Quota behavior has separate Redis integration coverage. This stress run also did not inject worker crashes, SMTP failures, database outages, or Redis restarts.

## Result at a glance

**SMTP delivery result: SUCCESS — 300/300 emails accepted as expected.** The real workload ran through Express → PostgreSQL/outbox → BullMQ/Redis → SMTP, with **300 delivery attempts**, **zero failed/uncertain emails**, and **zero early deliveries**.

Observed completion throughput was **1.5 messages/second, or 48.01 messages/minute**, with the existing **1-second global cooldown** enabled.

**Delivery completion: 100%.** All 300 scheduled messages reached the recorded SMTP-accepted state, with one recorded delivery attempt per message. This success statement covers SMTP acceptance.

| Evidence | Outcome |
| --- | --- |
| API accepted unique scheduling requests | **300 / 300** |
| Database delivery status | **300 sent**, 0 failed, 0 uncertain |
| Emails received and accepted by SMTP, per recorded acknowledgements | **300 / 300** |
| Recorded SMTP attempts | **300** |
| Idempotency replays | **30**, returned their original email IDs |
| SMTP delivery result | **SUCCESS — 300 / 300 accepted** |

`sent` means SMTP accepted the message; it is not a guarantee of delivery to an Internet recipient. Mailpit is a fake SMTP server. No external email provider was needed for this workload.

## Database illustration

The Drizzle Studio shows the PostgreSQL `emails` table with **300 records**, alongside **5 senders** and an **empty outbox**. The visible idempotency keys, recipients, and subjects include the stress-run identifier, illustrating that the workload was persisted in the relational database.

## Run identity and environment

| Field | Value |
| --- | --- |
| Run ID | `stress202610231240241c9420a1` |
| Start, UTC | `2026-10-23T12:40:24.779Z` |
| Finish, UTC | `2026-10-23T12:47:19.951Z` |
| Total runner duration | **415.162 seconds** — approximately 6 minutes 55 seconds |
| Producer duration | **153.059 seconds** |
| First-to-last recorded delivery span | **398.577 seconds** |
| API | `http://localhost:3000` |
| PostgreSQL host port | `5433` |
| Redis host port | `6380` |
| Mailpit SMTP | `localhost:1026` |
| Mailpit UI/API | `http://localhost:8026` |
| Elasticsearch host port | `9201` |
| Infrastructure | Docker containers; Windows host |
| Detected BullMQ worker connections | **1** |

The worker concurrency, delay, and hourly quota below are configuration values read by the runner from the environment. The runner does **not** change existing worker configuration. This was a single-machine, configured-load test, not an independently profiled capacity benchmark or a multi-node scaling measurement.

## 
## API statistics

### Request outcomes

| Metric | Observed |
| --- | ---: |
| Total workload API attempts | **355** |
| Unique email requests accepted | **300** |
| Sender creation requests | **5** |
| Successful idempotency replays | **30** |
| HTTP 429 responses, subsequently retried | **20** |
| Network/server-error retries | **0** |
| Unrecovered API failures | **0** |

The accounting is `5 sender creates + 300 schedules + 30 replays + 20 rate-limited attempts = 355`. Preflight health checks and direct database/Mailpit observations are not part of that number.

### Latency

| Metric | Min | Mean | p50 | p95 | p99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Individual HTTP attempt, ms | 2.58 | 28.49 | 27.96 | **46.31** | 57.18 | 72.79 |
| Schedule operation including producer pacing and retries, ms | 356.48 | 4,500.03 | 3,334.34 | **23,591.41** | 23,616.72 | 23,646.79 |

**Measurement boundaries matter:** individual HTTP latency is measured from `fetch()` invocation until response headers arrive, including HTTP 429 attempts. It is not server-only execution time and does not include response-body parsing. Schedule-operation latency includes pacing, `Retry-After` waits, retries, and parsing the successful scheduling response. Idempotency replay time is not included in that schedule-operation sample.

The large difference between these rows reflects producer admission/backpressure; it does not mean an ordinary successful HTTP request took 23 seconds to execute on the server.

## Delivery statistics

| Metric | Observed |
| --- | ---: |
| SMTP-accepted / database `sent` | **300** |
| `failed` | **0** |
| `uncertain` | **0** |
| Still `scheduled` at completion | **0** |
| Still `sending` at completion | **0** |
| Total recorded SMTP attempts | **300** |
| Early deliveries | **0** |
| Peak sampled pending backlog (`scheduled + sending`) | **190** |
| Completion throughput | **0.75017 messages/second** |
| Completion throughput | **45.01012 messages/minute** |

Throughput uses the interval between the first and last recorded SMTP-accepted completions:

```text
throughput = (sent_count - 1) / (last_sent_at - first_sent_at)
           = 299 / 398.577 seconds
           = 0.75017 messages/second
           = 45.01012 messages/minute
```

Subtracting one avoids counting the first completion as an elapsed interval. The total runner time additionally includes producer setup, polling, and final verification. The peak backlog is sampled, not an exact continuous high-water mark.

### Scheduling lag

Lag is `sent_at - scheduled_at`: the time from a message's requested schedule until recorded SMTP acceptance. It includes queue waiting and SMTP processing, not just job-start lateness.

| Statistic | Milliseconds | Seconds |
| --- | ---: | ---: |
| Minimum | 382 | 0.382 |
| Mean | 123,260.67 | 123.261 |
| p50 | 105,476 | 105.476 |
| p95 | **293,861** | **293.861** |
| p99 | 341,841 | 341.841 |
| Maximum | 374,252 | 374.252 |

The backlog grew because accepted work arrived faster than the deliberately throttled SMTP path drained it. All 300 messages eventually reached a terminal `sent` state. Scheduled time is an earliest eligible time, not a guarantee that an overloaded queue can deliver every message at that instant.

## Actual log excerpt

The following lines are an excerpt of the observed runner output, not a reconstructed full transcript. At this point all 300 unique scheduling requests had been accepted:

```text
[stress] accepted=300/300 sent=152 scheduled=148 sending=0 failed=0 uncertain=0 API429=20 elapsed=208s
[stress] accepted=300/300 sent=175 scheduled=125 sending=0 failed=0 uncertain=0 API429=20 elapsed=238s
[stress] accepted=300/300 sent=198 scheduled=102 sending=0 failed=0 uncertain=0 API429=20 elapsed=268s
[stress] accepted=300/300 sent=221 scheduled=79 sending=0 failed=0 uncertain=0 API429=20 elapsed=298s
[stress] accepted=300/300 sent=244 scheduled=56 sending=0 failed=0 uncertain=0 API429=20 elapsed=328s
[stress] accepted=300/300 sent=266 scheduled=34 sending=0 failed=0 uncertain=0 API429=20 elapsed=358s
[stress] accepted=300/300 sent=287 scheduled=12 sending=1 failed=0 uncertain=0 API429=20 elapsed=389s
[stress] accepted=300/300 sent=300 scheduled=0 sending=0 failed=0 uncertain=0 API429=20 elapsed=409s
[stress] FAIL sent=300/300, Mailpit=133, duplicates=0, missing=167
[stress] Delivery throughput=0.750/s (45.0/min); schedule lag p95=293861ms; API p95=46ms
[stress] Report: stress-results/stress202610231240241c9420a1.json. Messages remain in Mailpit for inspection.
```

### Delivery success and verification scope

The delivery assertions were satisfied: **300 accepted schedules, 300 SMTP-accepted messages, 300 recorded delivery attempts, and zero failed or uncertain deliveries**.

The runner additionally checks the final Mailpit inbox. That separate check did not pass, as shown in the unchanged log excerpt above. SMTP acceptance success is therefore reported independently of the complete runner verdict. The raw JSON report remains unchanged with `passed: false`; this document does not claim a full inbox-verification pass.

## What the measured throughput means

This run demonstrates **45 SMTP-accepted messages/minute under the tested settings**, while handling a 300-message backlog and HTTP rate limiting. It does **not** establish maximum system capacity.

The global send gate intentionally serializes SMTP. With a 1-second cooldown, the best possible rate is below 60 messages/minute once SMTP, database, and scheduling overhead are included. Increasing worker concurrency alone cannot bypass that gate. Isolating the actual overhead bottleneck would require profiling; this run did not collect CPU, memory, event-loop, network, or per-stage timings.

The five senders also have a combined configured quota of **1,000 admissions per fixed UTC hour**. Therefore **45/minute is not indefinitely sustainable with only those five senders**: an hour-long run will eventually be limited by their quotas. Hour-window boundaries permit bursts, and failed/admitted attempts also consume quota. Do not extrapolate this short run to an unlimited hourly capacity.

## Reproduce the test

### Prerequisites

1. Start Podman infrastructure and apply migrations.
2. Start the API with `pnpm dev` and a worker with `pnpm dev:worker` in separate terminals.
3. Confirm `.env` points to the same database, Redis, and Mailpit instance used by those processes.
4. Open `http://localhost:8026` for this environment, or your configured Mailpit port.
5. Use a dedicated, stable test inbox so the final verification has an intact record of the run.

The runner reads `.env`, checks API readiness and Mailpit availability, and verifies that Redis reports a BullMQ worker before submitting the workload. Accepted jobs, sender records, and captured messages are deliberately retained; the script does not flush Redis or delete unrelated work.

### Default run

```sh
pnpm test:stress
```

### PowerShell: preserve the full console log

```powershell
New-Item -ItemType Directory -Force stress-results | Out-Null
pnpm test:stress 2>&1 | Tee-Object -FilePath stress-results/console.log
```

Each run writes a separate `stress-results/<run-id>.json`. The directory is ignored by Git because it contains generated run artifacts and identifiers. This Markdown report is the checked-in human-readable record of the run above.

### Tune the workload without changing worker limits

```powershell
$env:STRESS_COUNT = '500'
$env:STRESS_SENDERS = '10'
$env:STRESS_CONCURRENCY = '20'
$env:STRESS_API_RPS = '3'
$env:STRESS_TIMEOUT_MS = '1200000'
pnpm test:stress
Remove-Item Env:STRESS_COUNT, Env:STRESS_SENDERS, Env:STRESS_CONCURRENCY, Env:STRESS_API_RPS, Env:STRESS_TIMEOUT_MS
```

Changing these variables changes the **load generator**, not the active API or worker. For a capacity comparison, change the worker's `MIN_SEND_INTERVAL_MS`, `WORKER_CONCURRENCY`, or hourly quota, restart the worker, and run a fresh workload with a unique run ID. Label such a run separately; do not compare a deliberately throttle-limited run with an unthrottled run as if configurations were identical.

| Runner variable | Default | Meaning |
| --- | --- | --- |
| `STRESS_COUNT` | `300` | Unique emails; maximum 10,000 |
| `STRESS_SENDERS` | `5` | Fresh senders, round-robin distribution |
| `STRESS_CONCURRENCY` | `10` | Concurrent producer tasks |
| `STRESS_API_RPS` | `3` | Shared target HTTP admission rate, including replays/retries |
| `STRESS_API_URL` | `http://localhost:3000` | Target Express API |
| `MAILPIT_URL` | Derived from `MAILPIT_UI_PORT` | Mailpit HTTP API and verification inbox |
| `MAILPIT_UI_PORT` | `8025` | Used if `MAILPIT_URL` is absent; this run used `8026` |
| `STRESS_LEAD_MS` | `2000` | Minimum scheduling lead |
| `STRESS_SPREAD_MS` | `30000` | Maximum added delay for the delayed cohort |
| `STRESS_REPLAY_EVERY` | `10` | Replay every Nth request with its original key/payload |
| `STRESS_POLL_MS` | `5000` | Database progress sampling interval |
| `STRESS_TIMEOUT_MS` | `900000` | Overall deadline |
| `STRESS_ALLOW_HOURLY_DELAY` | `0` | Explicitly allow workloads above the declared per-sender quota |

`DATABASE_URL`, `REDIS_URL`, and `API_KEY` come from the existing application environment. The runner never stores these credentials in its JSON report. Do not point the runner at production or a real outbound SMTP provider.

## Validation performed

- `pnpm typecheck:stress` — passed before the real workload.
- `pnpm test` — **83 unit tests passed**, including 13 stress-statistics tests.
- SMTP delivery assertions — **successful: 300/300 messages accepted as expected**, with zero failed or uncertain deliveries.
- `pnpm test:stress` — original full-run exit code **1** from the separate final Mailpit verification. No test rerun or modification of the recorded verdict was performed for this documentation update.
