import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Transaction } from './entities/transaction.entity';
import { AuditLog } from './entities/audit-log.entity';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { StateMachineService } from './state-machine.service';
import { GatewaysModule } from '../gateways/gateways.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction, AuditLog]),
    GatewaysModule,
  ],
  controllers: [TransactionsController],
  providers: [TransactionsService, StateMachineService],
  exports: [TransactionsService, StateMachineService],
})
export class TransactionsModule {}
