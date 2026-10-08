# Monetization Gateway tools

A Node.js test client for Cloudflare Monetization Gateway. Version 1 supports
**Base mainnet, native USDC, x402 v2 `exact` / EIP-3009** only.

The flow is: request -> HTTP 402 -> validate and display payment terms -> type
`yes` in the terminal -> sign locally -> submit one paid request -> display the
API result and gateway receipt. Each paid invocation needs its own confirmation.
There is no unattended approval option and no automatic paid retry.

## Setup

Use Node.js 22.14+ (tested with Node 24):

```bash
npm ci
cp .env.example .env
chmod 600 .env
```

Edit `.env` locally. Set **one** of:

- `OWS_MNEMONIC`: the same mnemonic format as `nanopayment-x402`, using account
  `m/44'/60'/0'/0/0`. `X402_MNEMONIC` is also accepted.
- `X402_PRIVATE_KEY`: a 0x-prefixed 32-byte EOA private key.

Do not pass secrets in CLI arguments, commit `.env`, or paste them into chat.
No script generates, exports or copies a wallet secret. To intentionally reuse
another project's env file, pass `--env-file /absolute/path/to/.env`. Existing
shell environment variables take precedence over env files.

The wallet must hold **native USDC on Base (chain 8453)**:

```text
0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

Check its public address and balance:

```bash
npm run wallet
```

### How approval differs from Circle Gateway

The reference nanopayment project deposits USDC into Circle Gateway and uses
its contract/signing domain. This client instead signs a per-payment USDC
`TransferWithAuthorization` (EIP-3009) using the official x402 EVM SDK. The
facilitator submits settlement. **Do not run Circle's approve/deposit setup for
this flow.** Existing funds deposited into Circle Gateway are not spendable by
this client. No ERC-20 allowance transaction or unlimited approval is sent.

Typing `yes` authorizes a real mainnet payment signature, not just a preview.
The script does not require the buyer to send a gas-paying transaction for this
EIP-3009 authorization; funding or other wallet transactions are separate.

## Test the advertisement recommendation demo

From this project directory, using your existing local wallet configuration:

```bash
npm run inspect:advertisements
npm run pay:advertisements
```

Both commands use POST `/payments/cloudflare/v1/advertisements/recommendations`
and `examples/advertisements.json`. Inspect checks the quote without signing.
Pay displays the terms and requires terminal `yes` before a single real payment.
The shortcuts explicitly set `--max-usdc 0.10`, overriding `MAX_PAYMENT_USDC`
for this invocation only; other commands retain their existing caps. This is
a maximum, not a forced charge: the gateway quote determines the payment.

Edit the example JSON to change `brandName`, `campaignType` or `campaignBrief`.
All three must be non-empty strings. Use `campaignType`, not `campaign`.
The demo always returns the same five-platform fixture, including Facebook;
ROI, scores and ranking are illustrative and do not depend on these inputs.

After payment, the terminal JSON includes the API response under
`body.recommendations`, `body.ranking` and `body.topRecommendation`, alongside
the receipt, HTTP status and request ID. To save that output as valid JSON while
keeping the interactive confirmation visible, invoke Node directly (npm adds
its own banners to stdout):

```bash
node scripts/client.mjs pay POST \
  'https://api.aisa.one/payments/cloudflare/v1/advertisements/recommendations' \
  --body-file examples/advertisements.json --max-usdc 0.10 \
  > /tmp/aisa-advertisements-result.json
```

This command makes another real request; choose either it or the payment
shortcut for each test. After completion, open the file to view the business
response and receipt. It contains campaign results and public payment details,
not wallet secrets or raw payment signatures. Do not automatically rerun after
an uncertain payment result. If the server price changes, explicitly adjust
`--max-usdc` on a direct invocation after reviewing the new quote.

## Test a search API

YouTube Search is available through these shortcuts (0.004 USDC per request):

```bash
npm run inspect:search -- --query "agent payments"
npm run pay:search -- --query "agent payments"
```

The first command only inspects the 402 challenge. The second asks for terminal
`yes` before signing and submitting a single paid request. The search response
is printed under `body`, alongside the payment receipt.

Other search presets:

```bash
node scripts/client.mjs inspect --api twitter --query "OpenAI"
node scripts/client.mjs pay --api twitter --query "OpenAI"
node scripts/client.mjs inspect --api tavily --query "agent payments"
```

| Preset | Method and path after `/payments/cloudflare/v1/` | Price cap (USDC) |
| --- | --- | --- |
| `youtube` | GET `youtube/search?q=...` | 0.004 |
| `twitter` | GET `twitter/user/search?query=...` | 0.005 |
| `tavily` | POST `tavily/search` | 0.0144 |

Query text is URL-encoded. Tavily uses a JSON body with basic search and five
results. Presets cannot be combined with a custom URL or body. Each preset caps
payment at the listed price, or a lower `MAX_PAYMENT_USDC` if configured.
An explicit `--max-usdc` overrides that cap. The original `inspect` and `pay`
npm commands retain their Tavily defaults.

## Test Tavily

### 1. Inspect without paying

No wallet secret is required:

```bash
npm run inspect
```

The default request is:

```text
POST https://api.aisa.one/payments/cloudflare/v1/tavily/search
{"query":"agent payments","search_depth":"basic","max_results":5}
```

Expected terms: Base USDC, `exact`, 0.0144 USDC. This command never signs or sends
PAYMENT-SIGNATURE. A country-related 403 is an edge eligibility restriction;
a source authorization 403 can mean the monetization rule did not match.

### 2. Make one payment

```bash
npm run pay
```

The tool checks the wallet balance, prints the URL, method, wallet, recipient,
USDC contract, amount, authorization lifetime and request-body SHA-256, then asks:

```text
Type yes to sign and submit this one payment (anything else cancels):
```

Run this yourself in an interactive terminal. It refuses non-TTY execution.
It submits the same URL/method/body once with PAYMENT-SIGNATURE after approval.
No raw payment signature or wallet secret is printed.

### Custom request / additional APIs

```bash
node scripts/client.mjs inspect POST \
  'https://api.aisa.one/payments/cloudflare/v1/tavily/search' \
  --body-file examples/tavily.json

