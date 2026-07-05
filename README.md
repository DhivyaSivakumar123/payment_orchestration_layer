# Payment Orchestrator — Project Skeleton

NestJS + PostgreSQL + Redis skeleton for the payment orchestration layer.
See `payment-orchestration-architecture.md` for the full system design.

## What's here

- **DB schema / migration** (`src/database/migrations/1751600000000-InitSchema.ts`)
  creates `transactions`, `audit_log`, `webhook_events`, `gateway_stats`,
  with the enums for transaction state, gateway provider, and circuit state.
- **Entities** matching the schema, under `transactions/`, `webhooks/`, `gateways/`.
- **Transactions module** — `POST /payments` creates a transaction (idempotency-key
  aware), `GET /payments/:id` and `GET /payments/:id/history` (audit trail).
- **Webhooks module** — `POST /webhooks/stripe` and `POST /webhooks/razorpay`,
  with dedup enforced by a unique DB index on `(gateway, event_id)`.
- **Health check** — `GET /health`.

## What's *not* here yet (next milestones)

1. Idempotency guard via Redis (currently only checked at the DB level).
2. The state machine service enforcing `VALID_TRANSITIONS` on every write.
3. Gateway adapters (Stripe/Razorpay/PayU) implementing a common interface.
4. Routing engine + circuit breaker + precomputed fallback list.
5. Webhook signature verification (Stripe/Razorpay HMAC).
6. Queue-based reconciler worker (currently webhooks are just stored, not processed).

## Running locally

```bash
cp .env.example .env          # fill in Stripe/Razorpay test keys
docker compose up -d          # starts Postgres + Redis
npm install
npm run migration:run         # creates tables
npm run start:dev             # http://localhost:3000
```

Test it:
```bash
curl -X POST localhost:3000/payments \
  -H "Content-Type: application/json" \
  -d '{"idempotencyKey":"order-1","merchantId":"merchant-1","amount":50000,"currency":"INR"}'

curl localhost:3000/payments/<id>
curl localhost:3000/payments/<id>/history
```

Simulate a Stripe webhook (once you have Stripe CLI + test keys):
```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
stripe trigger payment_intent.succeeded
```
