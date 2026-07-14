# Payment Orchestrator

NestJS + PostgreSQL + Redis codebase for a multi-gateway payment orchestration layer routing across Stripe, Razorpay, PayU, and UPI.

See [payment-orchestration-architecture.md](../payment-orchestration-architecture.md) for the high-level system design.

---

## 1. DATABASE SCHEMA
* **Status**: **IMPLEMENTED**
* **File Paths**:
  * Schema Migration: [1751600000000-InitSchema.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/database/migrations/1751600000000-InitSchema.ts)
  * Entities:
    * [transaction.entity.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/transactions/entities/transaction.entity.ts)
    * [audit-log.entity.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/transactions/entities/audit-log.entity.ts)
    * [webhook-event.entity.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/webhooks/entities/webhook-event.entity.ts)
    * [gateway-stats.entity.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/gateways/entities/gateway-stats.entity.ts)
* **Code Details & Constraints**:
  * **Tables and Columns**:
    * `transactions`: `id` (uuid, PK), `idempotency_key` (varchar(255), not null), `merchant_id` (varchar(100), not null), `amount` (bigint, not null), `currency` (varchar(10), not null), `current_state` (enum `transactions_current_state_enum`, default `INITIATED`), `selected_gateway` (enum `gateway_provider_enum`, nullable), `gateway_txn_id` (varchar(255), nullable), `fallback_gateways` (jsonb, default `'[]'`), `attempt_count` (int, default 0), `created_at` (timestamptz), `updated_at` (timestamptz), `final_reconciled_at` (timestamptz, nullable).
    * `audit_log`: `id` (uuid, PK), `transaction_id` (uuid, not null), `from_state` (enum `transactions_current_state_enum`, nullable), `to_state` (enum `transactions_current_state_enum`, not null), `gateway` (enum `gateway_provider_enum`, nullable), `reason` (varchar(500), nullable), `raw_gateway_response` (jsonb, nullable), `created_at` (timestamptz).
    * `webhook_events`: `id` (uuid, PK), `gateway` (enum `gateway_provider_enum`, not null), `event_id` (varchar(255), not null), `event_type` (varchar(100), not null), `payload` (jsonb, not null), `signature_verified` (boolean, default false), `processed` (boolean, default false), `processed_at` (timestamptz, nullable), `received_at` (timestamptz).
    * `gateway_stats`: `gateway` (enum `gateway_provider_enum`, PK), `success_count` (int, default 0), `failure_count` (int, default 0), `avg_latency_ms` (int, default 0), `cost_bps` (int, default 0), `circuit_state` (enum `circuit_state_enum`, default `CLOSED`), `consecutive_failures` (int, default 0), `updated_at` (timestamptz).
  * **Indexes**:
    * `idx_transactions_idempotency_key` uniqueness constraint on `transactions` (`idempotency_key`) exists.
    * `idx_webhook_events_gateway_event_id` uniqueness constraint on `webhook_events` (`gateway`, `event_id`) exists.
    * `idx_audit_log_transaction_id` non-unique index on `audit_log` (`transaction_id`) exists.
  * **Migrations & Seeds**:
    * A single database migration exists. It seeds basis-point costs for: `STRIPE` (290 bps), `RAZORPAY` (200 bps), `PAYU` (190 bps), and `UPI` (50 bps).
    * Migrations run cleanly against Postgres.

---

## 2. TRANSACTION STATE MACHINE
* **Status**: **IMPLEMENTED**
* **File Paths**:
  * State Machine Service: [state-machine.service.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/transactions/state-machine.service.ts)
  * Allowed transitions list: [transaction-state.enum.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/common/enums/transaction-state.enum.ts)
