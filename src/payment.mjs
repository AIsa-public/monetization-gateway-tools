import { createHash } from 'node:crypto';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { isAddress, formatUnits } from 'viem';

export const NETWORK = 'eip155:8453';
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const DEFAULT_URL = 'https://api.aisa.one/payments/cloudflare/v1/tavily/search';
export const DEFAULT_BODY = '{"query":"agent payments","search_depth":"basic","max_results":5}';

export class ClientError extends Error {}
export class PaymentUncertainError extends ClientError {}

export function usdcMicros(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) {
    throw new ClientError('USDC amount must be a decimal with at most six decimal places.');
  }
  const [whole, fraction = ''] = value.split('.');
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (micros <= 0n) throw new ClientError('USDC amount must be positive.');
  return micros;
}

export function paymentRequest({ url = DEFAULT_URL, method = 'POST', body } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new ClientError('A valid HTTPS endpoint URL is required.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new ClientError('Endpoint must use HTTPS, without URL credentials or a fragment.');
  }
  method = method.toUpperCase();
  if (body === undefined && method === 'POST' && parsed.href === DEFAULT_URL) body = DEFAULT_BODY;
  if (!['GET', 'POST'].includes(method)) throw new ClientError('Only GET and POST are supported in v1.');
  if (method === 'GET' && body !== undefined) throw new ClientError('GET requests cannot include a body.');
  if (body !== undefined) {
    if (typeof body !== 'string' || Buffer.byteLength(body) > 1024 * 1024) throw new ClientError('JSON body must be a string of at most 1 MiB.');
    try { JSON.parse(body); } catch { throw new ClientError('Request body must be valid JSON.'); }
  }
  return Object.freeze({ url: parsed.href, method, body });
}

