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
`body` contains the original response text as an escaped JSON string.

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
