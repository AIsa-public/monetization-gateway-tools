import test from 'node:test';
import assert from 'node:assert/strict';
import { walletBalance } from '../src/wallet.mjs';

const wallet = '0x1111111111111111111111111111111111111111';
test('balance checks Base chain before reading USDC through the provided transport', async () => {
  const methods = [];
  const balance = await walletBalance(wallet, async (_url, options) => {
    const request = JSON.parse(options.body);
    methods.push(request.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: request.method === 'eth_chainId' ? '0x2105' : '0x' + (14400n).toString(16).padStart(64, '0') }), { headers: { 'Content-Type': 'application/json' } });
  }, {});
  assert.deepEqual(methods, ['eth_chainId', 'eth_call']);
  assert.equal(balance.usdc, '0.0144');
});

test('wrong RPC chain fails without reading balance', async () => {
  let calls = 0;
  await assert.rejects(walletBalance(wallet, async (_url, options) => {
    calls++;
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x1' }));
  }, {}), /other than Base/);
  assert.equal(calls, 1);
});
