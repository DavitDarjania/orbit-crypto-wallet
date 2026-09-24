# Orbit Wallet

A local self-custody wallet interface built on Tether WDK. Users can register with a username and password, log in, back up a generated recovery phrase, restore a wallet from that phrase, see/copy public addresses for each supported network, read balances, send native assets after an explicit confirmation, and search/filter supported assets.

## Run locally

Use Node.js 20 or newer:

```sh
npm start
```

Open http://localhost:4173. The server binds to `127.0.0.1`. Local account records live in `.orbit-data/accounts.json`, which is excluded from Git. Passwords are not stored; a scrypt-derived key encrypts each recovery phrase with AES-256-GCM. Sessions and transaction activity stay in process memory and are cleared when you lock the wallet or stop the server. Save the recovery phrase offline. Anyone who has it can control the wallet. You can reveal it again under Security & Recovery after confirming your password.

Local account records live in `.orbit-data/accounts.json`; hosted accounts use Upstash Redis. Back up the local data and recovery phrases securely. On Vercel, the encrypted recovery phrase stays encrypted in Redis. While a wallet is unlocked, the browser keeps the password in memory and sends it to the API over HTTPS so each function invocation can decrypt the phrase and recreate its WDK accounts. The password is not saved in browser storage or Redis. Lock the wallet before closing a shared device.

## Deploy to Vercel

The project includes a Vercel function adapter in `api/[...path].js`; `public/` is served as the static frontend. Vercel installs the exact `package-lock.json` dependency tree with `npm ci --legacy-peer-deps`, which avoids re-resolving the WDK packages' optional peer dependencies during deployment. The local `node server.js` path remains available for development.

1. Create an Upstash Redis database and copy its REST URL and token.
2. Import this repository into Vercel with the project root set to this directory. The build command is `npm run build`; the output directory is `public`.
3. Add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in Vercel Project Settings → Environment Variables for each environment you will deploy.
4. Add any private RPC and WDK indexer keys there as needed. Do not commit `.env` or paste credentials into source code.
5. Redeploy after setting the variables. Registration and login return a configuration error until hosted Redis is connected.

User records contain only password-encrypted seed phrases. Hosted session records contain the username and recent session activity, not the recovery phrase. The function receives the password over HTTPS for each authenticated request and disposes its WDK instance after the request. Vercel/Upstash access is therefore part of the wallet trust boundary; this hosted prototype still needs an independent security review before holding real funds.

## Networks

The app defaults to Sepolia, Polygon Amoy, Arbitrum Sepolia, Solana Devnet, Bitcoin Testnet, and TRON Shasta. You can configure RPC URLs with `ETHEREUM_RPC_URL`, `POLYGON_RPC_URL`, `ARBITRUM_RPC_URL`, `SOLANA_RPC_URL`, `BITCOIN_RPC_URL`, and `TRON_RPC_URL`. `BITCOIN_RPC_URL` must point to a Blockbook API endpoint. `BITCOIN_NETWORK` accepts `bitcoin`, `testnet`, or `regtest`.

The frontend identifies configured RPCs and test networks. The server uses `TEST_KEY` (or `TES_KEY`) for the current test-network configuration and `PRODUCTION_KEY` for a mainnet configuration when querying Tether's WDK Indexer. The indexer only returns history for networks and assets in its live catalog; this app currently gets Sepolia USD₮ history, while native coin transfers and unsupported test networks are not indexed. Local session sends are also shown. Keep indexer keys in `.env`; they are only sent from the server. This prototype does not calculate USD prices. Swap and fiat purchase screens stay unavailable until an execution provider and its credentials are configured. Those integrations also need explicit chain/token support, regional eligibility, and transaction review before production use.

## Current boundaries

- Username/password registration, login, and recovery use local files in development and Upstash Redis when deployed to Vercel. There is no email verification or password-reset service.
- Send currently supports native assets on the registered networks. Token transfers require token selection and token-specific contract/decimal validation before they should be exposed.
- Activity is held in memory for the unlocked session; older history needs an indexing provider.
- Public testnet RPCs may be rate limited or unavailable. Production networks are not enabled by default.
- The WDK packages in this project are beta releases. Review WDK and provider configuration, security controls, backup UX, transaction validation, and operational monitoring before handling real funds.
