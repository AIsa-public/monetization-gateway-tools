import { ClientError, paymentRequest, usdcMicros } from './payment.mjs';

export const SEARCH_APIS = Object.freeze({
  youtube: { path: 'youtube/search', parameter: 'q', price: '0.004' },
  twitter: { path: 'twitter/user/search', parameter: 'query', price: '0.005' },
  tavily: { path: 'tavily/search', price: '0.0144' },
});

export function searchRequest(api, query = 'agent payments') {
  const preset = SEARCH_APIS[api];
  if (!Object.hasOwn(SEARCH_APIS, api)) throw new ClientError('Choose --api youtube, twitter, or tavily.');
  if (typeof query !== 'string' || !query.trim()) throw new ClientError('--query must not be empty.');
  const url = new URL('https://api.aisa.one/payments/cloudflare/v1/' + preset.path);
  if (api === 'tavily') return paymentRequest({ url: url.href, method: 'POST', body: JSON.stringify({ query, search_depth: 'basic', max_results: 5 }) });
  url.searchParams.set(preset.parameter, query);
  return paymentRequest({ url: url.href, method: 'GET' });
}

// Display JSON business results as a readable object; preserve non-JSON text.
// This only changes terminal formatting, never the signed request or receipt.
export function displayResult(result) {
  if (typeof result.body !== 'string') return result;
  try { return { ...result, body: JSON.parse(result.body) }; }
  catch { return result; }
}

export function searchPaymentCap(api, explicit, environment) {
  if (explicit !== undefined) { usdcMicros(explicit); return explicit; }
  const cap = environment || '0.02';
  const micros = usdcMicros(cap);
  if (!api) return cap;
  if (!Object.hasOwn(SEARCH_APIS, api)) throw new ClientError('Unknown search API.');
  const price = SEARCH_APIS[api].price;
  return micros < usdcMicros(price) ? cap : price;
}
