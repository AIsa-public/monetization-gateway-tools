import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import { DEFAULT_URL, USDC, NETWORK, usdcMicros, paymentRequest, inspectPayment, payOnce, PaymentUncertainError } from '../src/payment.mjs';
import { loadWallet } from '../src/wallet.mjs';

const recipient = '0x1111111111111111111111111111111111111111';
const terms = { scheme: 'exact', network: NETWORK, amount: '14400', asset: USDC, payTo: recipient,
  maxTimeoutSeconds: 3600, extra: { name: 'USD Coin', version: '2' } };
const challenge = (patch = {}, termPatch = {}) => ({ x402Version: 2, resource: { url: DEFAULT_URL }, accepts: [{ ...terms, ...termPatch }], ...patch });
const response402 = c => new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(c) } });
const quote = async (c = challenge(), policy = {}) => inspectPayment(paymentRequest(), policy, async () => response402(c));

test('inspect Base USDC without loading a wallet or signing', async () => {
  const result = await quote();
  assert.equal(result.kind, 'payment');
  assert.equal(result.terms.amount, '14400');
  assert.equal(result.terms.asset, USDC);
});

for (const [name, patch] of Object.entries({
  chain: { network: 'eip155:1' }, asset: { asset: recipient }, scheme: { scheme: 'upto' },
  price: { amount: '20001' }, numericAmount: { amount: 14400 }, negative: { amount: '-1' },
  zero: { amount: '0' }, scientific: { amount: '1e4' },
  recipient: { payTo: 'bad-address' }, zeroRecipient: { payTo: '0x0000000000000000000000000000000000000000' },
  timeout: { maxTimeoutSeconds: 3601 }, negativeTimeout: { maxTimeoutSeconds: -1 },
  gateway: { extra: { name: 'GatewayWalletBatched', version: '1' } },
  permit2: { extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2' } },
  contract: { extra: { name: 'USD Coin', version: '2', verifyingContract: recipient } },
})) test(`reject unsupported/unsafe ${name} before signing`, async () => { await assert.rejects(quote(challenge({}, patch))); });

test('resource, version and independent recipient allowlist are enforced', async () => {
  await assert.rejects(quote(challenge({ resource: { url: 'https://other.example' } })));
  await assert.rejects(quote(challenge({ x402Version: 1 })));
  await assert.rejects(quote(challenge(), { expectedPayTo: [USDC] }));
  assert.equal((await quote(challenge(), { expectedPayTo: [recipient] })).kind, 'payment');
});

test('reject malformed challenge header and unsupported responses without signing', async () => {
  await assert.rejects(inspectPayment(paymentRequest(), {}, async () => new Response('{}', { status: 402 })));
  await assert.rejects(inspectPayment(paymentRequest(), {}, async () => new Response('{}', { status: 402, headers: { 'payment-required': 'invalid' } })));
  const response = await inspectPayment(paymentRequest(), {}, async () => new Response('{"message":"disallowed visitor country"}', { status: 403 }));
  assert.equal(response.status, 403);
  assert.equal(response.kind, 'response');
});

test('cancellation and stale quotes never sign or send a payment', async () => {
  let calls = 0;
  const signer = { address: recipient, signTypedData: async () => { calls++; throw new Error('must not sign'); } };
  const fetcher = async () => { calls++; throw new Error('must not send'); };
  assert.equal((await payOnce(await quote(), signer, { approve: async () => false, fetcher })).kind, 'cancelled');
  await assert.rejects(payOnce({ ...await quote(), inspectedAt: 0 }, signer, { approve: async () => true, fetcher }), /five minutes/);
  assert.equal(calls, 0);
});

test('yes signs the actual USDC EIP-3009 domain and submits exactly once', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  let calls = 0, approvals = 0;
  const inspected = await quote();
  const result = await payOnce(inspected, account, {
    approve: async summary => { approvals++; assert.equal(summary.amountUSDC, '0.0144'); assert.equal(summary.recipient, recipient); return true; },
    fetcher: async (url, options) => {
      calls++;
      assert.equal(approvals, 1);
      assert.equal(url, DEFAULT_URL);
      assert.equal(options.redirect, 'error');
      assert.equal(options.body, inspected.request.body);
      const signed = decodePaymentSignatureHeader(options.headers['PAYMENT-SIGNATURE']);
      assert.equal(signed.accepted.network, NETWORK);
      assert.equal(signed.accepted.payTo, recipient);
      const { authorization, signature } = signed.payload;
      assert.equal(authorization.value, '14400');
      const recovered = await recoverTypedDataAddress({
        domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
        types: { TransferWithAuthorization: [
          { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
        ] }, primaryType: 'TransferWithAuthorization', message: authorization, signature,
      });
      assert.equal(recovered, account.address);
      return new Response('{"results":[]}', { headers: { 'PAYMENT-RESPONSE': encodePaymentResponseHeader({ success: true, network: NETWORK, payer: account.address, transaction: '0x' + 'a'.repeat(64) }) } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 200);
  assert.equal(result.receiptConfirmed, true);
});

test('network failure after approval is ambiguous, never retried', async () => {
  let calls = 0;
  await assert.rejects(payOnce(await quote(), privateKeyToAccount(generatePrivateKey()), {
    approve: async () => true, fetcher: async () => { calls++; throw new Error('timeout'); },
  }), PaymentUncertainError);
  assert.equal(calls, 1);
});

for (const status of [200, 402, 500]) test(`paid HTTP ${status} without a receipt is not settlement confirmation or another payment`, async () => {
  let calls = 0;
  const result = await payOnce(await quote(), privateKeyToAccount(generatePrivateKey()), {
    approve: async () => true, fetcher: async () => { calls++; return new Response('{}', { status }); },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, status);
  assert.equal(result.receiptConfirmed, false);
});

test('GET preserves the exact query and has no body; HTTPS only', () => {
  const req = paymentRequest({ method: 'GET', url: 'https://example.com/test?q=a%20b' });
  assert.equal(req.body, undefined);
  assert.equal(req.url, 'https://example.com/test?q=a%20b');
  for (const url of ['http://example.com', 'https://secret@example.com', 'https://example.com/#fragment']) assert.throws(() => paymentRequest({ url }));
  assert.throws(() => paymentRequest({ body: 'not-json' }));
});

test('decimal caps use integer micros, never floating point', () => {
  assert.equal(usdcMicros('0.0144'), 14400n);
  for (const invalid of ['1e-2', '-1', '0', '0.0000001', 'NaN']) assert.throws(() => usdcMicros(invalid));
});

test('wallet errors never print secret values', () => {
  assert.throws(() => loadWallet({ X402_PRIVATE_KEY: 'secret-invalid' }), error => !error.message.includes('secret-invalid'));
  assert.throws(() => loadWallet({ OWS_MNEMONIC: 'secret-phrase', X402_PRIVATE_KEY: 'secret-key' }), /only one/);
});
