import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { TransactionsService } from './transactions/transactions.service';
import { StripeAdapter } from './gateways/adapters/stripe.adapter';
import { DataSource } from 'typeorm';
import { CreateTransactionDto } from './transactions/dto/create-transaction.dto';
import { GatewayProvider } from './common/enums/transaction-state.enum';
import { v4 as uuidv4 } from 'uuid';

async function run() {
  console.log('Initializing test application context...');
  const app = await NestFactory.createApplicationContext(AppModule);
  
  const transactionsService = app.get(TransactionsService);
  const stripeAdapter = app.get(StripeAdapter);
  const dataSource = app.get(DataSource);
  
  console.log('\n--- 1. Testing Database Connection ---');
  try {
    const isConnected = dataSource.isInitialized;
    console.log(`Database initialized: ${isConnected}`);
    console.log(`Connected to host: ${(dataSource.options as any).host}`);
    
    // Check tables
    const runner = dataSource.createQueryRunner();
    const tables = await runner.getTables(['transactions', 'audit_log', 'gateway_stats']);
    console.log(`Verified tables count: ${tables.length} (Expected 3)`);
    await runner.release();
  } catch (err: any) {
    console.error('Database connection failed:', err.message);
    await app.close();
    process.exit(1);
  }

  console.log('\n--- 2. Testing Stripe Integration (Direct API Call) ---');
  try {
    const idempotencyKey = `direct-stripe-test-${uuidv4()}`;
    console.log('Sending direct charge of $5.05 to real Stripe API...');
    
    const stripeResult = await stripeAdapter.charge({
      transactionId: uuidv4(),
      amount: 505, // $5.05
      currency: 'usd',
      idempotencyKey,
    });
    
    console.log('\nStripe Direct Charge Result:');
    console.log(` - Success: ${stripeResult.success}`);
    console.log(` - Gateway Txn ID: ${stripeResult.gatewayTxnId}`);
    console.log(` - Latency: ${stripeResult.latencyMs}ms`);
    if (!stripeResult.success) {
      console.log(` - Error: ${stripeResult.error}`);
    }
  } catch (err: any) {
    console.error('Direct Stripe charge attempt failed:', err.message);
  }

  console.log('\n--- 3. Testing Full Transaction Orchestration Flow ---');
  try {
    const dto: CreateTransactionDto = {
      idempotencyKey: `txn-flow-test-${uuidv4()}`,
      merchantId: 'merchant-test-1',
      amount: 5505, // 55.05 USD
      currency: 'USD',
    };

    console.log(`Creating payment transaction for amount $15.50 via routing engine...`);
    const transaction = await transactionsService.create(dto);
    
    console.log('\nTransaction successfully completed:');
    console.log(`ID: ${transaction.id}`);
    console.log(`Selected Gateway: ${transaction.selectedGateway}`);
    console.log(`State: ${transaction.currentState}`);
    console.log(`Gateway Txn ID: ${transaction.gatewayTxnId}`);
    
    console.log('\nAudit Logs saved to database:');
    const logs = await transactionsService.history(transaction.id);
    for (const log of logs) {
      console.log(` - Transition: ${log.fromState || 'null'} -> ${log.toState} (Gateway: ${log.gateway}, Reason: ${log.reason})`);
    }
  } catch (err: any) {
    console.error('Transaction flow execution failed:', err.message);
  }

  await app.close();
  console.log('\nTesting session completed.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Unhandled error during test:', err);
  process.exit(1);
});