* **Code Details & Constraints**:
  * **Transitions Validation**: The `StateMachineService` enforces correct lifecycle transitions by checking requests against the `VALID_TRANSITIONS` map. Row locks (`pessimistic_write`) are used in a Postgres transaction to avoid race conditions.
  * **Enforced Transitions Logic**:
    ```typescript
    export const VALID_TRANSITIONS: Record<TransactionState, TransactionState[]> = {
      [TransactionState.INITIATED]: [TransactionState.ROUTED],
      [TransactionState.ROUTED]: [TransactionState.PROCESSING],
      [TransactionState.PROCESSING]: [
        TransactionState.SUCCESS,
        TransactionState.FAILED,
        TransactionState.RETRY_PENDING,
      ],
      [TransactionState.RETRY_PENDING]: [TransactionState.ROUTED, TransactionState.FAILED],
      [TransactionState.SUCCESS]: [TransactionState.RECONCILED],
      [TransactionState.FAILED]: [],
      [TransactionState.RECONCILED]: [],
    };
    ```
  * **Backward State Movement**: In the current implementation, a transaction **cannot** move backward from terminal states (`SUCCESS`, `FAILED`, `RECONCILED`). `SUCCESS` only transitions forward to `RECONCILED`, and the allowed target state arrays for `FAILED` and `RECONCILED` are empty `[]`. Attempted invalid transitions throw a `409 BadRequestException`.

---

## 3. IDEMPOTENCY
* **Status**: **IMPLEMENTED**
* **File Paths**:
  * [transactions.service.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/transactions/transactions.service.ts)
  * [redis.service.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/redis/redis.service.ts)
* **Code Details & Constraints**:
  * **Enforcement Layer**: Double-enforced at the cache level via Redis (falling back to a local in-memory `Map` if Redis is down) and the Postgres unique index layer.
  * **Concurrent Processing Walkthrough**:
    1. **Request A** sets the Redis key `idempotency:<idempotencyKey>` using `NX` (Not Exists) flag with a 10s TTL, representing `status: 'processing'`. It proceeds to execute routing and adapter calls.
    2. **Request B** (identical request arriving milliseconds later) fails to acquire the Redis lock (`set` returns null).
    3. Request B queries the Redis cache. Because Request A is still processing, Request B parses `parsed.status === 'processing'` and throws a `409 ConflictException` ("Payment request is already processing. Please try again shortly.").
    4. Once Request A finishes execution, the cache is updated with `status: 'completed'` and the final `transaction` payload.
    5. Any subsequent requests immediately get cache hits on `status === 'completed'` and return the transaction without hitting Postgres.
  * **Known Gaps**: If the database save operation fails, the lock is deleted in the `catch` block. However, if the error is a Postgres unique constraint exception, deleting the lock is redundant since Postgres has already saved the record.

---

## 4. GATEWAY ADAPTERS
* **Status**: **PARTIAL** (Stripe & Razorpay working; PayU & UPI are mock stubs)
* **File Paths**:
  * Interface: [gateway-adapter.interface.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/gateways/interfaces/gateway-adapter.interface.ts)
  * Adapters Directory: [src/gateways/adapters/](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/gateways/adapters/)
* **Code Details & Constraints**:
  * **Stripe**: Makes real API calls (HTTP POST to `https://api.stripe.com/v1/charges` via `fetch`) using `STRIPE_SECRET_KEY`. Bypasses to Mock Mode if keys are placeholder values starting with `sk_test_xxx`. Bypassed Mock Mode simulates success (200ms delay) or timeout/decline errors when amount ends in `99` (simulates 2000ms timeout) or `00` (simulates decline).
  * **Razorpay**: Makes real API calls (creates orders via `fetch` to `https://api.razorpay.com/v1/orders`) using `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`. Falls back to Mock Mode if keys start with `rzp_test_xxx`. Bypassed Mock Mode simulates timeouts (amount ends in `96`) or customer failures (amount ends in `01`).
  * **PayU**: **MOCK STUB ONLY**. Logs mock logs and simulates timeout (ends in `97`) or bank failure (ends in `02`).
  * **UPI**: **MOCK STUB ONLY**. Logs mock logs and simulates timeout (ends in `98`/`99`) or decline (ends in `00`/`03`).
  * **Common Interface**: All adapters implement `GatewayAdapter`.

---

## 5. ROUTING ENGINE
* **Status**: **IMPLEMENTED**
* **File Paths**:
  * [routing-engine.service.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/gateways/routing-engine.service.ts)
