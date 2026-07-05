import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { GatewayProvider, TransactionState } from '../../common/enums/transaction-state.enum';

@Entity('transactions')
@Index(['idempotencyKey'], { unique: true })
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey: string;

  @Column({ name: 'merchant_id', type: 'varchar', length: 100 })
  merchantId: string;

  @Column({ name: 'amount', type: 'bigint' })
  amount: number; // store in smallest currency unit (paise/cents)

  @Column({ name: 'currency', type: 'varchar', length: 10 })
  currency: string;

  @Column({
    name: 'current_state',
    type: 'enum',
    enum: TransactionState,
    default: TransactionState.INITIATED,
  })
  currentState: TransactionState;

  @Column({
    name: 'selected_gateway',
    type: 'enum',
    enum: GatewayProvider,
    nullable: true,
  })
  selectedGateway: GatewayProvider | null;

  @Column({ name: 'gateway_txn_id', type: 'varchar', length: 255, nullable: true })
  gatewayTxnId: string | null;

  // Precomputed ranked fallback list of gateways for this transaction,
  // so failover doesn't need to re-score mid-flight.
  @Column({ name: 'fallback_gateways', type: 'jsonb', default: () => "'[]'" })
  fallbackGateways: GatewayProvider[];

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'final_reconciled_at', type: 'timestamptz', nullable: true })
  finalReconciledAt: Date | null;
}
