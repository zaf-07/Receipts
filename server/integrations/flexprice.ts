import { config } from '../config';

export function flexpriceEnabled(): boolean {
  return Boolean(config.flexprice.apiKey && config.flexprice.customerId);
}

/**
 * Mirror a metered event to Flexprice (POST /v1/events, x-api-key header).
 * Off unless FLEXPRICE_API_KEY and FLEXPRICE_CUSTOMER_ID are set. The local ledger stays the
 * source of truth for the credit gate, so a Flexprice outage never blocks or unblocks a send.
 * Not yet tested against a live Flexprice account.
 */
export function meterEvent(eventName: string, credits: number, ref: string | null): void {
  if (!flexpriceEnabled()) return;
  void fetch(`${config.flexprice.baseUrl.replace(/\/$/, '')}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.flexprice.apiKey },
    body: JSON.stringify({
      event_name: eventName,
      external_customer_id: config.flexprice.customerId,
      properties: { credits, ref: ref ?? '' },
    }),
    signal: AbortSignal.timeout(5000),
  })
    .then((res) => {
      if (!res.ok) console.warn(`[flexprice] ${eventName} rejected: HTTP ${res.status}`);
    })
    .catch((err) => console.warn(`[flexprice] ${eventName} failed: ${String(err)}`));
}
