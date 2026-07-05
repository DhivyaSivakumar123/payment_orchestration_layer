import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GatewayAdapter, GatewayChargeRequest, GatewayChargeResponse } from '../interfaces/gateway-adapter.interface';
import { GatewayProvider } from '../../common/enums/transaction-state.enum';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class StripeAdapter implements GatewayAdapter {
  readonly provider = GatewayProvider.STRIPE;
  private readonly logger = new Logger(StripeAdapter.name);

  constructor(private readonly configService: ConfigService) {}

  async charge(request: GatewayChargeRequest): Promise<GatewayChargeResponse> {
    const startTime = Date.now();
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    const isMockMode = !secretKey || secretKey.startsWith('sk_test_xxx');

    const amountStr = request.amount.toString();
    if (isMockMode || amountStr.endsWith('99') || amountStr.endsWith('00')) {
      this.logger.log(`[STRIPE] Running in Mock Mode for txn ${request.transactionId}`);
      
      if (amountStr.endsWith('99')) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return {
          success: false,
          gatewayTxnId: null,
          error: 'Gateway call timed out',
          rawResponse: { error: 'Timeout after 2000ms' },
          latencyMs: Date.now() - startTime,
        };
      }

      if (amountStr.endsWith('00')) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return {
          success: false,
          gatewayTxnId: null,
          error: 'Simulated Stripe Card Decline',
          rawResponse: { error: { message: 'Your card was declined.', code: 'card_declined' } },
          latencyMs: Date.now() - startTime,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        success: true,
        gatewayTxnId: `ch_str_${uuidv4().replace(/-/g, '').slice(0, 16)}`,
        rawResponse: { status: 'succeeded', object: 'charge', id: `ch_str_${request.transactionId}` },
        latencyMs: Date.now() - startTime,
      };
    }

    try {
      const response = await fetch('https://api.stripe.com/v1/charges', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': request.idempotencyKey,
        },
        body: new URLSearchParams({
          amount: request.amount.toString(),
          currency: request.currency.toLowerCase(),
          description: `Transaction ${request.transactionId}`,
          source: 'tok_visa',
        }),
      });

      const data = await response.json() as any;
      const latencyMs = Date.now() - startTime;

      if (response.status === 200 && data.status === 'succeeded') {
        return {
          success: true,
          gatewayTxnId: data.id,
          rawResponse: data,
          latencyMs,
        };
      } else {
        return {
          success: false,
          gatewayTxnId: null,
          error: data.error?.message || 'Stripe charging failed',
          rawResponse: data,
          latencyMs,
        };
      }
    } catch (err: any) {
      return {
        success: false,
        gatewayTxnId: null,
        error: err.message || 'Network error on Stripe',
        rawResponse: { error: err.message },
        latencyMs: Date.now() - startTime,
      };
    }
  }
}
