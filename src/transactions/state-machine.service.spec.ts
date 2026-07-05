import { StateMachineService } from './state-machine.service';
import { TransactionState, GatewayProvider } from '../common/enums/transaction-state.enum';
import * as assert from 'assert';

// Mocking helper for EntityManager
function createMockManager(transactionData: any) {
  const savedEntities: any[] = [];
  const mockQueryBuilder = {
    setLock: () => mockQueryBuilder,
    where: () => mockQueryBuilder,
    getOne: async () => transactionData,
  };

  const mockManager = {
    createQueryBuilder: () => mockQueryBuilder,
    save: async (entity: any) => {
      savedEntities.push(entity);
      return entity;
    },
    create: (entityClass: any, data: any) => {
      return data;
    },
    transaction: async (cb: (manager: any) => Promise<any>) => {
      return cb(mockManager);
    },
  };

  return { mockManager, savedEntities };
}

async function runTests() {
  console.log('Running StateMachineService tests...');

  // Test 1: Valid transition INITIATED -> ROUTED
  {
    const initialTxn = {
      id: 'txn-1',
      currentState: TransactionState.INITIATED,
      selectedGateway: null,
      gatewayTxnId: null,
      attemptCount: 0,
    };
    const { mockManager, savedEntities } = createMockManager(initialTxn);
    const service = new StateMachineService(mockManager as any);

    const result = await service.transition('txn-1', TransactionState.ROUTED, {
      gateway: GatewayProvider.STRIPE,
    });

    assert.strictEqual(result.currentState, TransactionState.ROUTED);
    assert.strictEqual(result.selectedGateway, GatewayProvider.STRIPE);
    assert.strictEqual(savedEntities.length, 2); // 1 for Transaction save, 1 for AuditLog save
    assert.strictEqual(savedEntities[1].fromState, TransactionState.INITIATED);
    assert.strictEqual(savedEntities[1].toState, TransactionState.ROUTED);
    assert.strictEqual(savedEntities[1].gateway, GatewayProvider.STRIPE);
    console.log('✔ Test 1: INITIATED -> ROUTED passed');
  }

  // Test 2: Invalid transition INITIATED -> PROCESSING
  {
    const initialTxn = {
      id: 'txn-2',
      currentState: TransactionState.INITIATED,
      selectedGateway: null,
      gatewayTxnId: null,
      attemptCount: 0,
    };
    const { mockManager } = createMockManager(initialTxn);
    const service = new StateMachineService(mockManager as any);

    try {
      await service.transition('txn-2', TransactionState.PROCESSING);
      assert.fail('Should have failed');
    } catch (e: any) {
      assert.strictEqual(e.message, 'Invalid state transition: cannot transition from INITIATED to PROCESSING');
      console.log('✔ Test 2: INITIATED -> PROCESSING (invalid) passed');
    }
  }

  // Test 3: Transaction not found
  {
    const { mockManager } = createMockManager(null);
    const service = new StateMachineService(mockManager as any);

    try {
      await service.transition('non-existent', TransactionState.ROUTED);
      assert.fail('Should have failed');
    } catch (e: any) {
      assert.strictEqual(e.message, 'Transaction with ID non-existent not found');
      console.log('✔ Test 3: Transaction not found passed');
    }
  }

  // Test 4: Attempt Count Increment
  {
    const initialTxn = {
      id: 'txn-4',
      currentState: TransactionState.ROUTED,
      selectedGateway: GatewayProvider.STRIPE,
      gatewayTxnId: null,
      attemptCount: 1,
    };
    const { mockManager, savedEntities } = createMockManager(initialTxn);
    const service = new StateMachineService(mockManager as any);

    const result = await service.transition('txn-4', TransactionState.PROCESSING, {
      incrementAttempt: true,
    });

    assert.strictEqual(result.currentState, TransactionState.PROCESSING);
    assert.strictEqual(result.attemptCount, 2);
    console.log('✔ Test 4: Attempt Count Increment passed');
  }

  console.log('All tests passed successfully!');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
