import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { WebhookEvent } from './entities/webhook-event.entity';
import { GatewayProvider } from '../common/enums/transaction-state.enum';
import { ReconciliationQueueService } from './reconciliation-queue.service';

export interface IncomingWebhook {
  gateway: GatewayProvider;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  signatureVerified: boolean;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @InjectRepository(WebhookEvent) private readonly webhookRepo: Repository<WebhookEvent>,
    private readonly queueService: ReconciliationQueueService,
  ) {}

  /**
   * Stores the raw webhook event. The unique index on (gateway, event_id)
   * is what actually enforces dedup — if this insert throws a unique
   * violation, it's a retry from the gateway and we treat it as a no-op.
   *
   * Returns `{ duplicate: true }` when the event was already seen, so
   * the controller can still respond 200 OK (gateways expect an ack
   * either way, or they'll keep retrying).
   */
  async ingest(event: IncomingWebhook): Promise<{ duplicate: boolean; record?: WebhookEvent }> {
    try {
      const record = await this.webhookRepo.save(
        this.webhookRepo.create({
          gateway: event.gateway,
          eventId: event.eventId,
          eventType: event.eventType,
          payload: event.payload,
          signatureVerified: event.signatureVerified,
          processed: false,
        }),
      );

      // Push webhook event ID onto the reconciliation queue for async processing
      await this.queueService.pushEvent(record.id);

      return { duplicate: false, record };
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        this.logger.log(`duplicate webhook ignored: ${event.gateway}/${event.eventId}`);
        return { duplicate: true };
      }
      throw err;
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof QueryFailedError &&
      (err as unknown as { code?: string }).code === '23505'
    );
  }
}
