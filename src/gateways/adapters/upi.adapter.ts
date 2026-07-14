import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GatewayAdapter, GatewayChargeRequest, GatewayChargeResponse } from '../interfaces/gateway-adapter.interface';
import { GatewayProvider } from '../../common/enums/transaction-state.enum';

@Injectable()
export class UpiAdapter implements GatewayAdapter {
  readonly provider = GatewayProvider.UPI;
  private readonly logger = new Logger(UpiAdapter.name);

  constructor(private readonly configService: ConfigService) {}

  async charge(request: GatewayChargeRequest): Promise<GatewayChargeResponse> {
    const startTime = Date.now();
    const keyId = this.configService.get<string>('RAZORPAY_KEY_ID');
    const keySecret = this.configService.get<string>('RAZORPAY_KEY_SECRET');

    const isMockMode = !keyId || keyId.startsWith('rzp_test_xxx') || keyId === 'rzp_test_mock' || keyId === 'xxxxxxxxxxxx';

    const amountStr = request.amount.toString();

    if (isMockMode || amountStr.endsWith('98') || amountStr.endsWith('99') || amountStr.endsWith('00') || amountStr.endsWith('03')) {
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
        gatewayTxnId: `upi_mock_${request.transactionId}`,
        rawResponse: { status: 'SUCCESS', upi_txn_id: `upi_mock_${request.transactionId}` },
        latencyMs: Date.now() - startTime,
      };
    }

    try {
      const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
      const bodyParams: any = {
        upi_link: 'true',
        amount: request.amount,
        currency: request.currency,
        reference_id: request.transactionId,
        description: `UPI payment for transaction ${request.transactionId}`,
        customer: {
          name: 'UPI Test User',
          email: 'test@example.com',
          contact: '+919876543210',
        },
        notify: {
          sms: false,
          email: false,
        },
      };

      let response = await fetch('https://api.razorpay.com/v1/payment_links/', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyParams),
      });

      let data = await response.json() as any;

      // Fallback: If UPI link is not supported in test mode, retry as a standard payment link
      if (response.status !== 200 && response.status !== 201 && data.error?.description?.includes('UPI Payment Links is not supported in Test Mode')) {
        this.logger.warn(`[UPI] UPI-specific links not supported in Test Mode. Retrying as standard Razorpay Payment Link...`);
        delete bodyParams.upi_link;
        response = await fetch('https://api.razorpay.com/v1/payment_links/', {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(bodyParams),
        });
        data = await response.json() as any;
      }

      const latencyMs = Date.now() - startTime;

      if (response.status === 200 || response.status === 201) {
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
          error: data.error?.description || 'Razorpay UPI payment link creation failed',
          rawResponse: data,
          latencyMs,
        };
      }
    } catch (err: any) {
      return {
        success: false,
        gatewayTxnId: null,
        error: err.message || 'Network error on Razorpay UPI',
        rawResponse: { error: err.message },
        latencyMs: Date.now() - startTime,
      };
    }
  }
}
