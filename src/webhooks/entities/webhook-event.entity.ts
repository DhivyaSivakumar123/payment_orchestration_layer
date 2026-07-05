import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { GatewayProvider } from '../../common/enums/transaction-state.enum';

/**
 * Every inbound webhook is stored here first. The unique constraint on
 * (gateway, event_id) is the actual deduplication mechanism: if the
 * same gateway sends the same event_id twice (very common — most
 * gateways retry webhooks aggressively), the second insert fails and
 * we just ack the request without reprocessing.
 */
@Entity('webhook_events')
@Index(['gateway', 'eventId'], { unique: true })
export class WebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'gateway', type: 'enum', enum: GatewayProvider })
  gateway: GatewayProvider;

  @Column({ name: 'event_id', type: 'varchar', length: 255 })
  eventId: string;

  @Column({ name: 'event_type', type: 'varchar', length: 100 })
  eventType: string;

  @Column({ name: 'payload', type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'signature_verified', type: 'boolean', default: false })
  signatureVerified: boolean;

  @Column({ name: 'processed', type: 'boolean', default: false })
  processed: boolean;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @CreateDateColumn({ name: 'received_at' })
  receivedAt: Date;
}
