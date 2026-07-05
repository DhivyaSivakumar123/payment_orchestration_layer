import { Injectable, ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transaction } from './entities/transaction.entity';
import { AuditLog } from './entities/audit-log.entity';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { TransactionState, GatewayProvider } from '../common/enums/transaction-state.enum';
import { StateMachineService } from './state-machine.service';
import { RedisService } from '../redis/redis.service';
import { RoutingEngineService } from '../gateways/routing-engine.service';
import { StripeAdapter } from '../gateways/adapters/stripe.adapter';
import { RazorpayAdapter } from '../gateways/adapters/razorpay.adapter';
import { PayUAdapter } from '../gateways/adapters/payu.adapter';
import { UpiAdapter } from '../gateways/adapters/upi.adapter';

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    @InjectRepository(Transaction) private readonly txnRepo: Repository<Transaction>,
    @InjectRepository(AuditLog) private readonly auditRepo: Repository<AuditLog>,
    private readonly stateMachine: StateMachineService,
    private readonly redisService: RedisService,
    private readonly routingEngine: RoutingEngineService,
    private readonly stripeAdapter: StripeAdapter,
    private readonly razorpayAdapter: RazorpayAdapter,
    private readonly payuAdapter: PayUAdapter,
    private readonly upiAdapter: UpiAdapter,
  ) {}

  private getAdapter(provider: GatewayProvider) {
    switch (provider) {
      case GatewayProvider.STRIPE:
        return this.stripeAdapter;
      case GatewayProvider.RAZORPAY:
        return this.razorpayAdapter;
      case GatewayProvider.PAYU:
        return this.payuAdapter;
      case GatewayProvider.UPI:
        return this.upiAdapter;
      default:
        throw new Error(`Unsupported gateway provider: ${provider}`);
    }
  }

  /**
   * Entry point for the synchronous path. Idempotency is checked via Redis.
   * If lock is acquired, we rank gateways, execute sequential adapter calls
   * with a 1.5s timeout, and handle retries/failovers.
   */
  async create(dto: CreateTransactionDto): Promise<Transaction> {
    const redisKey = `idempotency:${dto.idempotencyKey}`;

    // 1. Try to set the key to 'processing' with a 10 seconds TTL lock
    const isLockAcquired = await this.redisService.set(
      redisKey,
      JSON.stringify({ status: 'processing' }),
      'NX',
      'EX',
      10,
    );

    if (!isLockAcquired) {
      const cached = await this.redisService.get(redisKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed.status === 'processing') {
          throw new ConflictException('Payment request is already processing. Please try again shortly.');
        }
        if (parsed.status === 'completed') {
          return parsed.transaction;
        }
      }

      const existing = await this.txnRepo.findOne({
        where: { idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        await this.redisService.set(
          redisKey,
          JSON.stringify({ status: 'completed', transaction: existing }),
          undefined,
          'EX',
          86400,
        );
        return existing;
      }

      throw new ConflictException('Payment request is already processing.');
    }

    try {
      // Double check database
      const existing = await this.txnRepo.findOne({
        where: { idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        await this.redisService.set(
          redisKey,
          JSON.stringify({ status: 'completed', transaction: existing }),
          undefined,
          'EX',
          86400,
        );
        return existing;
      }

      // 2. Query Routing Engine to select primary and fallback gateways
      const rankedGateways = await this.routingEngine.getRankedGateways(dto.amount);
      if (rankedGateways.length === 0) {
        throw new ServiceUnavailableException('No payment gateways are currently configured in the environment.');
      }
      const primaryGateway = rankedGateways[0];
      const fallbackGateways = rankedGateways.slice(1);

      // 3. Create transaction in INITIATED state
      const txn = this.txnRepo.create({
        idempotencyKey: dto.idempotencyKey,
        merchantId: dto.merchantId,
        amount: dto.amount,
        currency: dto.currency,
        currentState: TransactionState.INITIATED,
        selectedGateway: primaryGateway,
        fallbackGateways: fallbackGateways,
      });

      const saved = await this.txnRepo.save(txn);

      await this.auditRepo.save(
        this.auditRepo.create({
          transactionId: saved.id,
          fromState: null,
          toState: TransactionState.INITIATED,
          gateway: primaryGateway,
          reason: 'transaction created',
        }),
      );

      // 4. Start sequential execution loop with failover
      let currentGateway = primaryGateway;
      const fallbackList = [...fallbackGateways];
      let lastError = 'No gateways available';

      while (currentGateway) {
        const adapter = this.getAdapter(currentGateway);

        // Transition to ROUTED
        await this.stateMachine.transition(saved.id, TransactionState.ROUTED, {
          gateway: currentGateway,
          reason: `Gateway ${currentGateway} selected for attempt`,
        });

        // Transition to PROCESSING
        await this.stateMachine.transition(saved.id, TransactionState.PROCESSING, {
          gateway: currentGateway,
          incrementAttempt: true,
          reason: `Initiating API call to ${currentGateway}`,
        });

        const startTime = Date.now();
        let chargeResult: any;

        try {
          // Promise.race to enforce aggressive 1.5s call timeout SLA
          chargeResult = await Promise.race([
            adapter.charge({
              transactionId: saved.id,
              amount: dto.amount,
              currency: dto.currency,
              idempotencyKey: `${dto.idempotencyKey}_${currentGateway}`,
            }),
            new Promise<any>((_, reject) =>
              setTimeout(() => reject(new Error('Gateway call timed out')), 1500)
            ),
          ]);
        } catch (err: any) {
          chargeResult = {
            success: false,
            error: err.message || 'Timeout / Network Error',
            latencyMs: Date.now() - startTime,
            rawResponse: { error: err.message || 'Timeout / Network Error' },
          };
        }

        const latencyMs = chargeResult.latencyMs || (Date.now() - startTime);

        if (chargeResult.success) {
          // Payment Charge succeeded! Transition to SUCCESS
          const updatedTxn = await this.stateMachine.transition(saved.id, TransactionState.SUCCESS, {
            gateway: currentGateway,
            gatewayTxnId: chargeResult.gatewayTxnId,
            rawGatewayResponse: chargeResult.rawResponse,
            reason: 'Payment charge succeeded',
          });

          // Record stats success
          await this.routingEngine.recordSuccess(currentGateway, latencyMs);

          // Update idempotency cache
          await this.redisService.set(
            redisKey,
            JSON.stringify({ status: 'completed', transaction: updatedTxn }),
            undefined,
            'EX',
            86400,
          );

          return updatedTxn;
        } else {
          // Payment Charge failed. Record stats failure
          lastError = chargeResult.error;
          await this.routingEngine.recordFailure(currentGateway, latencyMs);

          if (fallbackList.length > 0) {
            // Failover to next gateway: Transition to RETRY_PENDING
            await this.stateMachine.transition(saved.id, TransactionState.RETRY_PENDING, {
              gateway: currentGateway,
              reason: `Attempt failed on ${currentGateway}: ${chargeResult.error}`,
              rawGatewayResponse: chargeResult.rawResponse,
            });

            // Pop next fallback
            currentGateway = fallbackList.shift()!;
          } else {
            // No fallbacks left. Transition to FAILED (terminal)
            const failedTxn = await this.stateMachine.transition(saved.id, TransactionState.FAILED, {
              gateway: currentGateway,
              reason: `All attempts failed. Last error: ${chargeResult.error}`,
              rawGatewayResponse: chargeResult.rawResponse,
            });

            await this.redisService.set(
              redisKey,
              JSON.stringify({ status: 'completed', transaction: failedTxn }),
              undefined,
              'EX',
              86400,
            );

            return failedTxn;
          }
        }
      }

      throw new Error(`Payment execution failed: ${lastError}`);
    } catch (error) {
      // Clean up Redis lock key on system/unhandled failure so it can be retried
      await this.redisService.del(redisKey);
      throw error;
    }
  }

  async findOne(id: string): Promise<Transaction | null> {
    return this.txnRepo.findOne({ where: { id } });
  }

  async history(id: string): Promise<AuditLog[]> {
    return this.auditRepo.find({
      where: { transactionId: id },
      order: { createdAt: 'ASC' },
    });
  }

  async transition(
    id: string,
    toState: TransactionState,
    metadata?: {
      gateway?: GatewayProvider | null;
      gatewayTxnId?: string | null;
      reason?: string | null;
      rawGatewayResponse?: Record<string, unknown> | null;
      incrementAttempt?: boolean;
    },
  ): Promise<Transaction> {
    return this.stateMachine.transition(id, toState, metadata);
  }
}

