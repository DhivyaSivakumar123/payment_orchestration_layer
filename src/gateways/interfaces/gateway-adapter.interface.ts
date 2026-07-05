import { GatewayProvider } from '../../common/enums/transaction-state.enum';

export interface GatewayChargeRequest {
  transactionId: string;
  amount: number; // store in smallest currency unit (paise/cents)
  currency: string;
  idempotencyKey: string;
}

export interface GatewayChargeResponse {
  success: boolean;
  gatewayTxnId: string | null;
  rawResponse: Record<string, any>;
  error?: string;
  latencyMs: number;
}

export interface GatewayAdapter {
  provider: GatewayProvider;
  charge(request: GatewayChargeRequest): Promise<GatewayChargeResponse>;
}
