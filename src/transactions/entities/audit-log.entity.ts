import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { GatewayProvider, TransactionState } from '../../common/enums/transaction-state.enum';

/**
 * Append-only. Rows here are never updated or deleted — this is the
 * complete audit trail the assignment requires. The `transactions`
 * table only ever holds *current* state; history lives here.
 */
@Entity('audit_log')
@Index(['transactionId'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId: string;

  @Column({ name: 'from_state', type: 'enum', enum: TransactionState, nullable: true })
  fromState: TransactionState | null;

  @Column({ name: 'to_state', type: 'enum', enum: TransactionState })
  toState: TransactionState;

  @Column({ name: 'gateway', type: 'enum', enum: GatewayProvider, nullable: true })
  gateway: GatewayProvider | null;

  @Column({ name: 'reason', type: 'varchar', length: 500, nullable: true })
  reason: string | null;

  @Column({ name: 'raw_gateway_response', type: 'jsonb', nullable: true })
  rawGatewayResponse: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
