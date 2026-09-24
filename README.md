# Orbit Wallet

A local self-custody wallet interface built on Tether WDK. Users can register with a username and password, log in, back up a generated recovery phrase, restore a wallet from that phrase, see/copy public addresses for each supported network, read balances, send native assets after an explicit confirmation, and search/filter supported assets.

## Run locally

Use Node.js 20 or newer:

```sh
npm start
```

Open http://localhost:4173. The server binds to `127.0.0.1`. Local account records live in `.orbit-data/accounts.json`, which is excluded from Git. Passwords are not stored; a scrypt-derived key encrypts each recovery phrase with AES-256-GCM. Sessions and transaction activity stay in process memory and are cleared when you lock the wallet or stop the server. Save the recovery phrase offline. Anyone who has it can control the wallet. You can reveal it again under Security & Recovery after confirming your password.

This account system is intended for one user's local device. It is not a hosted, multi-user authentication service and should not be exposed to the internet as-is. Back up `.orbit-data` and recovery phrases securely.

## Networks

The app defaults to Sepolia, Polygon Amoy, Arbitrum Sepolia, Solana Devnet, Bitcoin Testnet, and TRON Shasta. You can configure RPC URLs with `ETHEREUM_RPC_URL`, `POLYGON_RPC_URL`, `ARBITRUM_RPC_URL`, `SOLANA_RPC_URL`, `BITCOIN_RPC_URL`, and `TRON_RPC_URL`. `BITCOIN_RPC_URL` must point to a Blockbook API endpoint. `BITCOIN_NETWORK` accepts `bitcoin`, `testnet`, or `regtest`.

The frontend identifies configured RPCs and test networks. The server uses `TEST_KEY` (or `TES_KEY`) for the current test-network configuration and `PRODUCTION_KEY` for a mainnet configuration when querying Tether's WDK Indexer. The indexer only returns history for networks and assets in its live catalog; this app currently gets Sepolia USD₮ history, while native coin transfers and unsupported test networks are not indexed. Local session sends are also shown. Keep indexer keys in `.env`; they are only sent from the server. This prototype does not calculate USD prices. Swap and fiat purchase screens stay unavailable until an execution provider and its credentials are configured. Those integrations also need explicit chain/token support, regional eligibility, and transaction review before production use.

## Current boundaries

- Username/password registration, login, and recovery are local to this device. There is no hosted account service, email verification, password-reset service, or production-grade multi-user backend.
- Send currently supports native assets on the registered networks. Token transfers require token selection and token-specific contract/decimal validation before they should be exposed.
- Activity is held in memory for the unlocked session; older history needs an indexing provider.
- Public testnet RPCs may be rate limited or unavailable. Production networks are not enabled by default.
- The WDK packages in this project are beta releases. Review WDK and provider configuration, security controls, backup UX, transaction validation, and operational monitoring before handling real funds.
