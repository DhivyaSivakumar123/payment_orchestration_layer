import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { TransactionState, GatewayProvider } from '../common/enums/transaction-state.enum';
import * as assert from 'assert';

// Mocking helper for Repository and RedisService
function createMocks() {
  const dbStore = new Map<string, any>();
  const auditStore: any[] = [];
  const redisStore = new Map<string, string>();

  const mockTxnRepo = {
    findOne: async (options: any) => {
      const key = options.where?.idempotencyKey;
      return dbStore.get(key) || null;
    },
    create: (data: any) => {
      return { id: 'generated-uuid', ...data };
    },
    save: async (entity: any) => {
      dbStore.set(entity.idempotencyKey, entity);
      return entity;
    },
  };

  const mockAuditRepo = {
    create: (data: any) => data,
    save: async (entity: any) => {
      auditStore.push(entity);
      return entity;
    },
  };

  const mockRedisService = {
    store: redisStore,
    get: async (key: string) => {
      return redisStore.get(key) || null;
    },
    set: async (
      key: string,
      value: string,
      mode?: 'NX' | 'XX',
      durationMode?: 'EX' | 'PX',
      duration?: number,
    ) => {
      if (mode === 'NX') {
        if (redisStore.has(key)) {
          return null; // lock not acquired
        }
        redisStore.set(key, value);
        return 'OK'; // lock acquired
      }
      redisStore.set(key, value);
      return 'OK';
    },
    del: async (key: string) => {
      redisStore.delete(key);
      return 1;
    },
  };

  const mockStateMachine = {
    transition: async (id: string, state: any, metadata: any) => {
      let foundTxn: any = null;
      for (const txn of dbStore.values()) {
        if (txn.id === id || txn.idempotencyKey === id || id === 'generated-uuid') {
          foundTxn = txn;
          break;
        }
      }
      if (!foundTxn && dbStore.size > 0) {
        foundTxn = Array.from(dbStore.values())[0];
      }
      if (foundTxn) {
        foundTxn.currentState = state;
        if (metadata?.gateway) foundTxn.selectedGateway = metadata.gateway;
        if (metadata?.gatewayTxnId) foundTxn.gatewayTxnId = metadata.gatewayTxnId;
        if (metadata?.incrementAttempt) foundTxn.attemptCount = (foundTxn.attemptCount || 0) + 1;
        return foundTxn;
      }
      return {
        id,
        currentState: state,
        selectedGateway: metadata?.gateway || GatewayProvider.STRIPE,
        gatewayTxnId: metadata?.gatewayTxnId || 'ch_mock',
        attemptCount: metadata?.incrementAttempt ? 1 : 0,
        idempotencyKey: 'key-1',
        merchantId: 'merchant-1',
        amount: 1000,
        currency: 'USD',
        fallbackGateways: [],
      };
    }
  } as any;

  const mockRoutingEngine = {
    getRankedGateways: async () => [GatewayProvider.STRIPE],
    recordSuccess: async () => {},
    recordFailure: async () => {},
  } as any;

  const mockStripeAdapter = {
    provider: GatewayProvider.STRIPE,
    charge: async () => ({ success: true, gatewayTxnId: 'ch_mock_123', rawResponse: {}, latencyMs: 10 }),
  } as any;

  const service = new TransactionsService(
    mockTxnRepo as any,
    mockAuditRepo as any,
    mockStateMachine,
    mockRedisService as any,
    mockRoutingEngine,
    mockStripeAdapter,
    {} as any,
    {} as any,
    {} as any,
  );

  return { service, dbStore, auditStore, redisStore, mockRedisService, mockTxnRepo };
}

