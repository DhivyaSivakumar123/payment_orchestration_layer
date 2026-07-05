import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { Transaction } from './entities/transaction.entity';
import { AuditLog } from './entities/audit-log.entity';
import { TransactionState, GatewayProvider, VALID_TRANSITIONS } from '../common/enums/transaction-state.enum';

@Injectable()
export class StateMachineService {
  constructor(
    @InjectEntityManager() private readonly entityManager: EntityManager,
  ) {}

  /**
   * Transition a transaction to a new state.
   * Leverages a database transaction with pessimistic row-level locking (SELECT ... FOR UPDATE)
   * to ensure no concurrent updates cause race conditions.
   */
  async transition(
    transactionId: string,
    toState: TransactionState,
    metadata?: {
      gateway?: GatewayProvider | null;
      gatewayTxnId?: string | null;
      reason?: string | null;
      rawGatewayResponse?: Record<string, unknown> | null;
      incrementAttempt?: boolean;
    },
  ): Promise<Transaction> {
    return this.entityManager.transaction(async (manager) => {
      // 1. Fetch transaction with a pessimistic write lock (SELECT ... FOR UPDATE)
      const transaction = await manager
        .createQueryBuilder(Transaction, 'transaction')
        .setLock('pessimistic_write')
        .where('transaction.id = :id', { id: transactionId })
        .getOne();

      if (!transaction) {
        throw new NotFoundException(`Transaction with ID ${transactionId} not found`);
      }

      const fromState = transaction.currentState;

      // 2. Validate transition
      const allowedNextStates = VALID_TRANSITIONS[fromState] || [];
      if (!allowedNextStates.includes(toState)) {
        throw new BadRequestException(
          `Invalid state transition: cannot transition from ${fromState} to ${toState}`,
        );
      }

      // 3. Mutate transaction fields
      transaction.currentState = toState;

      if (metadata?.gateway !== undefined) {
        transaction.selectedGateway = metadata.gateway;
      }
      if (metadata?.gatewayTxnId !== undefined) {
        transaction.gatewayTxnId = metadata.gatewayTxnId;
      }
      if (metadata?.incrementAttempt) {
        transaction.attemptCount += 1;
      }
      if (toState === TransactionState.RECONCILED) {
        transaction.finalReconciledAt = new Date();
      }

      // 4. Save transaction
      const updatedTransaction = await manager.save(transaction);

      // 5. Create audit log entry
      const auditLog = manager.create(AuditLog, {
        transactionId: updatedTransaction.id,
        fromState,
        toState,
        gateway: metadata?.gateway ?? updatedTransaction.selectedGateway,
        reason: metadata?.reason ?? null,
        rawGatewayResponse: metadata?.rawGatewayResponse ?? null,
      });
      await manager.save(auditLog);

      return updatedTransaction;
    });
  }
}