export async function readBody(response, limit = 5 * 1024 * 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new ClientError('Response exceeds the 5 MiB display limit.');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

export function selectRequirements(challenge, request, { maxUSDC = '0.02', expectedPayTo = [] } = {}) {
  const cap = usdcMicros(maxUSDC);
  if (challenge?.x402Version !== 2 || !Array.isArray(challenge.accepts)) throw new ClientError('Expected an x402 v2 payment challenge.');
  if (challenge.resource?.url !== request.url) throw new ClientError('Payment resource URL does not match the requested endpoint.');
  if (expectedPayTo.some(address => !isAddress(address))) throw new ClientError('EXPECTED_PAY_TO must contain valid EVM addresses.');
  const candidates = challenge.accepts.filter(r => r?.scheme === 'exact' && r.network === NETWORK && typeof r.asset === 'string' && r.asset.toLowerCase() === USDC.toLowerCase());
  if (!candidates.length) throw new ClientError('No supported Base mainnet USDC exact option. Circle batching, Permit2 and other chains are not supported.');
  // Select only the EIP-3009 USDC contract, never a server-supplied Gateway or Permit2 domain.
  const selected = candidates.find(r =>
    typeof r.amount === 'string' && /^[1-9]\d{0,15}$/.test(r.amount) && BigInt(r.amount) <= cap &&
    isAddress(r.payTo) && !/^0x0{40}$/i.test(r.payTo) &&
    Number.isSafeInteger(r.maxTimeoutSeconds) && r.maxTimeoutSeconds > 0 && r.maxTimeoutSeconds <= 3600 &&
    r.extra?.name === 'USD Coin' && r.extra?.version === '2' &&
    (!r.extra.assetTransferMethod || r.extra.assetTransferMethod === 'eip3009') &&
    (!r.extra.verifyingContract || (typeof r.extra.verifyingContract === 'string' && r.extra.verifyingContract.toLowerCase() === USDC.toLowerCase())) &&
    (!expectedPayTo.length || expectedPayTo.some(a => a.toLowerCase() === r.payTo.toLowerCase()))
  );
  if (!selected) throw new ClientError('Payment terms rejected: check cap, recipient, USDC domain and authorization lifetime (maximum 3600 seconds).');
  // Copy only approved fields. No server extensions or automatic approvals.
  return Object.freeze({ scheme: 'exact', network: NETWORK, asset: USDC, amount: selected.amount, payTo: selected.payTo,
    maxTimeoutSeconds: selected.maxTimeoutSeconds, extra: Object.freeze({ name: 'USD Coin', version: '2' }) });
}

function requestOptions(request, signature) {
  return { method: request.method, body: request.body,
    headers: { Accept: 'application/json', ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(signature ? { 'PAYMENT-SIGNATURE': signature } : {}) },
    redirect: 'error', signal: AbortSignal.timeout(120_000) };
}

export async function inspectPayment(request, policy, fetcher) {
  let response;
  try { response = await fetcher(request.url, requestOptions(request)); }
  catch { throw new ClientError('Initial request failed (network, TLS, timeout or redirect). No payment was signed. Check proxy settings.'); }
  const body = await readBody(response);
  if (response.status !== 402) return { kind: 'response', status: response.status, body };
  const encoded = response.headers.get('payment-required');
  if (!encoded || encoded.length > 65536) throw new ClientError('402 response has a missing or oversized PAYMENT-REQUIRED header.');
  let challenge;
  try { challenge = decodePaymentRequiredHeader(encoded); } catch { throw new ClientError('Invalid PAYMENT-REQUIRED encoding.'); }
  const terms = selectRequirements(challenge, request, policy);
  return Object.freeze({ kind: 'payment', request, terms, inspectedAt: Date.now() });
}

export function paymentSummary(quote, address) {
  return { endpoint: quote.request.url, method: quote.request.method, wallet: address,
    network: 'Base mainnet (8453)', asset: USDC, amountUSDC: formatUnits(BigInt(quote.terms.amount), 6),
    recipient: quote.terms.payTo, authorizationSeconds: quote.terms.maxTimeoutSeconds,
    bodySHA256: createHash('sha256').update(quote.request.body ?? '').digest('hex') };
}

export async function payOnce(quote, signer, { approve, fetcher }) {
  if (quote.kind !== 'payment') throw new ClientError('Inspect payment requirements first.');
  const approved = await approve(paymentSummary(quote, signer.address));
  if (approved !== true) return { kind: 'cancelled' };
  // Do not silently fetch a fresh quote or change terms after human approval.
  if (Date.now() - quote.inspectedAt > 5 * 60_000) throw new ClientError('Quote is over five minutes old. Inspect and approve again.');
  const client = new x402Client().register(NETWORK, new ExactEvmScheme(signer));
  let payload;
  try {
    payload = await client.createPaymentPayload({ x402Version: 2, resource: { url: quote.request.url }, accepts: [quote.terms] });
  } catch { throw new ClientError('Local signing failed. No signed request was submitted. Check the wallet configuration.'); }
  const signature = encodePaymentSignatureHeader(payload);
  let response, body;
  try {
    response = await fetcher(quote.request.url, requestOptions(quote.request, signature));
    body = await readBody(response);
  } catch {
    throw new PaymentUncertainError('Paid request interrupted. Execution/settlement may have occurred. Do not automatically retry; check the wallet and seller logs.');
  }
  let receipt = null;
  const encoded = response.headers.get('payment-response');
  if (encoded && encoded.length <= 65536) {
    try {
      const decoded = decodePaymentResponseHeader(encoded);
      // A gateway header is a reported receipt, not independent on-chain confirmation.
      receipt = { success: decoded.success === true, network: decoded.network,
        transaction: decoded.transaction, payer: decoded.payer, errorReason: decoded.errorReason };
    } catch { /* treat a malformed receipt as unconfirmed, never as successful settlement */ }
  }
  const receiptConfirmed = receipt?.success === true && receipt.network === NETWORK && /^0x[0-9a-f]{64}$/i.test(receipt.transaction ?? '') && receipt.payer?.toLowerCase() === signer.address.toLowerCase();
  return { kind: 'paid-response', status: response.status, body, receipt, receiptConfirmed: Boolean(receiptConfirmed),
    requestID: response.headers.get('x-request-id'), cfRay: response.headers.get('cf-ray') };
}