* **Code Details & Constraints**:
  * **Scoring Formula**:
    ```typescript
    score = healthMultiplier * (wSuccess * successRate + wCost * costScore + wLatency * (latencyScore / 20))
    ```
    * `successRate` = `successCount / totalTxns` (defaults to `1.0` if attempts = 0).
    * `costScore` = `Math.max(0, (300 - costBps) / 300)` where maximum fee is normalized relative to 300 bps.
    * `latencyScore` = `1000 / Math.max(avgLatencyMs || 200, 50)`.
    * `healthMultiplier` = `0.3` if state is `HALF_OPEN`, `1.0` if `CLOSED`.
    * Dynamic weights (success/cost/latency) based on amount threshold (>5000 paise/cents):
      * High Value (>5000): success `0.7`, cost `0.1`, latency `0.2`
      * Low Value (<=5000): success `0.3`, cost `0.5`, latency `0.2`
  * **Fallback List**: Precomputed at transaction creation (ROUTED state) and saved in the `fallback_gateways` JSONB column. It is **not recomputed on failure**. The execution loop pops fallback gateways sequentially from the precomputed array.
  * **Circuit Breaker state transitions**:
    * **CLOSED to OPEN**: Trips after `consecutiveFailures >= 3`. It sets state to `OPEN` in the DB and places a Redis key `circuit:open:<gateway>` with a **30-second TTL** cooldown.
    * **OPEN to HALF_OPEN**: If a query is made and the Redis cooldown has expired, the state is lazily updated to `HALF_OPEN` (routing engine applies the `0.3` multiplier penalty).
    * **HALF_OPEN to CLOSED**: Reset occurs on the first success (resets `consecutiveFailures` to 0, deletes Redis open key, updates state to `CLOSED`).
    * **Known Bug**: Transitioning to `HALF_OPEN` does not reset the database `consecutiveFailures` counter from `3`. Hence, if the first probe transaction fails in `HALF_OPEN`, the counter increments to `4`, and the gateway immediately trips back to `OPEN` after a single failure.
  * **Failover Latency**: Enforces a **1.5s (1500ms) call timeout SLA** via `Promise.race` during execution. If the primary gateway hangs, failover is triggered and completes within **1.5s to 1.9s**, complying with the target failover SLA of <2s.

---

## 6. WEBHOOK INGESTION PIPELINE
* **Status**: **PARTIAL** (Stripe & Razorpay working; PayU & UPI webhook endpoints missing)
* **File Paths**:
  * Ingestion: [webhooks.controller.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/webhooks/webhooks.controller.ts)
  * Queue and Processing: [reconciliation-queue.service.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/webhooks/reconciliation-queue.service.ts), [reconciliation-worker.service.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/webhooks/reconciliation-worker.service.ts)
* **Code Details & Constraints**:
  * **Webhook Endpoints**: `/webhooks/stripe` and `/webhooks/razorpay` exist. PayU and UPI webhook endpoints are not defined.
  * **Signature verification**: Implemented with HMAC SHA256 (Stripe and Razorpay verification functions). Bypassed with `verified = true` if webhook secret keys in `.env` match placeholder formats (`whsec_xxx`, `rzp_test_xxx`, etc.).
  * **Deduplication**: Handled via database unique index on `(gateway, event_id)`. Duplicates throw a `23505` uniqueness violation on insert, caught in `webhooks.service.ts` to skip queue push and return `{ duplicate: true }` back to the controller, which returns `200 OK`.
  * **Async Reconciler**: Ingestion saves raw events and pushes IDs onto Redis queue `payment_orchestrator:reconciliation_queue`. A background worker (`ReconciliationWorkerService` polling via `brpop`) pulls events, extracts `gatewayTxnId`, and runs the transaction sequentially to `RECONCILED` state using the state machine.

---

## 7. AUDIT TRAIL
* **Status**: **IMPLEMENTED**
* **File Paths**:
  * Service: [state-machine.service.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/transactions/state-machine.service.ts)
  * Creation: [transactions.service.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/transactions/transactions.service.ts)
* **Code Details**:
  * Audit logs are generated on **every state transition** inside `StateMachineService.transition()` alongside database transactions updating the transaction table. An initial audit entry is written when the transaction is created (`INITIATED`).
  * **Transition Path Example (Timeout & Fallback)**:
    1. `null` -> `INITIATED` (Gateway: `UPI`, Reason: `"transaction created"`)
    2. `INITIATED` -> `ROUTED` (Gateway: `UPI`, Reason: `"Gateway UPI selected for attempt"`)
    3. `ROUTED` -> `PROCESSING` (Gateway: `UPI`, Reason: `"Initiating API call to UPI"`, `attemptCount`: 1)
    4. `PROCESSING` -> `RETRY_PENDING` (Gateway: `UPI`, Reason: `"Attempt failed on UPI: Gateway call timed out"`)
    5. `RETRY_PENDING` -> `ROUTED` (Gateway: `RAZORPAY`, Reason: `"Gateway RAZORPAY selected for attempt"`)
    6. `ROUTED` -> `PROCESSING` (Gateway: `RAZORPAY`, Reason: `"Initiating API call to RAZORPAY"`, `attemptCount`: 2)
    7. `PROCESSING` -> `SUCCESS` (Gateway: `RAZORPAY`, Reason: `"Payment charge succeeded"`)
    8. `SUCCESS` -> `RECONCILED` (Gateway: `RAZORPAY`, Reason: `"Webhook reconciliation completed"`, async worker)