node scripts/client.mjs pay POST \
  'https://api.aisa.one/payments/cloudflare/v1/tavily/search' \
  --body '{"query":"agent payments","search_depth":"basic","max_results":5}' \
  --max-usdc 0.0144
```

Other enabled Cloudflare resources can be passed as `GET URL` or `POST URL`.
Their monetization rule and origin handler must already exist. This client does
not enable additional endpoints on the server. GET cannot include a body.
POST accepts JSON only; request bodies are limited to 1 MiB.

Use `--pay-to 0x...` or `EXPECTED_PAY_TO` (comma-separated addresses) to pin an
independently verified receiving wallet. Without that setting, the recipient
from the HTTPS challenge is displayed for your manual review before signing.

## Policy and configuration

| Setting | Default / behavior |
| --- | --- |
| `MAX_PAYMENT_USDC` / `--max-usdc` | 0.02 per request, at most six decimal places |
| `EXPECTED_PAY_TO` / `--pay-to` | Optional recipient allowlist |
| `BASE_RPC_URL` | `https://mainnet.base.org`; `OWS_RPC_BASE` also accepted |
| `--env-file` | `.env` in the current working directory |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | Applied to both endpoint and RPC requests; lowercase variants supported |

An example local HTTP proxy configuration:

```bash
export HTTP_PROXY=http://127.0.0.1:7897
export HTTPS_PROXY=http://127.0.0.1:7897
npm run inspect
```

The RPC's chain ID is checked before reading balance. A proxy or RPC URL that
contains credentials is never printed by the client. Runtime exceptions are
sanitized. Proxy routing does not establish buyer/seller eligibility; follow
Cloudflare's current beta requirements.

The client rejects other chains/assets, non-exact schemes, Circle signing
domains, Permit2, server extensions, mismatched resource URLs, excessive prices
and authorization lifetimes above one hour. HTTP redirects are disabled.
Quotes older than five minutes require a new inspection and confirmation.

## Results and failure handling

JSON results go to stdout; confirmation and diagnostics go to stderr.
`body` contains a parsed JSON value when the response is valid JSON, otherwise
the original response text.

- `receiptConfirmed: true` means the gateway header reports success with a
  Base transaction hash and the matching payer. It is **not** independent
  on-chain verification. Verify the transaction and resulting balance when
  completing end-to-end acceptance.
- HTTP 200 without a valid complete receipt does not confirm settlement.
- A paid 402, 403, 5xx, timeout, redirect or missing receipt never triggers a
  second signature or automatic retry. A failed response does not imply a refund.
- On a paid transport/body-read failure, execution and settlement are uncertain;
  check the wallet, gateway and seller logs before rerunning.
- The script shows `requestID` and `cfRay` when returned, plus receipt fields.
  Response display is capped at 5 MiB.

Exit codes: 0 for inspection/successful HTTP response with a matching reported
receipt/cancellation; 1 for validation, HTTP or unconfirmed-receipt failures;
2 for an ambiguous paid transport failure. Ctrl-C before signing cancels; after
submission, inspect settlement before retrying.

## Validation

```bash
npm test
node scripts/client.mjs --help
```

Tests use ephemeral local keys and mocked HTTP responses, including recovery of
a real SDK-generated EIP-3009 signature. They cover approval cancellation,
network/asset/domain/recipient/price policies, unconfirmed receipts, and no retry
on paid failure. They do not move funds. A real successful paid call must still
be tested by the operator after reviewing and approving its terms.

## References

- [Cloudflare x402 protocol](https://developers.cloudflare.com/monetization-gateway/x402/)
- [Cloudflare eligibility](https://developers.cloudflare.com/monetization-gateway/eligibility/)
- [Official x402 EVM exact client](https://github.com/coinbase/x402/tree/main/typescript/packages/mechanisms/evm/src/exact/client)

The local `../nanopayment-x402` project was used as a CLI/wallet workflow
reference. Its Circle-specific signing implementation and deposits are not used.
