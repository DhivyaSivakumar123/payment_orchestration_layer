import { Controller, Get } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GatewayStats } from './entities/gateway-stats.entity';

@Controller('gateways')
export class GatewaysController {
  constructor(
    @InjectRepository(GatewayStats)
    private readonly statsRepo: Repository<GatewayStats>,
  ) {}

  @Get('stats')
  async getStats() {
    const statsList = await this.statsRepo.find();
    
    return statsList.map(stats => {
      const totalAttempts = stats.successCount + stats.failureCount;
      const successRate = totalAttempts === 0 ? 100 : Math.round((stats.successCount / totalAttempts) * 100);

      return {
        gateway: stats.gateway,
        successRatePercent: successRate,
        averageLatencyMs: stats.avgLatencyMs,
        costBasisPoints: stats.costBps,
        circuitState: stats.circuitState,
        consecutiveFailures: stats.consecutiveFailures,
        totalAttempts,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        updatedAt: stats.updatedAt,
      };
    });
  }
}
