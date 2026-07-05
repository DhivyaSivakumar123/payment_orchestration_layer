import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GatewayStats } from './entities/gateway-stats.entity';
import { StripeAdapter } from './adapters/stripe.adapter';
import { RazorpayAdapter } from './adapters/razorpay.adapter';
import { PayUAdapter } from './adapters/payu.adapter';
import { UpiAdapter } from './adapters/upi.adapter';
import { RoutingEngineService } from './routing-engine.service';
import { RedisModule } from '../redis/redis.module';
import { GatewaysController } from './gateways.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([GatewayStats]),
    RedisModule,
  ],
  controllers: [
    GatewaysController,
  ],
  providers: [
    StripeAdapter,
    RazorpayAdapter,
    PayUAdapter,
    UpiAdapter,
    RoutingEngineService,
  ],
  exports: [
    StripeAdapter,
    RazorpayAdapter,
    PayUAdapter,
    UpiAdapter,
    RoutingEngineService,
    TypeOrmModule,
  ],
})
export class GatewaysModule {}
