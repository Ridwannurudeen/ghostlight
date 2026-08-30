# Ghostlight API

This directory contains the executable Node 22 service for Ghostlight's first network verticals: privacy-bounded
funnel analytics and persistent moderation staging. It currently provides:

- advisory-lock-protected PostgreSQL startup migration and configured-scene seeding;
- a scene-signed, body-bound funnel ingestion endpoint with atomic rate limiting and idempotency;
- an analyst/moderator-only aggregate export endpoint that never exposes receipts, addresses, or actor digests;
- direct-wallet, body-bound publishing into an isolated `untrusted` channel;
- scene-shaped wallet-signed reporting plus a direct-wallet moderator queue and one-way moderation decisions;
- public liveness and database-backed readiness probes;
- JSON application logs, graceful lifecycle shutdown, strict type-checking, an emitted runtime build, and focused
  unit and PostgreSQL integration tests.

It does not yet provide shared-pool reads, positive approval or channel elevation, season synchronization, Creator
Studio, or Touring Kit. It is not deployed, and real desktop/mobile Explorer interoperability has not been proven.

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

Moderation publishing uses a direct wallet signature with exact `{ "sceneId", "hashPayload" }` metadata. Reports
use the exact scene-shaped metadata above, with the same limitation: it proves wallet control but not that the caller
was running inside Explorer. Queue reads require a direct wallet signature with empty metadata; decisions use exact
`{ "hashPayload" }` metadata. The publish, report, and decision hashes bind the lowercase SHA-256 of the exact raw
request body. All authenticated analytics and moderation responses, including auth failures, are marked
`Cache-Control: no-store`.

Every HTTP publish is staged as `channel = 'untrusted'`. The repository's eligibility check accepts only `curated`
or `trusted` content, so an HTTP submission cannot enter a shared pool. There is deliberately no approval or channel
promotion endpoint in this slice; role provisioning and any future positive review workflow remain out-of-band.

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

### Untrusted publishing

`POST /v1/moderation/subjects` accepts a direct-wallet-signed body such as:

```json
{
  "id": "subject_0123456789abcdef",
  "content": "A canonical phrase identifier",
  "touringConsent": true,
  "createdAt": 1788134400000
}
```

`touringConsent` is optional and defaults to `false`. Clients cannot supply a channel; the server always assigns
`untrusted`. Content and IDs are trimmed, bounded by UTF-8 bytes, and reject NUL characters. A global hashed
fingerprint detects Unicode/case/separator-equivalent live content across scenes without storing a second plaintext
copy. Identical retries return `202`; conflicting IDs and duplicate live content return `409`. Tombstoning releases
the fingerprint for a later genuine republication. Publishing has an atomic hourly wallet limit.

### Reporting

`POST /v1/moderation/reports` accepts a body bound to exact scene-shaped wallet-signed metadata:

```json
{
  "id": "report_0123456789abcdef",
  "contentId": "subject_0123456789abcdef",
  "reason": "abuse",
  "createdAt": 1788134400000,
  "status": "open"
}
```

`reason` is one of `unsafe-name`, `duplicate`, `abuse`, `copyright`, or `other`; `status` may be omitted and always
becomes `open`. Wallet and guest reporters have separate atomic hourly limits. The database stores a keyed,
report-local digest scoped to reporter, subject, and reason, never the reporter's raw address. Replays and semantic
duplicates return `202` without creating another queue row. Missing, quarantined, tombstoned, or actively hidden
subjects return the same `404` response.

### Moderator queue and decisions

`GET /v1/moderation/queue` requires a direct wallet with a `moderator` row in `actor_roles`. It returns at most 50
open reports, oldest first, with subject context but no reporter address or digest. Reports for actively hidden
authors are suppressed defensively.

`POST /v1/moderation/decisions` requires the same role and a body such as:

```json
{
  "id": "decision_0123456789abcdef",
  "subjectId": "subject_0123456789abcdef",
  "action": "quarantined",
  "reason": "Verified policy violation",
  "createdAt": 1788134400000
}
```

`action` is `quarantined`, `shadow-hidden`, or `tombstoned`. Decisions are idempotent and monotonic: quarantine and
tombstone change subject availability, while shadow-hide suppresses every subject by the author and resolves all of
that author's open reports in one serialized transaction. The client timestamp is accepted only from five minutes
in the past through one minute in the future; ordering and stored timestamps use server receipt time.

The current workflow is intentionally one-way. It has no report dismissal, unquarantine, audited shadow-hide lift,
or positive approval operation. A reporter also cannot repeat the same subject/reason report after it has been
resolved. Tombstones retain evidence, including subject content and author address; true personal-data erasure needs
a separately designed retention migration. Moderator and analyst roles must be provisioned out-of-band before use.

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
all eight counters, analytics and moderation replay/conflict behavior, privacy, role authorization, exact bigint
export, rollback/retry, concurrent rate limits, decision monotonicity, and report races against shadow-hide and
tombstone transitions. They execute only when `TEST_DATABASE_URL` is explicitly supplied; otherwise Vitest marks them
skipped. CI supplies PostgreSQL 17 and Node 22. A local skip is never reported as PostgreSQL execution.

Per-actor database limits do not stop wallet rotation or prove Explorer provenance. Before exposing reporting, a
production deployment needs bounded proxy/IP and global request limits plus a per-scene ceiling. It also still needs
expired-row maintenance, production scene IDs, and owner-approved VPS/TLS configuration.
