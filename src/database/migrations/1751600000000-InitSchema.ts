import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSchema1751600000000 implements MigrationInterface {
  name = 'InitSchema1751600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TYPE "transactions_current_state_enum" AS ENUM (
        'INITIATED','ROUTED','PROCESSING','RETRY_PENDING','SUCCESS','FAILED','RECONCILED'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "gateway_provider_enum" AS ENUM ('STRIPE','RAZORPAY','PAYU','UPI')
    `);
    await queryRunner.query(`
      CREATE TYPE "circuit_state_enum" AS ENUM ('CLOSED','OPEN','HALF_OPEN')
    `);

    await queryRunner.query(`
      CREATE TABLE "transactions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "idempotency_key" varchar(255) NOT NULL,
        "merchant_id" varchar(100) NOT NULL,
        "amount" bigint NOT NULL,
        "currency" varchar(10) NOT NULL,
        "current_state" transactions_current_state_enum NOT NULL DEFAULT 'INITIATED',
        "selected_gateway" gateway_provider_enum,
        "gateway_txn_id" varchar(255),
        "fallback_gateways" jsonb NOT NULL DEFAULT '[]',
        "attempt_count" int NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "final_reconciled_at" timestamptz
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_transactions_idempotency_key" ON "transactions" ("idempotency_key")`,
    );

    await queryRunner.query(`
      CREATE TABLE "audit_log" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "transaction_id" uuid NOT NULL,
        "from_state" transactions_current_state_enum,
        "to_state" transactions_current_state_enum NOT NULL,
        "gateway" gateway_provider_enum,
        "reason" varchar(500),
        "raw_gateway_response" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_audit_log_transaction_id" ON "audit_log" ("transaction_id")`);

    await queryRunner.query(`
      CREATE TABLE "webhook_events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "gateway" gateway_provider_enum NOT NULL,
        "event_id" varchar(255) NOT NULL,
        "event_type" varchar(100) NOT NULL,
        "payload" jsonb NOT NULL,
        "signature_verified" boolean NOT NULL DEFAULT false,
        "processed" boolean NOT NULL DEFAULT false,
        "processed_at" timestamptz,
        "received_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_webhook_events_gateway_event_id" ON "webhook_events" ("gateway", "event_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "gateway_stats" (
        "gateway" gateway_provider_enum PRIMARY KEY,
        "success_count" int NOT NULL DEFAULT 0,
        "failure_count" int NOT NULL DEFAULT 0,
        "avg_latency_ms" int NOT NULL DEFAULT 0,
        "cost_bps" int NOT NULL DEFAULT 0,
        "circuit_state" circuit_state_enum NOT NULL DEFAULT 'CLOSED',
        "consecutive_failures" int NOT NULL DEFAULT 0,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Seed the 4 gateways so the routing engine has rows to update from day one.
    await queryRunner.query(`
      INSERT INTO "gateway_stats" ("gateway", "cost_bps") VALUES
        ('STRIPE', 290),
        ('RAZORPAY', 200),
        ('PAYU', 190),
        ('UPI', 50)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "gateway_stats"`);
    await queryRunner.query(`DROP TABLE "webhook_events"`);
    await queryRunner.query(`DROP TABLE "audit_log"`);
    await queryRunner.query(`DROP TABLE "transactions"`);
    await queryRunner.query(`DROP TYPE "circuit_state_enum"`);
    await queryRunner.query(`DROP TYPE "gateway_provider_enum"`);
    await queryRunner.query(`DROP TYPE "transactions_current_state_enum"`);
  }
}