---

## 8. TESTS
* **Status**: **IMPLEMENTED** (with a critical configuration bug in the runner)
* **File Paths**:
  * [idempotency.spec.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/transactions/idempotency.spec.ts)
  * [state-machine.service.spec.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/transactions/state-machine.service.spec.ts)
  * [execution.spec.ts](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/src/transactions/execution.spec.ts)
* **Test Details & Coverage Gaps**:
  * **Test Coverage**:
    * `idempotency.spec.ts`: Covers Redis idempotency caching and fallback in-memory states (5 tests).
    * `state-machine.service.spec.ts`: Covers state transitions, validation checks, and attempt increments (4 tests).
    * `execution.spec.ts`: Covers routing scoring, retry loops, timeout races, circuit breakers, and webhook reconciliation worker execution using mock stores (6 tests).
  * **Runner Configuration Bug**:
    * Running `npm run test` fails on `test:execution` because the routing engine filters out gateways when env variables are not found in `process.env`.
    * To run tests successfully, `NODE_ENV=test` must be set in the shell:
      ```powershell
      $env:NODE_ENV="test"; npm run test
      ```
  * **Not Covered**: Real Postgres schema migration verification, actual Redis driver connections, webhook API controllers, and signature check validations.

---

## 9. RUNNABILITY
* **Status**: **PARTIAL**
* **File Paths**:
  * [docker-compose.yml](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/docker-compose.yml)
  * [.env](file:///c:/Users/Dhivya%20Sivakumar/Desktop/payment/payment-orchestrator/.env)
* **Code Details & Gaps**:
  * **Local vs Cloud Config**: `docker-compose.yml` launches local containers for Postgres and Redis. However, the default `.env` is configured with Neon Postgres and Redis Cloud connections. Running `npm run start:dev` will ignore local Docker containers and connect to these cloud instances unless `.env` is updated to point to `localhost`.
  * **Undocumented Steps**:
    1. **TypeScript Paths**: `ts-node-dev` and `ts-node` must be present (or run with `npx`).
    2. **pgcrypto Extension**: Superuser database permissions are required to run migrations that register the `pgcrypto` extension.
    3. **Redis URI Parsing**: The `RedisService` parses `REDIS_HOST` as host option instead of full URI, which can fail if `redis://` urls are passed in the configuration block.

---

## 10. GAPS AGAINST THE ORIGINAL SPEC
* **Gaps**:
  * **Stubs for PayU and UPI**: No actual sandboxes/test endpoints are called for PayU and UPI (mocked response delays only).
  * **PayU & UPI webhook endpoints**: Not implemented.
  * **Webhook Signature Bypass**: Enabled automatically when secrets contain `whsec_xxx` / `rzp_test_xxx` mock credentials.
  * **Outdated Readme Documentation**: The previous version of this document incorrectly listed routing, state machines, reconcilers, and signature verification as missing milestones when they are fully implemented.

---

## Running locally

```bash
cp .env.example .env          # fill in Stripe/Razorpay test keys
docker compose up -d          # starts local Postgres + Redis
# Note: update .env DB_HOST and REDIS_HOST to localhost to use these containers
npm install
npm run migration:run         # creates tables
npm run start:dev             # http://localhost:3000
```

## Running tests

```powershell
# Set NODE_ENV to test to bypass API config validation filters in routing engine
$env:NODE_ENV="test"
npm run test
```

## Manual verification curl requests

Create a transaction:
```bash
curl -X POST localhost:3000/payments \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: custom-key-123" \
  -d '{"merchantId":"merchant-1","amount":50000,"currency":"INR"}'
```

Check payment status and history:
```bash
curl localhost:3000/payments/<transaction_id>
curl localhost:3000/payments/<transaction_id>/history
```
