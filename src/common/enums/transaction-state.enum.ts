/**
 * Transaction lifecycle states.
 *
 * INITIATED      -> ROUTED
 * ROUTED         -> PROCESSING
 * PROCESSING     -> SUCCESS | FAILED | RETRY_PENDING
 * RETRY_PENDING  -> ROUTED (rerouted to next gateway in fallback list)
 * SUCCESS        -> RECONCILED (once webhook confirms)
 * FAILED         -> terminal
 * RECONCILED     -> terminal
 *
 * Only the StateMachine service should ever mutate `current_state`.
 * Every transition must be written to the audit_log table.
 */
export enum TransactionState {
  INITIATED = 'INITIATED',
  ROUTED = 'ROUTED',
  PROCESSING = 'PROCESSING',
  RETRY_PENDING = 'RETRY_PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  RECONCILED = 'RECONCILED',
}

/**
 * Explicit allow-list of valid transitions. The state machine service
 * checks every transition against this map before writing to the DB —
 * this is what prevents a late/duplicate webhook from moving a
 * terminal transaction backwards (e.g. RECONCILED -> PROCESSING).
 */
export const VALID_TRANSITIONS: Record<TransactionState, TransactionState[]> = {
  [TransactionState.INITIATED]: [TransactionState.ROUTED],
  [TransactionState.ROUTED]: [TransactionState.PROCESSING],
  [TransactionState.PROCESSING]: [
    TransactionState.SUCCESS,
    TransactionState.FAILED,
    TransactionState.RETRY_PENDING,
  ],
  [TransactionState.RETRY_PENDING]: [TransactionState.ROUTED, TransactionState.FAILED],
  [TransactionState.SUCCESS]: [TransactionState.RECONCILED],
  [TransactionState.FAILED]: [],
  [TransactionState.RECONCILED]: [],
};

export enum GatewayProvider {
  STRIPE = 'STRIPE',
  RAZORPAY = 'RAZORPAY',
  PAYU = 'PAYU',
  UPI = 'UPI',
}

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}
