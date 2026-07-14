import { TransactionsService } from './transactions.service';
import { StateMachineService } from './state-machine.service';
import { RoutingEngineService } from '../gateways/routing-engine.service';
import { StripeAdapter } from '../gateways/adapters/stripe.adapter';
import { RazorpayAdapter } from '../gateways/adapters/razorpay.adapter';
import { PayUAdapter } from '../gateways/adapters/payu.adapter';
import { UpiAdapter } from '../gateways/adapters/upi.adapter';
import { ReconciliationQueueService } from '../webhooks/reconciliation-queue.service';
import { ReconciliationWorkerService } from '../webhooks/reconciliation-worker.service';
import { TransactionState, GatewayProvider, CircuitState } from '../common/enums/transaction-state.enum';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import * as assert from 'assert';

function createExecutionMocks() {
  const dbTransactions = new Map<string, any>();
  const dbAuditLogs: any[] = [];
  const dbWebhookEvents = new Map<string, any>();
  const redisStore = new Map<string, string>();
  
  // Seed gateway stats
  const dbGatewayStats = new Map<GatewayProvider, any>([
    [GatewayProvider.STRIPE, { gateway: GatewayProvider.STRIPE, successCount: 5, failureCount: 1, avgLatencyMs: 250, costBps: 290, circuitState: CircuitState.CLOSED, consecutiveFailures: 0 }],
    [GatewayProvider.RAZORPAY, { gateway: GatewayProvider.RAZORPAY, successCount: 10, failureCount: 1, avgLatencyMs: 200, costBps: 200, circuitState: CircuitState.CLOSED, consecutiveFailures: 0 }],
    [GatewayProvider.PAYU, { gateway: GatewayProvider.PAYU, successCount: 4, failureCount: 1, avgLatencyMs: 180, costBps: 190, circuitState: CircuitState.CLOSED, consecutiveFailures: 0 }],
    [GatewayProvider.UPI, { gateway: GatewayProvider.UPI, successCount: 2, failureCount: 8, avgLatencyMs: 80, costBps: 5, circuitState: CircuitState.CLOSED, consecutiveFailures: 0 }],
  ]);

  const mockTxnRepo = {
    create: (data: any) => {
      return { id: `txn_${Math.random().toString().slice(2, 10)}`, attemptCount: 0, ...data };
    },
    save: async (entity: any) => {
      dbTransactions.set(entity.id || entity.idempotencyKey, entity);
      return entity;
    },
    findOne: async (options: any) => {
      const conditions = Array.isArray(options.where) ? options.where : [options.where];
      for (const cond of conditions) {
        if (!cond) continue;
        const id = cond.id;
        const idempotencyKey = cond.idempotencyKey;
        const gatewayTxnId = cond.gatewayTxnId;

        if (id) {
          const txn = dbTransactions.get(id);
          if (txn) return txn;
        }
        for (const txn of dbTransactions.values()) {
          if (idempotencyKey && txn.idempotencyKey === idempotencyKey) return txn;
          if (gatewayTxnId && txn.gatewayTxnId === gatewayTxnId) return txn;
        }
      }
      return null;
    },
  };

  const mockAuditRepo = {
    create: (data: any) => data,
    save: async (entity: any) => {
      dbAuditLogs.push(entity);
      return entity;
    },
  };

  const mockStatsRepo = {
    find: async () => Array.from(dbGatewayStats.values()),
    findOne: async (options: any) => dbGatewayStats.get(options.where.gateway) || null,
    save: async (entity: any) => {
      dbGatewayStats.set(entity.gateway, entity);
      return entity;
    },
  };

  const mockWebhookRepo = {
    create: (data: any) => {
      return { id: `evt_${Math.random().toString().slice(2, 10)}`, processed: false, ...data };
    },
    save: async (entity: any) => {
      dbWebhookEvents.set(entity.id || entity.eventId, entity);
      return entity;
    },
    findOne: async (options: any) => {
      const id = options.where?.id;
      return dbWebhookEvents.get(id) || null;
    },
  };

  const mockRedisService = {
    get: async (key: string) => redisStore.get(key) || null,
    set: async (key: string, value: string, mode?: string, durMode?: string, dur?: number) => {
      if (mode === 'NX' && redisStore.has(key)) {
        return null;
      }
      redisStore.set(key, value);
      return 'OK';
    },
    del: async (key: string) => {
      redisStore.delete(key);
      return 1;
    },
    getClient: () => {
      return {
        lpush: async (queue: string, item: string) => {
          redisStore.set(queue, item); // basic representation
          return 1;
        },
        brpop: async (queue: string, timeout: number) => {
          const item = redisStore.get(queue);
          if (item) {
            redisStore.delete(queue);
            return [queue, item];
          }
          return null;
        },
      } as any;
    },
  };

  const mockConfigService = {
    get: (key: string) => {
      if (key === 'STRIPE_SECRET_KEY') return 'sk_test_mock';
      if (key === 'RAZORPAY_KEY_ID') return 'rzp_test_mock';
      return null;
    },
  };

  // Instantiate services
  const stateMachine = new StateMachineService({
    createQueryBuilder: () => {
      let targetTxn: any;
      const builder = {
        setLock: () => builder,
        where: (query: string, params: any) => {
          targetTxn = dbTransactions.get(params.id);
          return builder;
        },
        getOne: async () => targetTxn,
      };
      return builder;
    },
    transaction: async (cb: any) => {
      const manager = {
        createQueryBuilder: () => {
          let targetTxn: any;
          const builder = {
            setLock: () => builder,
            where: (query: string, params: any) => {
              targetTxn = dbTransactions.get(params.id);
              return builder;
            },
            getOne: async () => targetTxn,
          };
          return builder;
        },
        save: async (entity: any) => {
          if (entity.idempotencyKey) {
            dbTransactions.set(entity.id, entity);
          } else {
            dbAuditLogs.push(entity);
          }
          return entity;
        },
        create: (cls: any, data: any) => data,
      };
      return cb(manager);
    },
  } as any);

  const routingEngine = new RoutingEngineService(mockStatsRepo as any, mockRedisService as any);
  const stripeAdapter = new StripeAdapter(mockConfigService as any);
  const razorpayAdapter = new RazorpayAdapter(mockConfigService as any);
  const payuAdapter = new PayUAdapter();
  const upiAdapter = new UpiAdapter();

  const transactionsService = new TransactionsService(
    mockTxnRepo as any,
    mockAuditRepo as any,
    stateMachine,
    mockRedisService as any,
    routingEngine,
    stripeAdapter,
    razorpayAdapter,
    payuAdapter,
    upiAdapter,
  );

  const queueService = new ReconciliationQueueService(mockRedisService as any);
  const workerService = new ReconciliationWorkerService(
    mockWebhookRepo as any,
    mockTxnRepo as any,
    stateMachine,
    mockRedisService as any,
  );

  return {
    transactionsService,
    routingEngine,
    queueService,
    workerService,
    dbGatewayStats,
    dbTransactions,
    dbAuditLogs,
    dbWebhookEvents,
    redisStore,
  };
}

