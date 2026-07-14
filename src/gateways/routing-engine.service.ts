import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GatewayStats } from './entities/gateway-stats.entity';
import { GatewayProvider, CircuitState } from '../common/enums/transaction-state.enum';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class RoutingEngineService {
  private readonly logger = new Logger(RoutingEngineService.name);

  constructor(
    @InjectRepository(GatewayStats)
    private readonly statsRepo: Repository<GatewayStats>,
    private readonly redisService: RedisService,
  ) {}

  private isGatewayConfigured(gateway: GatewayProvider): boolean {
    if (gateway === GatewayProvider.STRIPE) {
      const key = process.env.STRIPE_SECRET_KEY;
      return !!(key && !key.includes('xxxxxxxxxxxx') && !key.endsWith('xxx'));
    }
    if (gateway === GatewayProvider.RAZORPAY) {
      const key = process.env.RAZORPAY_KEY_SECRET;
      return !!(key && !key.includes('xxxxxxxxxxxx') && !key.endsWith('xxx'));
    }
    if (gateway === GatewayProvider.PAYU) {
      const key = process.env.PAYU_SALT || process.env.PAYU_MERCHANT_KEY;
      return !!(key && !key.includes('xxxxxxxxxxxx') && !key.endsWith('xxx'));
    }
    if (gateway === GatewayProvider.UPI) {
      const key = process.env.UPI_VPA || process.env.UPI_MERCHANT_ID;
      return !!(key && !key.includes('xxxxxxxxxxxx') && !key.endsWith('xxx'));
    }
    return false;
  }

  /**
   * Calculates dynamic scores for all gateways and returns a ranked list of providers.
   * Filters out OPEN circuit breakers unless the cooldown has expired (moving them to HALF_OPEN).
   */
  async getRankedGateways(amount: number): Promise<GatewayProvider[]> {
    const isTest = process.env.NODE_ENV === 'test';
    const statsList = (await this.statsRepo.find()).filter(stats => {
      if (isTest) return true;
      return this.isGatewayConfigured(stats.gateway);
    });

    const candidatesWithScores = await Promise.all(
      statsList.map(async (stats) => {
        let circuitState = stats.circuitState;

        // Check if circuit breaker is OPEN and cooldown has expired
        if (circuitState === CircuitState.OPEN) {
          const redisKey = `circuit:open:${stats.gateway}`;
          const isTripped = await this.redisService.get(redisKey);
          if (!isTripped) {
            this.logger.log(`Circuit cooldown expired for ${stats.gateway}. Transitioning to HALF_OPEN.`);
            stats.circuitState = CircuitState.HALF_OPEN;
            stats.consecutiveFailures = 0;
            circuitState = CircuitState.HALF_OPEN;
            await this.statsRepo.save(stats);
          }
        }

        // If still OPEN, exclude from routing (or rank lowest with score 0)
        if (circuitState === CircuitState.OPEN) {
          return { provider: stats.gateway, score: -1, stats };
        }

        // 1. Success Rate
        const totalTxns = stats.successCount + stats.failureCount;
        const successRate = totalTxns === 0 ? 1.0 : stats.successCount / totalTxns;

        // 2. Cost Score (Lower cost = higher score)
        // Assume maximum cost is 300 bps (3.0%). Normalize cost relative to 300 bps.
        const maxCost = 300;
        const costScore = Math.max(0, (maxCost - stats.costBps) / maxCost);

        // 3. Latency Score (Lower latency = higher score)
        // Normalize latency using formula 1000 / avgLatency. If 0, treat as 200ms.
        const effectiveLatency = stats.avgLatencyMs || 200;
        const latencyScore = 1000 / Math.max(effectiveLatency, 50);

        // 4. Health Multiplier
        const healthMultiplier = circuitState === CircuitState.HALF_OPEN ? 0.3 : 1.0;

        // Dynamic Weights based on transaction value (5000 cents/paise = 50.00 USD/INR)
        let wSuccess: number;
        let wCost: number;
        let wLatency: number;

        if (amount > 5000) {
          // High value: prioritize reliability/success
          wSuccess = 0.7;
          wCost = 0.1;
          wLatency = 0.2;
        } else {
          // Low value: prioritize lowest cost
          wSuccess = 0.3;
          wCost = 0.5;
          wLatency = 0.2;
        }

        const score = healthMultiplier * (
          wSuccess * successRate +
          wCost * costScore +
          wLatency * (latencyScore / 20)
        );

        return { provider: stats.gateway, score, stats };
      })
    );

    // Filter out candidates that are OPEN (score = -1), and sort by score descending
    const filtered = candidatesWithScores.filter(c => c.score >= 0);
    filtered.sort((a, b) => b.score - a.score);

    // If everything is tripped (filtered is empty), return all gateways sorted by cost
    if (filtered.length === 0) {
      this.logger.warn('All gateways are currently in OPEN circuit breaker state! Falling back to raw cost ranking.');
      const allSorted = [...candidatesWithScores].sort((a, b) => a.stats.costBps - b.stats.costBps);
      return allSorted.map(c => c.provider);
    }

    return filtered.map((c) => c.provider);
  }

  async recordSuccess(gateway: GatewayProvider, latencyMs: number): Promise<void> {
    const stats = await this.statsRepo.findOne({ where: { gateway } });
    if (!stats) return;

    stats.successCount += 1;
    stats.consecutiveFailures = 0;
    
    // Smooth Exponential Moving Average for Latency
    stats.avgLatencyMs = stats.avgLatencyMs === 0
      ? latencyMs
      : Math.round(stats.avgLatencyMs * 0.9 + latencyMs * 0.1);

    if (stats.circuitState !== CircuitState.CLOSED) {
      this.logger.log(`Circuit breaker for ${gateway} recovered to CLOSED.`);
      stats.circuitState = CircuitState.CLOSED;
      await this.redisService.del(`circuit:open:${gateway}`);
    }

    await this.statsRepo.save(stats);
  }

  async recordFailure(gateway: GatewayProvider, latencyMs: number): Promise<void> {
    const stats = await this.statsRepo.findOne({ where: { gateway } });
    if (!stats) return;

    stats.failureCount += 1;
    stats.consecutiveFailures += 1;

    // Smooth Exponential Moving Average for Latency (only update if valid latency provided)
    if (latencyMs > 0) {
      stats.avgLatencyMs = stats.avgLatencyMs === 0
        ? latencyMs
        : Math.round(stats.avgLatencyMs * 0.9 + latencyMs * 0.1);
    }

    if (stats.consecutiveFailures >= 3 && stats.circuitState !== CircuitState.OPEN) {
      this.logger.error(`Circuit breaker for ${gateway} TRIPPED to OPEN due to ${stats.consecutiveFailures} consecutive failures.`);
      stats.circuitState = CircuitState.OPEN;

      // Store open circuit state in Redis for 30 seconds cooldown
      await this.redisService.set(
        `circuit:open:${gateway}`,
        'open',
        undefined,
        'EX',
        30
      );
    }

    await this.statsRepo.save(stats);
  }
}
