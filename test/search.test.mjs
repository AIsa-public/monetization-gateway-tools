import test from 'node:test';
import assert from 'node:assert/strict';
import { searchRequest, displayResult, searchPaymentCap } from '../src/search.mjs';
import { inspectPayment } from '../src/payment.mjs';
import { encodePaymentRequiredHeader } from '@x402/core/http';

test('search presets encode query as data and preserve GET without body', () => {
  for (const [api, key] of [['youtube', 'q'], ['twitter', 'query']]) {
    const req = searchRequest(api, '支付 & engine=google + #测试');
    const url = new URL(req.url);
    assert.equal(req.method, 'GET');
    assert.equal(req.body, undefined);
    assert.equal(url.searchParams.get(key), '支付 & engine=google + #测试');
    assert.equal(url.searchParams.has('engine'), false);
    assert.equal(url.hash, '');
  }
  assert.equal(JSON.parse(searchRequest('tavily', 'test').body).query, 'test');
  assert.throws(() => searchRequest('unknown'));
  assert.throws(() => searchRequest('youtube', '  '));
});

test('YouTube query-bearing challenge validates without wallet or signature', async () => {
  const req = searchRequest('youtube');
  const quote = await inspectPayment(req, { maxUSDC: '0.004' }, async (url, options) => {
    assert.equal(url, req.url);
    assert.equal(options.method, 'GET');
    const challenge = { x402Version: 2, resource: { url }, accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '4000', payTo: '0xBd7b9f3e0CD3E1f6e698D0eeBb99F96E093BdeE3', maxTimeoutSeconds: 3600, extra: { name: 'USD Coin', version: '2' } }] };
    return new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(challenge) } });
  });
  assert.equal(quote.terms.amount, '4000');
});

test('display exposes readable business JSON while preserving receipt and errors', () => {
  const value = { status: 200, receiptConfirmed: true, body: '{"videos":[{"title":"test"}]}' };
  assert.equal(displayResult(value).body.videos[0].title, 'test');
  assert.equal(displayResult(value).receiptConfirmed, true);
  assert.equal(typeof value.body, 'string');
  assert.equal(displayResult({ body: '<html>error</html>' }).body, '<html>error</html>');
});

test('preset payment caps preserve lower operator caps and validate amounts', () => {
  assert.equal(searchPaymentCap('youtube'), '0.004');
  assert.equal(searchPaymentCap('twitter', undefined, '0.001'), '0.001');
  assert.equal(searchPaymentCap('youtube', '0.006', '0.001'), '0.006');
  assert.equal(searchPaymentCap(undefined), '0.02');
  assert.throws(() => searchPaymentCap('youtube', undefined, 'oops'));
  assert.throws(() => searchPaymentCap('youtube', '-1'));
  assert.throws(() => searchRequest('toString'));
});
