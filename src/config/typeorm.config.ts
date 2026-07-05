import 'dotenv/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { Transaction } from '../transactions/entities/transaction.entity';
import { AuditLog } from '../transactions/entities/audit-log.entity';
import { WebhookEvent } from '../webhooks/entities/webhook-event.entity';
import { GatewayStats } from '../gateways/entities/gateway-stats.entity';

export const typeOrmConfig: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'payment_orchestrator',
  entities: [Transaction, AuditLog, WebhookEvent, GatewayStats],
  migrations: [
    __filename.endsWith('.js')
      ? 'dist/database/migrations/*.js'
      : 'src/database/migrations/*.ts',
  ],
  synchronize: false, // always migrate explicitly for a system that moves money
  logging: process.env.NODE_ENV === 'development',
  ssl: process.env.DB_HOST && process.env.DB_HOST !== 'localhost' ? { rejectUnauthorized: false } : false,
};

export default new DataSource(typeOrmConfig);
