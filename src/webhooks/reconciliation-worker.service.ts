import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebhookEvent } from './entities/webhook-event.entity';
import { Transaction } from '../transactions/entities/transaction.entity';
import { StateMachineService } from '../transactions/state-machine.service';
import { RedisService } from '../redis/redis.service';
import { GatewayProvider, TransactionState } from '../common/enums/transaction-state.enum';

@Injectable()
export class ReconciliationWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationWorkerService.name);
  private readonly queueName = 'payment_orchestrator:reconciliation_queue';
  private isActive = false;
  private workerPromise: Promise<void> | null = null;

  constructor(
    @InjectRepository(WebhookEvent)
    private readonly webhookRepo: Repository<WebhookEvent>,
    @InjectRepository(Transaction)
    private readonly txnRepo: Repository<Transaction>,
    private readonly stateMachine: StateMachineService,
    private readonly redisService: RedisService,
  ) {}

  onModuleInit() {
    this.isActive = true;
    this.workerPromise = this.pollQueue();
  }

  async onModuleDestroy() {
    this.isActive = false;
    if (this.workerPromise) {
      await this.workerPromise;
    }
  }

  private async pollQueue(): Promise<void> {
    this.logger.log('Webhook Reconciliation Worker started.');

    while (this.isActive) {
      try {
        const client = this.redisService.getClient();
        const result = await client.brpop(this.queueName, 2);

        if (!result) {
          continue;
        }

        const [_, eventRecordId] = result;
        await this.processEvent(eventRecordId);
      } catch (err: any) {
        this.logger.error(`Error in webhook reconciliation queue poll: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    this.logger.log('Webhook Reconciliation Worker stopped.');
  }

  private async processEvent(recordId: string): Promise<void> {
    this.logger.log(`Processing webhook event ${recordId} from queue...`);

    const event = await this.webhookRepo.findOne({ where: { id: recordId } });
    if (!event) {
      this.logger.error(`WebhookEvent record ${recordId} not found in database.`);
      return;
    }

    if (event.processed) {
      this.logger.warn(`WebhookEvent ${recordId} is already marked as processed.`);
      return;
    }

    try {
      const gatewayTxnId = this.extractGatewayTxnId(event.gateway, event.payload);
      if (!gatewayTxnId) {
        this.logger.warn(`Could not extract gatewayTxnId from ${event.gateway} payload for event ${event.eventId}`);
        event.processed = true;
        event.processedAt = new Date();
        await this.webhookRepo.save(event);
        return;
      }

      this.logger.log(`Parsed gatewayTxnId: ${gatewayTxnId} for ${event.gateway}`);

      const txn = await this.txnRepo.findOne({
        where: [
          { gatewayTxnId: gatewayTxnId },
          { idempotencyKey: (event.payload as any)?.idempotencyKey || '___none___' }
        ]
      });

      if (!txn) {
        this.logger.error(`No transaction found matching gatewayTxnId ${gatewayTxnId} or payload metadata.`);
        event.processed = true;
        event.processedAt = new Date();
        await this.webhookRepo.save(event);
        return;
      }

      await this.driveToReconciled(txn, event.gateway, gatewayTxnId, event.payload);

      event.processed = true;
      event.processedAt = new Date();
      await this.webhookRepo.save(event);
      this.logger.log(`Reconciled transaction ${txn.id} successfully from webhook event.`);
    } catch (err: any) {
      this.logger.error(`Failed to reconcile webhook event ${recordId}: ${err.message}`);
      throw err;
    }
  }

  private extractGatewayTxnId(gateway: GatewayProvider, payload: any): string | null {
    if (!payload) return null;
    switch (gateway) {
      case GatewayProvider.STRIPE:
        return payload.data?.object?.id || payload.id || null;
      case GatewayProvider.RAZORPAY:
        return (
          payload.payload?.payment?.entity?.id ||
          payload.payload?.payment?.entity?.order_id ||
          payload.id ||
          null
        );
      case GatewayProvider.PAYU:
        return payload.mihpayid || payload.txnid || payload.id || null;
      case GatewayProvider.UPI:
        return payload.upi_txn_id || payload.id || null;
      default:
        return null;
    }
  }

  private async driveToReconciled(
    txn: Transaction,
    gateway: GatewayProvider,
    gatewayTxnId: string,
    rawResponse: any,
  ): Promise<void> {
    let state = txn.currentState;
    let currentId = txn.id;

    if (state === TransactionState.RECONCILED) {
      return;
    }

    if (state === TransactionState.INITIATED) {
      const updated = await this.stateMachine.transition(currentId, TransactionState.ROUTED, {
        gateway,
        reason: 'Webhook reconciliation auto-routing',
      });
      state = updated.currentState;
    }

    if (state === TransactionState.RETRY_PENDING) {
      const updated = await this.stateMachine.transition(currentId, TransactionState.ROUTED, {
        gateway,
        reason: 'Webhook reconciliation auto-routing after retry',
      });
      state = updated.currentState;
    }

    if (state === TransactionState.ROUTED) {
      const updated = await this.stateMachine.transition(currentId, TransactionState.PROCESSING, {
        gateway,
        incrementAttempt: true,
        reason: 'Webhook reconciliation processing attempt',
      });
      state = updated.currentState;
    }

    if (state === TransactionState.PROCESSING) {
      const updated = await this.stateMachine.transition(currentId, TransactionState.SUCCESS, {
        gateway,
        gatewayTxnId,
        rawGatewayResponse: rawResponse,
        reason: 'Webhook reconciliation success transition',
      });
      state = updated.currentState;
    }

    if (state === TransactionState.SUCCESS) {
      await this.stateMachine.transition(currentId, TransactionState.RECONCILED, {
        gateway,
        reason: 'Webhook reconciliation completed',
        rawGatewayResponse: rawResponse,
      });
    }
  }
}
