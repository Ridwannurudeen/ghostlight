# Ghostlight API

This directory contains the executable Node 22 service for Ghostlight's first network vertical: privacy-bounded
funnel analytics. It currently provides:

- advisory-lock-protected PostgreSQL startup migration and configured-scene seeding;
- a scene-signed, body-bound funnel ingestion endpoint with atomic rate limiting and idempotency;
- an analyst/moderator-only aggregate export endpoint that never exposes receipts, addresses, or actor digests;
- public liveness and database-backed readiness probes;
- JSON application logs, graceful lifecycle shutdown, strict type-checking, an emitted runtime build, and focused
  unit and PostgreSQL integration tests.

It does not yet provide the shared ghost pool, publishing/moderation routes, season synchronization, Creator Studio,
or Touring Kit. It is not deployed, and real desktop/mobile Explorer interoperability has not been proven.

## Trust boundary

`POST /v1/analytics/funnel` verifies a Decentraland auth chain and requires the exact production ADR-289 scene
metadata shape. For every request it:

- requires `signer: "decentraland-kernel-scene"` and an exact configured `sceneId`;
- accepts only `tld: "org"`, `network: "mainnet"`, the bounded realm fields, and a boolean `isGuest`;
- requires `hashPayload` to be the lowercase SHA-256 of the exact raw UTF-8 request body;
- rejects legacy-signed metadata, query strings, noncanonical paths, encoded bodies, non-JSON media types, payloads
  above 1,024 bytes, unknown contract fields, click events, future events, and expired UTC-day events;
- derives the actor, scene, and guest rate class only from the verified context.

This proves that the wallet controlling the auth chain signed the request. It does **not** cryptographically prove
that the metadata came from an official Explorer: an off-platform wallet can self-assert scene-shaped metadata.
Accordingly, this endpoint is aggregate-only self-reporting. Its data must never award value, elevate content to a
trusted channel, or serve as platform-attested gameplay proof. `TRUSTED_CATALYST_URL` is used for contract-wallet
signature verification and the seeded database allowlist; it is not scene provenance.

Before deployment, capture named and guest requests from the current desktop and mobile Explorers and verify their
metadata keys, World `sceneId`, chain length, raw-body hash, and v6 signature compatibility. Leave
`canonicalMetadataKeys` absent unless those captures prove a legacy bridge is required.

## Routes

### Health

| Route | Result |
| --- | --- |
| `GET /health/live` | `200` while the HTTP process is serving |
| `GET /health/ready` | `200` only when the one-second coalesced PostgreSQL probe is ready; otherwise sanitized `503` |

### Funnel ingestion

`POST /v1/analytics/funnel` accepts the strict funnel event contract:

```json
{
  "eventId": "evt_0123456789abcdef0123456789abcdef",
  "event": "wake",
  "occurredAt": 1788134400000
}
```

`event` is one of `wake`, `ready`, `decode`, `reveal`, `author`, `post`, `invite`, or `mail`. A new event and an
identical replay both return `202 { "ok": true }`. Reusing an event ID with a different event, scene, or timestamp
returns `409`. Other stable failures are `400`, `401`, `413`, `415`, `429` (with `Retry-After: 60`), and sanitized
`503`.

The transaction validates the current scene row, atomically consumes the actor's minute bucket, inserts one receipt,
and increments exactly one UTC-day counter. Identical retries consume rate capacity but never increment the aggregate
twice. Any aggregate failure rolls back the receipt and rate mutation together.

### Aggregate export

`GET /v1/analytics/funnel/{fromDay}/{toDay}` requires a direct wallet signature and an `analyst` or `moderator` row
in `actor_roles`. Both path dates must be canonical `YYYY-MM-DD`, inclusive, ordered, and no more than 31 days apart.
Scene-signed callers, unlisted wallets, and `trusted-creator` alone are denied.

The response contains only configured-scene rows from `daily_funnel_aggregates`, ordered by day and scene. PostgreSQL
`bigint` counters remain exact decimal strings rather than unsafe JavaScript numbers. Authenticated export responses
are marked `Cache-Control: no-store`. Export requests have an atomic hourly actor limit and return `429` with
`Retry-After: 3600` when full.

## Configuration

Required environment variables:

- `DATABASE_URL`
- `ALLOWED_SCENE_IDS` — comma-separated, trimmed, unique identifiers, each at most 128 UTF-8 bytes
- `TRUSTED_CATALYST_URL` — a credential-free HTTPS origin, canonicalized and bounded to 2,048 UTF-8 bytes
- `ACTOR_DIGEST_KEY` — at least 32 UTF-8 bytes; retained only inside the actor-digest closure

Optional settings and defaults:

| Variable | Default | Bound |
| --- | ---: | ---: |
| `HTTP_SERVER_HOST` | `127.0.0.1` | hostname or IP, at most 253 characters |
| `HTTP_SERVER_PORT` | `3100` | 1–65535 |
| `ANALYTICS_RETENTION_DAYS` | `31` | 1–366 |
| `RATE_ANALYTICS_WALLET_PER_MINUTE` | `120` | 1–100000 |
| `RATE_ANALYTICS_GUEST_PER_MINUTE` | `30` | 1–100000 |
| `RATE_REPORT_WALLET_PER_HOUR` | `5` | 1–100000 |
| `RATE_REPORT_GUEST_PER_HOUR` | `2` | 1–100000 |
| `RATE_PUBLISH_PER_HOUR` | `10` | 1–100000 |
| `RATE_DECISION_PER_MINUTE` | `60` | 1–100000 |
| `RATE_EXPORT_PER_HOUR` | `6` | 1–100000 |

No secret file is included. Every actor digest uses a fixed purpose domain, and Ethereum addresses are canonicalized
before hashing so casing cannot split one actor into multiple buckets. `ANALYTICS_RETENTION_DAYS` currently defines
which inbound UTC event days are accepted; automated receipt/rate-row pruning is a separate operational task and is
not claimed here.

Connections to the configured Catalyst for contract-wallet signature verification are limited to eight concurrent
requests, a three-second full-response deadline, and a 16 KiB response body. Excess work fails closed as `503`.

Configured scenes are upserted at startup without deleting historical allowlist rows. The service applies the
rerunnable `migrations/001_initial.sql` behind a session advisory lock before it starts listening. PostgreSQL
connections have a five-second acquisition timeout, and shutdown closes the HTTP listener before the pool.

## Build and verification

From this directory:

```text
npm ci
npm test
npm run check
npm run build
npm start
```

`npm run check` strictly type-checks source and tests. `npm run build` emits the runnable service to `dist/`, and
`npm start` runs that build after the required environment and PostgreSQL are available.

The PostgreSQL tests create isolated random schemas and cover rerunnable migrations, allowlist seeding, UTC grouping,
all eight counters, duplicates and conflicts, rollback/retry, role authorization, exact bigint export, and concurrent
rate/idempotency behavior. They execute only when `TEST_DATABASE_URL` is explicitly supplied; otherwise Vitest marks
them skipped. CI supplies PostgreSQL 17 and Node 22. A local skip is never reported as PostgreSQL execution.

Per-actor database limits do not stop wallet rotation. A production deployment still needs bounded proxy/IP and
global request limits, a per-scene ceiling, expired-row maintenance, production scene IDs, and owner-approved VPS/TLS
configuration.
