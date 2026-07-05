import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { CircuitState, GatewayProvider } from '../../common/enums/transaction-state.enum';

/**
 * Rolling stats per gateway, used by the routing engine to score
 * candidates. This table is the durable snapshot; the hot path reads
 * from Redis (see RoutingEngine) and this table is updated on a
 * schedule / after each outcome as the source of truth for restarts.
 */
@Entity('gateway_stats')
export class GatewayStats {
  @PrimaryColumn({ name: 'gateway', type: 'enum', enum: GatewayProvider })
  gateway: GatewayProvider;

  @Column({ name: 'success_count', type: 'int', default: 0 })
  successCount: number;

  @Column({ name: 'failure_count', type: 'int', default: 0 })
  failureCount: number;

  @Column({ name: 'avg_latency_ms', type: 'int', default: 0 })
  avgLatencyMs: number;

  @Column({ name: 'cost_bps', type: 'int', default: 0 })
  costBps: number; // fee in basis points, e.g. 200 = 2.00%

  @Column({ name: 'circuit_state', type: 'enum', enum: CircuitState, default: CircuitState.CLOSED })
  circuitState: CircuitState;

  @Column({ name: 'consecutive_failures', type: 'int', default: 0 })
  consecutiveFailures: number;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
