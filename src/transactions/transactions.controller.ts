import { BadRequestException, Body, Controller, Get, Headers, NotFoundException, Param, Post } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';

@Controller('payments')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post()
  async create(
    @Body() dto: CreateTransactionDto,
    @Headers('idempotency-key') headerKey?: string,
  ) {
    if (headerKey) {
      dto.idempotencyKey = headerKey;
    }
    if (!dto.idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header or idempotencyKey body field is required');
    }
    return this.transactionsService.create(dto as any);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const txn = await this.transactionsService.findOne(id);
    if (!txn) throw new NotFoundException('transaction not found');
    return txn;
  }

  @Get(':id/history')
  async history(@Param('id') id: string) {
    return this.transactionsService.history(id);
  }
}