async function runTests() {
  console.log('Running Redis Idempotency Guard tests...');

  // Test 1: Successful initial request (first time)
  {
    const { service, dbStore, redisStore, auditStore } = createMocks();
    const dto: CreateTransactionDto = {
      idempotencyKey: 'key-1',
      merchantId: 'merchant-1',
      amount: 1000,
      currency: 'USD',
    };

    const result = await service.create(dto);

    assert.strictEqual(result.idempotencyKey, 'key-1');
    assert.strictEqual(result.currentState, TransactionState.SUCCESS);
    
    // Assert cache is populated
    const cached = redisStore.get('idempotency:key-1');
    assert.ok(cached);
    const parsed = JSON.parse(cached);
    assert.strictEqual(parsed.status, 'completed');
    assert.strictEqual(parsed.transaction.id, 'generated-uuid');

    // Assert DB is populated
    assert.ok(dbStore.has('key-1'));

    // Assert audit log is written
    assert.strictEqual(auditStore.length, 1);
    assert.strictEqual(auditStore[0].toState, TransactionState.INITIATED);

    console.log('✔ Test 1: Initial request succeeds & caches');
  }

  // Test 2: Concurrent duplicate request while processing
  {
    const { service, redisStore } = createMocks();
    redisStore.set('idempotency:key-2', JSON.stringify({ status: 'processing' }));

    const dto: CreateTransactionDto = {
      idempotencyKey: 'key-2',
      merchantId: 'merchant-1',
      amount: 1000,
      currency: 'USD',
    };

    try {
      await service.create(dto);
      assert.fail('Should have thrown ConflictException');
    } catch (e: any) {
      assert.strictEqual(e.status, 409);
      assert.strictEqual(e.message, 'Payment request is already processing. Please try again shortly.');
      console.log('✔ Test 2: Concurrent processing request throws 409 Conflict');
    }
  }

  // Test 3: Subsequent duplicate request after completion (cache hit)
  {
    const { service, redisStore, mockTxnRepo } = createMocks();
    const mockTxn = { id: 'cached-uuid', idempotencyKey: 'key-3', currentState: TransactionState.INITIATED };
    redisStore.set('idempotency:key-3', JSON.stringify({ status: 'completed', transaction: mockTxn }));

    // Spy on DB findOne
    let dbQueryCount = 0;
    mockTxnRepo.findOne = async () => {
      dbQueryCount++;
      return null;
    };

    const dto: CreateTransactionDto = {
      idempotencyKey: 'key-3',
      merchantId: 'merchant-1',
      amount: 1000,
      currency: 'USD',
    };

    const result = await service.create(dto);

    assert.strictEqual(result.id, 'cached-uuid');
    assert.strictEqual(dbQueryCount, 0); // verifying DB was not queried
    console.log('✔ Test 3: Completed duplicate returns cached item instantly');
  }

  // Test 4: Cache miss but Postgres hit
  {
    const { service, dbStore, redisStore } = createMocks();
    const mockTxn = { id: 'db-uuid', idempotencyKey: 'key-4', currentState: TransactionState.INITIATED };
    dbStore.set('key-4', mockTxn);

    // Initial state: Redis is empty, but Postgres has the record
    assert.strictEqual(redisStore.has('idempotency:key-4'), false);

    const dto: CreateTransactionDto = {
      idempotencyKey: 'key-4',
      merchantId: 'merchant-1',
      amount: 1000,
      currency: 'USD',
    };

    const result = await service.create(dto);

    assert.strictEqual(result.id, 'db-uuid');
    // Verify it cached it back to Redis
    const cached = redisStore.get('idempotency:key-4');
    assert.ok(cached);
    assert.strictEqual(JSON.parse(cached).status, 'completed');
    console.log('✔ Test 4: Cache miss fallback to Postgres succeeds and repopulates cache');
  }

  // Test 5: DB save failure releases the Redis lock
  {
    const { service, redisStore, mockTxnRepo } = createMocks();
    mockTxnRepo.save = async () => {
      throw new Error('Database connection failed');
    };

    const dto: CreateTransactionDto = {
      idempotencyKey: 'key-5',
      merchantId: 'merchant-1',
      amount: 1000,
      currency: 'USD',
    };

    try {
      await service.create(dto);
      assert.fail('Should have failed');
    } catch (e: any) {
      assert.strictEqual(e.message, 'Database connection failed');
      // Assert the Redis key was cleared
      assert.strictEqual(redisStore.has('idempotency:key-5'), false);
      console.log('✔ Test 5: Failure in creation cleans up Redis lock');
    }
  }

  console.log('All Idempotency Guard tests passed successfully!');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
