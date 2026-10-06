import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, formatUnits, erc20Abi } from 'viem';
import { base } from 'viem/chains';
import { ClientError, USDC } from './payment.mjs';

export function loadWallet(env = process.env) {
  const mnemonic = env.OWS_MNEMONIC?.trim() || env.X402_MNEMONIC?.trim();
  const key = env.X402_PRIVATE_KEY?.trim();
  if (mnemonic && key) throw new ClientError('Configure only one of OWS_MNEMONIC or X402_PRIVATE_KEY.');
  if (!mnemonic && !key) throw new ClientError('Set OWS_MNEMONIC or X402_PRIVATE_KEY in your local .env. Never paste secrets into chat or command arguments.');
  try { return mnemonic ? mnemonicToAccount(mnemonic) : privateKeyToAccount(key); }
  catch { throw new ClientError('Invalid wallet secret. Check your local configuration; the secret has not been printed.'); }
}

export async function walletBalance(address, fetcher, env = process.env) {
  const rpc = env.BASE_RPC_URL || env.OWS_RPC_BASE || 'https://mainnet.base.org';
  let url;
  try { url = new URL(rpc); } catch { throw new ClientError('Invalid BASE_RPC_URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ClientError('BASE_RPC_URL must be HTTP(S).');
  const client = createPublicClient({ chain: base, transport: http(rpc, { fetchFn: fetcher, retryCount: 0, timeout: 15000 }) });
  try {
    if (await client.getChainId() !== base.id) throw new ClientError('RPC returned a chain other than Base mainnet.');
    const balance = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
    return { raw: balance, usdc: formatUnits(balance, 6) };
  } catch (error) {
    if (error instanceof ClientError) throw error;
    throw new ClientError('Could not read Base USDC balance. Check your RPC and proxy; RPC credentials are not printed.');
  }
}
