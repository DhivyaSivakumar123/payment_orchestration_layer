import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GatewayAdapter, GatewayChargeRequest, GatewayChargeResponse } from '../interfaces/gateway-adapter.interface';
import { GatewayProvider } from '../../common/enums/transaction-state.enum';
import * as crypto from 'crypto';

@Injectable()
export class PayUAdapter implements GatewayAdapter {
  readonly provider = GatewayProvider.PAYU;
  private readonly logger = new Logger(PayUAdapter.name);

  constructor(private readonly configService: ConfigService) {}

  async charge(request: GatewayChargeRequest): Promise<GatewayChargeResponse> {
    const startTime = Date.now();
    const key = this.configService.get<string>('PAYU_MERCHANT_KEY');
    const salt = this.configService.get<string>('PAYU_SALT');
    
    // In local unit tests or if keys are empty placeholders, we fallback to mock mode
    const isMockMode = !key || key.startsWith('payu_test_xxx') || key === 'xxxxxxxxxxxx';

    const amountStr = request.amount.toString();

    if (isMockMode || amountStr.endsWith('97') || amountStr.endsWith('02')) {
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
        gatewayTxnId: `payu_mock_${request.transactionId}`,
        rawResponse: { status: 'success', mihpayid: `payu_mock_${request.transactionId}` },
        latencyMs: Date.now() - startTime,
      };
    }

    try {
      const txnid = request.transactionId;
      // Convert amount from paise/cents to decimal major unit string
      const amountDecimal = (request.amount / 100).toFixed(2);
      const productinfo = `Transaction ${txnid}`;
      const firstname = 'MerchantTest';
      const email = 'test@example.com';
      const phone = '9999999999';
      const surl = 'https://localhost:3000/webhooks/payu';
      const furl = 'https://localhost:3000/webhooks/payu';

      // Hash formula: key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||salt
      const udf1 = '', udf2 = '', udf3 = '', udf4 = '', udf5 = '';
      const hashSequence = `${key}|${txnid}|${amountDecimal}|${productinfo}|${firstname}|${email}|${udf1}|${udf2}|${udf3}|${udf4}|${udf5}||||||${salt}`;
      const hash = crypto.createHash('sha512').update(hashSequence).digest('hex');

      const response = await fetch('https://test.payu.in/_payment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          key,
          txnid,
          amount: amountDecimal,
          productinfo,
          firstname,
          email,
          phone,
          surl,
          furl,
          hash,
          service_provider: 'payu_paisa',
        }),
      });

      const latencyMs = Date.now() - startTime;
      const responseText = await response.text();

      // In sandbox mode, _payment returns redirect HTML (200 OK)
      if (response.status === 200 || response.status === 302) {
        return {
          success: true,
          gatewayTxnId: txnid,
          rawResponse: { 
            status: 'initiated', 
            htmlSnippet: responseText.substring(0, 500), 
            statusCode: response.status 
          },
          latencyMs,
        };
      } else {
        return {
          success: false,
          gatewayTxnId: null,
          error: `PayU returned status code ${response.status}`,
          rawResponse: { error: responseText },
          latencyMs,
        };
      }
    } catch (err: any) {
      return {
        success: false,
        gatewayTxnId: null,
        error: err.message || 'Network error on PayU',
        rawResponse: { error: err.message },
        latencyMs: Date.now() - startTime,
      };
    }
  }
}
