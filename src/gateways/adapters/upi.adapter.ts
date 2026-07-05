import { Injectable, Logger } from '@nestjs/common';
import { GatewayAdapter, GatewayChargeRequest, GatewayChargeResponse } from '../interfaces/gateway-adapter.interface';
import { GatewayProvider } from '../../common/enums/transaction-state.enum';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class UpiAdapter implements GatewayAdapter {
  readonly provider = GatewayProvider.UPI;
  private readonly logger = new Logger(UpiAdapter.name);

  async charge(request: GatewayChargeRequest): Promise<GatewayChargeResponse> {
    const startTime = Date.now();
    const amountStr = request.amount.toString();
    this.logger.log(`[UPI] Running in Mock Mode for txn ${request.transactionId}`);

    if (amountStr.endsWith('98') || amountStr.endsWith('99')) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return {
        success: false,
        gatewayTxnId: null,
        error: 'Gateway call timed out',
        rawResponse: { error: 'Timeout after 2000ms' },
        latencyMs: Date.now() - startTime,
      };
    }

    if (amountStr.endsWith('00') || amountStr.endsWith('03')) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        success: false,
        gatewayTxnId: null,
        error: 'Simulated UPI Intent App Failure',
        rawResponse: { error: { message: 'UPI payment declined by user.' } },
        latencyMs: Date.now() - startTime,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      success: true,
      gatewayTxnId: `upi_${uuidv4().replace(/-/g, '').slice(0, 16)}`,
      rawResponse: { status: 'SUCCESS', upi_txn_id: `upi_${request.transactionId}` },
      latencyMs: Date.now() - startTime,
    };
  }
}
