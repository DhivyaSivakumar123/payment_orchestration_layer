import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookEvent } from './entities/webhook-event.entity';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { ReconciliationQueueService } from './reconciliation-queue.service';
import { ReconciliationWorkerService } from './reconciliation-worker.service';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionsModule } from '../transactions/transactions.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([WebhookEvent, Transaction]),
    TransactionsModule,
  ],
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    ReconciliationQueueService,
    ReconciliationWorkerService,
  ],
})
export class WebhooksModule {}