async function runTests() {
  console.log('Running Payment Orchestrator Integration & Execution tests...');

  // Test 1: Dynamic Scoring & Routing Priorities
  {
    const { routingEngine } = createExecutionMocks();

    // Low amount (<= 5000) should prioritize UPI (lowest cost = 5 bps)
    const lowAmountRankings = await routingEngine.getRankedGateways(1000);
    assert.strictEqual(lowAmountRankings[0], GatewayProvider.UPI);

    // High amount (> 5000) should prioritize Razorpay/Stripe (highest success rates)
    // Stripe cost: 290, Razorpay cost: 200. Razorpay has higher success rate and lower cost than Stripe.
    const highAmountRankings = await routingEngine.getRankedGateways(10000);
    assert.strictEqual(highAmountRankings[0], GatewayProvider.RAZORPAY);

    console.log('✔ Test 1: Dynamic Scoring & Routing Priorities passed');
  }

  // Test 2: Successful Execution (Amount 1015 - no timeout, no failures)
  {
    const { transactionsService, dbTransactions, dbAuditLogs } = createExecutionMocks();

    const dto: CreateTransactionDto = {
      idempotencyKey: 'key-success-1',
      merchantId: 'merch-1',
      amount: 1015,
      currency: 'USD',
    };

    const txn = await transactionsService.create(dto);

    assert.strictEqual(txn.currentState, TransactionState.SUCCESS);
    assert.ok(txn.gatewayTxnId);
    
    // Verify Audit Log has path: INITIATED -> ROUTED -> PROCESSING -> SUCCESS
    const txnAudits = dbAuditLogs.filter(a => a.transactionId === txn.id);
    assert.strictEqual(txnAudits[0].toState, TransactionState.INITIATED);
    assert.strictEqual(txnAudits[1].toState, TransactionState.ROUTED);
    assert.strictEqual(txnAudits[2].toState, TransactionState.PROCESSING);
    assert.strictEqual(txnAudits[3].toState, TransactionState.SUCCESS);

    console.log('✔ Test 2: Successful execution path passed');
  }

  // Test 3: Hard Failure & Failover Execution (Amount 1000 ends in '00' causing primary selection fail)
  {
    const { transactionsService, dbTransactions, dbAuditLogs } = createExecutionMocks();

    const dto: CreateTransactionDto = {
      idempotencyKey: 'key-failover-1',
      merchantId: 'merch-1',
      amount: 1000, // Ends in '00' -> primary (UPI for low amount) will fail
      currency: 'INR',
    };

    const txn = await transactionsService.create(dto);

    // UPI failed, fallback was Razorpay which succeeds
    assert.strictEqual(txn.currentState, TransactionState.SUCCESS);
    assert.strictEqual(txn.selectedGateway, GatewayProvider.RAZORPAY); // Razorpay captures it
    
    const txnAudits = dbAuditLogs.filter(a => a.transactionId === txn.id);
    const states = txnAudits.map(a => a.toState);
    
    // Expected sequence containing retry/failover states:
    // INITIATED -> ROUTED (UPI) -> PROCESSING (UPI) -> RETRY_PENDING -> ROUTED (Razorpay) -> PROCESSING (Razorpay) -> SUCCESS
    assert.ok(states.includes(TransactionState.RETRY_PENDING));
    assert.ok(states.includes(TransactionState.SUCCESS));

    console.log('✔ Test 3: Failover sequence passed');
  }

  // Test 4: Gateway Timeout Failover (Amount 1099 ends in '99' triggering 2s delay)
  {
    const { transactionsService, dbAuditLogs } = createExecutionMocks();

    const dto: CreateTransactionDto = {
      idempotencyKey: 'key-timeout-1',
      merchantId: 'merch-1',
      amount: 1099, // Ends in 99 -> timeout
      currency: 'USD',
    };

    const startTime = Date.now();
    const txn = await transactionsService.create(dto);
    const duration = Date.now() - startTime;

    // Timeout race triggers failover to Razorpay
    assert.strictEqual(txn.currentState, TransactionState.SUCCESS);
    assert.strictEqual(txn.selectedGateway, GatewayProvider.RAZORPAY);
    assert.ok(duration >= 1400 && duration < 2400, `Failover took too long: ${duration}ms`);

    console.log('✔ Test 4: Timeout SLA race and failover passed');
  }

  // Test 5: Circuit Breaker Tripping and Reset Cooldown
  {
    const { transactionsService, routingEngine, dbGatewayStats, redisStore } = createExecutionMocks();

    // Trigger 3 consecutive failures on Stripe (Stripe needs to be primary, let's rank Stripe first)
    // We can simulate Stripe failing 3 times by sending 3 payments of 1000 ending in '00'
    // To make sure Stripe is selected primary, we can temporarily set other gateway costs extremely high
    const stripeStats = dbGatewayStats.get(GatewayProvider.STRIPE);
    const upiStats = dbGatewayStats.get(GatewayProvider.UPI);
    upiStats.circuitState = CircuitState.OPEN;
    dbGatewayStats.get(GatewayProvider.RAZORPAY).circuitState = CircuitState.OPEN;
    dbGatewayStats.get(GatewayProvider.PAYU).circuitState = CircuitState.OPEN;
    
    redisStore.set(`circuit:open:${GatewayProvider.UPI}`, 'open');
    redisStore.set(`circuit:open:${GatewayProvider.RAZORPAY}`, 'open');
    redisStore.set(`circuit:open:${GatewayProvider.PAYU}`, 'open');

    // First attempt: Stripe fails
    await transactionsService.create({ idempotencyKey: 'cb-1', merchantId: 'm', amount: 1000, currency: 'USD' });
    assert.strictEqual(stripeStats.consecutiveFailures, 1);

    // Second attempt: Stripe fails
    await transactionsService.create({ idempotencyKey: 'cb-2', merchantId: 'm', amount: 2000, currency: 'USD' });
    assert.strictEqual(stripeStats.consecutiveFailures, 2);

    // Third attempt: Stripe fails -> Trips to OPEN
    await transactionsService.create({ idempotencyKey: 'cb-3', merchantId: 'm', amount: 3000, currency: 'USD' });
    assert.strictEqual(stripeStats.consecutiveFailures, 3);
    assert.strictEqual(stripeStats.circuitState, CircuitState.OPEN);
    assert.ok(redisStore.has(`circuit:open:${GatewayProvider.STRIPE}`));

    // Next ranked gateways call will exclude Stripe
    upiStats.circuitState = CircuitState.CLOSED; // restore UPI
    const activeGateways = await routingEngine.getRankedGateways(100);
    assert.ok(!activeGateways.includes(GatewayProvider.STRIPE));

    // Simulate cooldown timer expiration
    redisStore.delete(`circuit:open:${GatewayProvider.STRIPE}`);

    // Next ranked call will move Stripe to HALF_OPEN
    const recheckedGateways = await routingEngine.getRankedGateways(100);
    assert.ok(recheckedGateways.includes(GatewayProvider.STRIPE));
    assert.strictEqual(stripeStats.circuitState, CircuitState.HALF_OPEN);
    
    // TASK 1 Verification: confirm consecutiveFailures was reset to 0
    assert.strictEqual(stripeStats.consecutiveFailures, 0);

    // Send one failing probe transaction to Stripe (amount ends in '00') while in HALF_OPEN
    // Stripe should fail, incrementing consecutiveFailures to 1, and NOT re-tripping to OPEN
    upiStats.circuitState = CircuitState.OPEN; // keep UPI out of contention
    redisStore.set(`circuit:open:${GatewayProvider.UPI}`, 'open');

    await transactionsService.create({ idempotencyKey: 'cb-probe-fail', merchantId: 'm', amount: 4000, currency: 'USD' });
    
    // Check Stripe consecutiveFailures is now 1 (not 4) and circuitState is still HALF_OPEN (not OPEN)
    assert.strictEqual(stripeStats.consecutiveFailures, 1);
    assert.strictEqual(stripeStats.circuitState, CircuitState.HALF_OPEN);
    
    // Now send 2 more failures to trip it back to OPEN
    await transactionsService.create({ idempotencyKey: 'cb-probe-fail-2', merchantId: 'm', amount: 5000, currency: 'USD' });
    assert.strictEqual(stripeStats.consecutiveFailures, 2);
    await transactionsService.create({ idempotencyKey: 'cb-probe-fail-3', merchantId: 'm', amount: 6000, currency: 'USD' });
    assert.strictEqual(stripeStats.consecutiveFailures, 3);
    assert.strictEqual(stripeStats.circuitState, CircuitState.OPEN);

    console.log('✔ Test 5: Circuit Breaker trip and lazy recovery passed (including HALF_OPEN stale counter reset verification)');
  }

  // Test 6: Asynchronous Webhook Reconciliation
  {
    const { workerService, queueService, dbTransactions, dbWebhookEvents } = createExecutionMocks();

    // 1. Create a transaction that is SUCCESS (e.g. from the sync path)
    const transactionId = 'txn_webhook_recon';
    const gatewayTxnId = 'ch_stripe_recon_123';
    dbTransactions.set(transactionId, {
      id: transactionId,
      idempotencyKey: 'idemp-recon',
      merchantId: 'merch-1',
      amount: 1500,
      currency: 'USD',
      currentState: TransactionState.SUCCESS,
      selectedGateway: GatewayProvider.STRIPE,
      gatewayTxnId: gatewayTxnId,
      attemptCount: 1,
    });

    // 2. Ingest webhook event
    const webhookEventId = 'evt_stripe_recon_123';
    const payload = {
      id: webhookEventId,
      type: 'charge.succeeded',
      data: {
        object: {
          id: gatewayTxnId,
          amount: 1500,
        }
      }
    };

    dbWebhookEvents.set(webhookEventId, {
      id: webhookEventId,
      gateway: GatewayProvider.STRIPE,
      eventId: 'evt_stripe_123',
      eventType: 'charge.succeeded',
      payload: payload,
      processed: false,
    });

    // 3. Process event via worker
    await (workerService as any).processEvent(webhookEventId);

    // 4. Verify transaction is now RECONCILED
    const txn = dbTransactions.get(transactionId);
    assert.strictEqual(txn.currentState, TransactionState.RECONCILED);
    
    // Verify webhook event is processed
    const event = dbWebhookEvents.get(webhookEventId);
    assert.strictEqual(event.processed, true);
    assert.ok(event.processedAt);

    console.log('✔ Test 6: Async Webhook reconciliation worker passed');
  }

  console.log('All Integration & Execution tests passed successfully!');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
