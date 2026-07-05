import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class ReconciliationQueueService {
  private readonly logger = new Logger(ReconciliationQueueService.name);
  private readonly queueName = 'payment_orchestrator:reconciliation_queue';

  constructor(private readonly redisService: RedisService) {}

  /**
   * Pushes the webhook event database record ID onto the Redis list queue.
   */
  async pushEvent(eventId: string): Promise<void> {
    try {
      await this.redisService.getClient().lpush(this.queueName, eventId);
      this.logger.log(`Queued webhook event ID for reconciliation: ${eventId}`);
    } catch (err: any) {
      this.logger.error(`Failed to queue webhook event ID ${eventId}: ${err.message}`);
      throw err;
    }
  }
}
