import { Body, Controller, Headers, HttpCode, Post, Req, Logger } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { GatewayProvider } from '../common/enums/transaction-state.enum';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly configService: ConfigService,
  ) {}

  @Post('stripe')
  @HttpCode(200)
  async stripe(
    @Body() body: any,
    @Req() req: any,
    @Headers('stripe-signature') signature?: string,
  ) {
    const secret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    const isPlaceholder = !secret || secret.startsWith('whsec_xxx');

    let verified = false;
    if (isPlaceholder) {
      this.logger.log('[STRIPE WEBHOOK] Skipping signature check due to placeholder secret key');
      verified = true; // allow in mock/local test mode
    } else if (signature && req.rawBody) {
      verified = this.verifyStripeSignature(req.rawBody.toString('utf8'), signature, secret!);
    }

    if (!verified) {
      this.logger.error('[STRIPE WEBHOOK] Webhook signature verification failed');
      return { received: false, error: 'Signature verification failed' };
    }

    const result = await this.webhooksService.ingest({
      gateway: GatewayProvider.STRIPE,
      eventId: body?.id ?? 'unknown',
      eventType: body?.type ?? 'unknown',
      payload: body,
      signatureVerified: verified,
    });
    
    return { received: true, duplicate: result.duplicate };
  }

  @Post('razorpay')
  @HttpCode(200)
  async razorpay(
    @Body() body: any,
    @Req() req: any,
    @Headers('x-razorpay-signature') signature?: string,
  ) {
    const secret = this.configService.get<string>('RAZORPAY_KEY_SECRET');
    const isPlaceholder = !secret || secret.startsWith('rzp_test_xxx') || secret === 'xxxxxxxxxxxx';

    let verified = false;
    if (isPlaceholder) {
      this.logger.log('[RAZORPAY WEBHOOK] Skipping signature check due to placeholder secret key');
      verified = true;
    } else if (signature && req.rawBody) {
      verified = this.verifyRazorpaySignature(req.rawBody.toString('utf8'), signature, secret!);
    }

    if (!verified) {
      this.logger.error('[RAZORPAY WEBHOOK] Webhook signature verification failed');
      return { received: false, error: 'Signature verification failed' };
    }

    const result = await this.webhooksService.ingest({
      gateway: GatewayProvider.RAZORPAY,
      eventId: body?.id ?? body?.event_id ?? 'unknown',
      eventType: body?.event ?? 'unknown',
      payload: body,
      signatureVerified: verified,
    });

    return { received: true, duplicate: result.duplicate };
  }

  private verifyStripeSignature(rawBody: string, signature: string, secret: string): boolean {
    try {
      const parts = signature.split(',');
      const timestampPart = parts.find(p => p.startsWith('t='));
      const signaturePart = parts.find(p => p.startsWith('v1='));
      if (!timestampPart || !signaturePart) return false;

      const timestamp = timestampPart.split('=')[1];
      const stripeSig = signaturePart.split('=')[1];

      const signedPayload = `${timestamp}.${rawBody}`;
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(signedPayload)
        .digest('hex');

      const stripeSigBuf = Buffer.from(stripeSig, 'hex');
      const expectedSigBuf = Buffer.from(expectedSig, 'hex');

      if (stripeSigBuf.length !== expectedSigBuf.length) {
        return false;
      }
      return crypto.timingSafeEqual(stripeSigBuf, expectedSigBuf);
    } catch {
      return false;
    }
  }

  private verifyRazorpaySignature(rawBody: string, signature: string, secret: string): boolean {
    try {
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

      const sigBuf = Buffer.from(signature, 'hex');
      const expectedSigBuf = Buffer.from(expectedSig, 'hex');

      if (sigBuf.length !== expectedSigBuf.length) {
        return false;
      }
      return crypto.timingSafeEqual(sigBuf, expectedSigBuf);
    } catch {
      return false;
    }
  }
}
