# Ghostlight API foundation

This directory is an isolated Node 22 foundation for the future Ghostlight network API. It currently implements
only:

- strict startup configuration parsing and purpose-separated privacy-preserving actor digests;
- SDK-free analytics and moderation request contracts;
- the transaction-safe, rerunnable PostgreSQL initial schema in `migrations/001_initial.sql`;
- focused tests for configuration, request boundaries, and schema invariants.

It does not contain an HTTP runtime, route handlers, a migration runner, cross-World synchronization, or a deployed
service. It has not been proven interoperable with Decentraland clients.

## Configuration

Required environment variables:

- `DATABASE_URL`
- `ALLOWED_SCENE_IDS` — comma-separated, trimmed, unique identifiers, each at most 128 UTF-8 bytes
- `TRUSTED_CATALYST_URL` — a credential-free HTTPS origin, canonicalized and bounded to 2048 UTF-8 bytes
- `ACTOR_DIGEST_KEY` — at least 32 UTF-8 bytes; retained only inside the actor-digest closure

Optional settings and defaults:

| Variable                           |     Default |                                  Bound |
| ---------------------------------- | ----------: | -------------------------------------: |
| `HTTP_SERVER_HOST`                 | `127.0.0.1` | hostname or IP, at most 253 characters |
| `HTTP_SERVER_PORT`                 |      `3100` |                                1–65535 |
| `ANALYTICS_RETENTION_DAYS`         |        `31` |                                  1–366 |
| `RATE_ANALYTICS_WALLET_PER_MINUTE` |       `120` |                               1–100000 |
| `RATE_ANALYTICS_GUEST_PER_MINUTE`  |        `30` |                               1–100000 |
| `RATE_REPORT_WALLET_PER_HOUR`      |         `5` |                               1–100000 |
| `RATE_REPORT_GUEST_PER_HOUR`       |         `2` |                               1–100000 |
| `RATE_PUBLISH_PER_HOUR`            |        `10` |                               1–100000 |
| `RATE_DECISION_PER_MINUTE`         |        `60` |                               1–100000 |
| `RATE_EXPORT_PER_HOUR`             |         `6` |                               1–100000 |

No secret file is included. The actor digest key is never included in the parsed configuration's enumerable fields,
JSON output, or error messages. Every digest call requires a fixed purpose domain, and Ethereum-shaped actor IDs are
canonicalized before hashing so address casing cannot split one actor into multiple buckets.

## Verified future route boundary

The reviewed boundary for the later HTTP implementation is:

- public liveness and readiness;
- scene-signed analytics and moderation reports;
- wallet-signed subject publishing;
- moderator-authorized queue, decisions, and moderation export;
- analyst- or moderator-authorized aggregate-only analytics export;
- no authentication-sensitive query parameters.

Client publishing input is assigned the `untrusted` channel. A future authenticated route may derive an elevated
`curated` or `trusted` channel from verified server-side authorization, but clients cannot assert that provenance.

The schema stores privacy-safe actor digests for reports, rate buckets, and audit receipts. Campaign and source
exist only for landing-link click aggregates. In-World funnel aggregates are grouped by UTC day and allowlisted
scene, with no campaign conversion surface.

## Crypto-middleware interoperability gate

`@dcl/crypto-middleware` 6.x changed signed payload construction: metadata is no longer lowercased. Signer and
verifier must therefore upgrade together. Before any interoperability or deployment claim, the target Explorer's
actual desktop and mobile `signedFetch` payload must be verified against this pinned server stack. A
`canonicalMetadataKeys` bridge is permitted only if that live check proves it necessary. Real traffic must also
confirm scene IDs and World metadata before the production allowlist is finalized. This foundation does not invent
or include a server signer.

## Verification

From this directory:

```text
npm install
npm test
npm run build
```

Static schema tests inspect declared constraints. `test/schema.integration.test.ts` executes the migration twice in
an isolated temporary schema only when `TEST_DATABASE_URL` is explicitly supplied; otherwise Vitest reports that
test as skipped, and no PostgreSQL execution is claimed.
