#!/usr/bin/env node
import { SEARCH_APIS, searchRequest, displayResult, searchPaymentCap } from '../src/search.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici';
import { ClientError, PaymentUncertainError, AP4MPaymentUnsupportedError, paymentRequest, inspectPayment, payOnce, paymentSummary } from '../src/payment.mjs';
import { loadWallet, walletBalance } from '../src/wallet.mjs';

const help = `Cloudflare Monetization Gateway client (Base mainnet USDC only)

node scripts/client.mjs inspect [METHOD URL] [options]   Fetch price, never sign
node scripts/client.mjs wallet [--env-file PATH]         Display address + USDC balance
node scripts/client.mjs pay [METHOD URL] [options]       Require terminal yes, then pay once

Defaults: POST https://api.aisa.one/payments/cloudflare/v1/tavily/search
          {"query":"agent payments","search_depth":"basic","max_results":5}

Options:
  --api NAME            Search preset: youtube, twitter, tavily (no METHOD URL)
  --query TEXT          Search text for --api (default: agent payments)
  --body JSON           JSON request body
  --body-file PATH      Read JSON body from a file
  --max-usdc AMOUNT      Per-request cap (default MAX_PAYMENT_USDC or 0.02)
  --pay-to ADDRESS      Require this recipient (or EXPECTED_PAY_TO comma-separated)
  --env-file PATH       Explicit local env file (default .env in current directory)
  --help                Show this help

No ERC-20 approve or Circle Gateway deposit is needed for this EIP-3009 flow.
Fund the signing wallet with native Base USDC. Pay has no unattended --yes mode.
HTTP(S)_PROXY and NO_PROXY (including lowercase variants) apply to API and RPC.
`;

async function main() {
  let parsed;
  try { parsed = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, api: { type: 'string' }, query: { type: 'string' }, body: { type: 'string' }, 'body-file': { type: 'string' },
    'max-usdc': { type: 'string' }, 'pay-to': { type: 'string' }, 'env-file': { type: 'string' },
  } }); } catch { throw new ClientError('Invalid arguments. Run with --help. Secrets are accepted only through environment variables.'); }
  const { values, positionals } = parsed;
  if (values.help || !positionals.length) { console.log(help); return; }
  const [command, method, url, ...extra] = positionals;
  if (!['inspect', 'pay', 'wallet'].includes(command) || extra.length || Boolean(method) !== Boolean(url)) throw new ClientError('Use inspect/pay [METHOD URL], or wallet. See --help.');
  if (command === 'wallet' && method) throw new ClientError('wallet does not accept an endpoint.');
  if ((values.api && (url || values.body !== undefined || values['body-file'] !== undefined || command === 'wallet')) || (values.query !== undefined && !values.api)) throw new ClientError('Use --api with optional --query, without METHOD URL or body options.');
  if (values.api && !Object.hasOwn(SEARCH_APIS, values.api)) throw new ClientError('Choose --api youtube, twitter, or tavily.');
  const envFile = values['env-file'] || '.env';
  if (values['env-file'] && !existsSync(envFile)) throw new ClientError('Requested env file does not exist.');
  if (existsSync(envFile)) {
    try { process.loadEnvFile(envFile); } catch { throw new ClientError('Unable to load local env file.'); }
  }
  // No global mutation of fetch and no logging of proxy/RPC URLs with credentials.
  const dispatcher = new EnvHttpProxyAgent();
  const fetcher = (url, options) => proxyFetch(url, { ...options, dispatcher });
  try {
    if (command === 'wallet') {
      const account = loadWallet();
      const balance = await walletBalance(account.address, fetcher);
      console.log(JSON.stringify({ address: account.address, chain: 'Base mainnet', usdc: balance.usdc }, null, 2));
      return;
    }
    if (values.body !== undefined && values['body-file'] !== undefined) throw new ClientError('Choose --body or --body-file, not both.');
    let body = values.body;
    if (values['body-file']) {
      try { body = readFileSync(values['body-file'], 'utf8'); } catch { throw new ClientError('Unable to read body file.'); }
    }
    const request = values.api ? searchRequest(values.api, values.query) : paymentRequest({ ...(url ? { url, method } : {}), body });
    let quote;
    try { quote = await inspectPayment(request, {
      // Presets cap payment at their published price; a stricter environment cap still applies.
      maxUSDC: searchPaymentCap(values.api, values['max-usdc'], process.env.MAX_PAYMENT_USDC),
      expectedPayTo: (values['pay-to'] || process.env.EXPECTED_PAY_TO || '').split(',').map(s => s.trim()).filter(Boolean),
    }, fetcher); } catch (error) {
      if (!(error instanceof AP4MPaymentUnsupportedError)) throw error;
      console.log(JSON.stringify({ endpoint: request.url, method: request.method,
        paymentRequired: true, supported: false, signed: false,
        options: error.options, message: error.message }, null, 2));
      // Stop before wallet loading, balance RPC, approval or signing.
      if (command === 'pay') process.exitCode = 1;
      return;
    }
    if (quote.kind === 'response') {
      console.log(JSON.stringify(displayResult(quote), null, 2));
      if (quote.status === 403) console.error('403 before signing: inspect the body for visitor-country restrictions or origin authorization errors.');
      if (quote.status >= 400) process.exitCode = 1;
      return;
    }
    if (command === 'inspect') {
      console.log(JSON.stringify({ ...paymentSummary(quote), paymentRequired: true, signed: false }, null, 2));
      return;
    }
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new ClientError('Payment requires an interactive terminal. Run inspect for a non-paying check.');
    const account = loadWallet();
    const balance = await walletBalance(account.address, fetcher);
    if (balance.raw < BigInt(quote.terms.amount)) throw new ClientError(`Insufficient wallet USDC: ${balance.usdc}. Circle Gateway deposits are not available to this payment flow.`);
    const result = await payOnce(quote, account, {
      fetcher,
      approve: async summary => {
        console.error(JSON.stringify({ ...summary, availableUSDC: balance.usdc }, null, 2));
        console.error('This authorizes a real Base mainnet USDC payment. No unlimited allowance or deposit.');
        const terminal = createInterface({ input: process.stdin, output: process.stderr });
        try { return (await terminal.question('Type yes to sign and submit this one payment (anything else cancels): ')).trim() === 'yes'; }
        finally { terminal.close(); }
      },
    });
    console.log(JSON.stringify(displayResult(result), null, 2));
    if (result.kind === 'paid-response') {
      if (result.receiptConfirmed) console.error('Gateway reports successful settlement. Receipt has not been independently checked on-chain.');
      else console.error('Settlement is not confirmed by a complete valid receipt. Check the wallet and seller logs before another attempt.');
      if (result.status >= 400 || !result.receiptConfirmed) process.exitCode = 1;
    }
  } finally { await dispatcher.close(); }
}

main().catch(error => {
  console.error(error instanceof ClientError ? error.message : 'Request failed. No automatic retry. Sensitive exception details are suppressed.');
  process.exitCode = error instanceof PaymentUncertainError ? 2 : 1;
});
