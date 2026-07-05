import { Injectable, Logger } from '@nestjs/common';
import { GatewayAdapter, GatewayChargeRequest, GatewayChargeResponse } from '../interfaces/gateway-adapter.interface';
import { GatewayProvider } from '../../common/enums/transaction-state.enum';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class PayUAdapter implements GatewayAdapter {
  readonly provider = GatewayProvider.PAYU;
  private readonly logger = new Logger(PayUAdapter.name);

  async charge(request: GatewayChargeRequest): Promise<GatewayChargeResponse> {
    const startTime = Date.now();
    const amountStr = request.amount.toString();
    this.logger.log(`[PAYU] Running in Mock Mode for txn ${request.transactionId}`);

    if (amountStr.endsWith('97')) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return {
        success: false,
        gatewayTxnId: null,
        error: 'Gateway call timed out',
        rawResponse: { error: 'Timeout after 2000ms' },
        latencyMs: Date.now() - startTime,
      };
    }

    if (amountStr.endsWith('02')) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        success: false,
        gatewayTxnId: null,
        error: 'Simulated PayU Failure',
        rawResponse: { error: { message: 'Bank returned failure code.' } },
        latencyMs: Date.now() - startTime,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 180));
    return {
      success: true,
      gatewayTxnId: `payu_${uuidv4().replace(/-/g, '').slice(0, 16)}`,
      rawResponse: { status: 'success', mihpayid: `payu_${request.transactionId}` },
      latencyMs: Date.now() - startTime,
    };
  }
}
