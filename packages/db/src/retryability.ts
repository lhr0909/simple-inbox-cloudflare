export const DELIVERY_RETRYABILITIES = [
  'not_retryable',
  'retryable',
  'manual_confirmation_required',
] as const

export type DeliveryRetryability = (typeof DELIVERY_RETRYABILITIES)[number]

type MessageDeliveryState = {
  direction: 'inbound' | 'outbound'
  forwardState: 'failed' | 'forwarded' | 'not_applicable' | 'pending' | 'unknown'
  sendState: 'failed' | 'not_applicable' | 'queued' | 'sending' | 'sent' | 'unknown'
}

/**
 * Queued and unclaimed forwarding work is retryable. Once the durable claim
 * moves a delivery to an in-progress/unknown state, it requires manual
 * confirmation because the provider may already have accepted it.
 */
export function retryabilityForMessageState(message: MessageDeliveryState): DeliveryRetryability {
  if (message.direction === 'inbound') {
    if (message.forwardState === 'pending') return 'retryable'
    return message.forwardState === 'unknown' ? 'manual_confirmation_required' : 'not_retryable'
  }
  if (message.sendState === 'not_applicable') {
    throw new TypeError('Outbound messages require an outbound send state.')
  }
  return retryabilityForOutboundSendState(message.sendState)
}

export function retryabilityForOutboundSendState(
  state: 'failed' | 'queued' | 'sending' | 'sent' | 'unknown',
): DeliveryRetryability {
  if (state === 'queued') return 'retryable'
  if (state === 'sending' || state === 'unknown') return 'manual_confirmation_required'
  return 'not_retryable'
}
