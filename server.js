import { createServer } from 'node:http'
import { randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdir, readFile, rename, chmod, stat, writeFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import WalletManagerSolana from '@tetherto/wdk-wallet-solana'
import WalletManagerBtc from '@tetherto/wdk-wallet-btc'
import WalletManagerTron from '@tetherto/wdk-wallet-tron'
import { Wallet } from 'ethers'

const root = fileURLToPath(new URL('.', import.meta.url))
try { process.loadEnvFile(join(root, '.env')) } catch (error) { if (error.code !== 'ENOENT') throw error }
const port = Number(process.env.PORT || 4173)
const hosted = process.env.VERCEL === '1'
const dataDir = join(root, '.orbit-data')
const usersFile = join(dataDir, 'accounts.json')
const sessions = new Map()
const loginFailures = new Map()
let users = {}
let indexerCatalogCache = { expiresAt: 0, chains: null }
const indexerBaseUrl = 'https://wdk-api.tether.io'

const chains = [
  { id: 'ethereum', name: 'Ethereum', symbol: 'ETH', kind: 'evm', rpc: process.env.ETHEREUM_RPC_URL, defaultRpc: 'https://ethereum-sepolia-rpc.publicnode.com', network: 'Sepolia' },
  { id: 'polygon', name: 'Polygon', symbol: 'POL', kind: 'evm', rpc: process.env.POLYGON_RPC_URL, defaultRpc: 'https://polygon-amoy-bor-rpc.publicnode.com', network: 'Amoy' },
  { id: 'arbitrum', name: 'Arbitrum', symbol: 'ETH', kind: 'evm', rpc: process.env.ARBITRUM_RPC_URL, defaultRpc: 'https://arbitrum-sepolia-rpc.publicnode.com', network: 'Sepolia' },
  { id: 'solana', name: 'Solana', symbol: 'SOL', kind: 'solana', rpc: process.env.SOLANA_RPC_URL, defaultRpc: 'https://api.devnet.solana.com', network: 'Devnet' },
  { id: 'bitcoin', name: 'Bitcoin', symbol: 'BTC', kind: 'btc', rpc: process.env.BITCOIN_RPC_URL, network: process.env.BITCOIN_NETWORK || 'testnet' },
  { id: 'tron', name: 'TRON', symbol: 'TRX', kind: 'tron', rpc: process.env.TRON_RPC_URL, defaultRpc: 'https://api.shasta.trongrid.io', network: 'Shasta' }
]

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(data))
}

async function body(req) {
  if (req.body != null) {
    if (typeof req.body === 'object') {
      if (Buffer.byteLength(JSON.stringify(req.body)) > 16_000) throw Object.assign(new Error('Request is too large'), { statusCode: 413 })
      return req.body
    }
    if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body) > 16_000) throw Object.assign(new Error('Request is too large'), { statusCode: 413 })
      return req.body ? JSON.parse(req.body) : {}
    }
  }
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 16_000) throw new Error('Request is too large')
  }
  return raw ? JSON.parse(raw) : {}
}

function normalizeUsername(value) {
  if (typeof value !== 'string') throw new Error('Enter a username')
  const username = value.trim()
  if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username)) throw new Error('Use 3–24 letters, numbers, dots, dashes, or underscores')
  if (['__proto__', 'prototype', 'constructor'].includes(username.toLowerCase())) throw new Error('Choose a different username')
  return username
}

function hasUser(key) { return Object.hasOwn(users, key) }

function deriveKeys(password, salt) {
  return scryptSync(password, Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

function encryptSeed(seedPhrase, password) {
  const salt = randomBytes(16).toString('hex')
  const keys = deriveKeys(password, salt)
  const iv = randomBytes(12)
  try {
    const cipher = createCipheriv('aes-256-gcm', keys.subarray(32), iv)
    const ciphertext = Buffer.concat([cipher.update(seedPhrase, 'utf8'), cipher.final()])
    return { salt, verifier: keys.subarray(0, 32).toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), encryptedSeed: ciphertext.toString('hex') }
  } finally { keys.fill(0) }
}

function decryptSeed(record, password) {
  const keys = deriveKeys(password, record.salt)
  try {
    const candidate = keys.subarray(0, 32)
    const expected = Buffer.from(record.verifier, 'hex')
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return null
    const decipher = createDecipheriv('aes-256-gcm', keys.subarray(32), Buffer.from(record.iv, 'hex'))
    decipher.setAuthTag(Buffer.from(record.tag, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(record.encryptedSeed, 'hex')), decipher.final()]).toString('utf8')
  } catch { return null }
  finally { keys.fill(0) }
}

async function persistUsers() {
  const tempFile = `${usersFile}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tempFile, JSON.stringify(users, null, 2), { mode: 0o600 })
  await chmod(tempFile, 0o600)
  await rename(tempFile, usersFile)
  await chmod(usersFile, 0o600)
}

function redisConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
}

async function redisCommand(...command) {
  if (!redisConfigured()) throw Object.assign(new Error('Hosted wallet storage is not configured. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to the Vercel project environment.'), { statusCode: 503, publicMessage: 'Hosted wallet storage is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel Project Settings.' })
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(5000)
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || result.error) throw Object.assign(new Error('Hosted wallet storage is temporarily unavailable.'), { statusCode: 503, publicMessage: 'Wallet storage is temporarily unavailable. Try again shortly.' })
  return result.result
}

async function getUser(key) {
  if (!hosted) return users[key]
  const value = await redisCommand('GET', `orbit:user:${key}`)
  return value ? JSON.parse(value) : undefined
}

async function createUser(key, record) {
  if (hosted) return (await redisCommand('SET', `orbit:user:${key}`, JSON.stringify(record), 'NX')) === 'OK'
  if (hasUser(key)) return false
  users[key] = record
  await persistUsers()
  return true
}

async function loginFailureCount(key) {
  if (!hosted) {
    const failure = loginFailures.get(key)
    if (failure?.until > Date.now()) return { blocked: true, count: 0 }
    return { blocked: false, count: failure?.count || 0 }
  }
  return { blocked: Number(await redisCommand('TTL', `orbit:login-lock:${key}`)) > 0, count: Number(await redisCommand('GET', `orbit:login-fails:${key}`) || 0) }
}

async function recordLoginFailure(key) {
  if (hosted) {
    const count = Number(await redisCommand('INCR', `orbit:login-fails:${key}`))
    if (count === 1) await redisCommand('EXPIRE', `orbit:login-fails:${key}`, '300')
    if (count >= 5) {
      await redisCommand('SET', `orbit:login-lock:${key}`, '1', 'EX', '300')
      await redisCommand('DEL', `orbit:login-fails:${key}`)
    }
    return
  }
  const current = loginFailures.get(key)?.until > Date.now() ? loginFailures.get(key) : { count: 0, until: 0 }
  current.count += 1
  if (current.count >= 5) { current.count = 0; current.until = Date.now() + 5 * 60 * 1000 }
  loginFailures.set(key, current)
}

async function clearLoginFailures(key) {
  if (hosted) await redisCommand('DEL', `orbit:login-fails:${key}`, `orbit:login-lock:${key}`)
  else loginFailures.delete(key)
}

async function saveHostedSession(session) {
  await redisCommand('SET', `orbit:session:${session.token}`, JSON.stringify({ username: session.username, activity: session.activity }), 'EX', '43200')
}

function sessionPayload(session) {
  return {
    authenticated: true,
    username: session.username,
    chains: chains.map(chain => ({
      id: chain.id,
      name: chain.name,
      symbol: chain.symbol,
      kind: chain.kind,
      network: chain.network,
      configured: Boolean(chain.rpc),
      address: session.addresses[chain.id] || null
    })).filter(chain => chain.address)
  }
}

function baseUnitsToDecimal(value, decimals) {
  const raw = BigInt(value).toString().padStart(decimals + 1, '0')
  const whole = raw.slice(0, -decimals) || '0'
  const fraction = raw.slice(-decimals).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

function amountToBaseUnits(amount, decimals) {
  if (typeof amount !== 'string' || !/^\d+(\.\d+)?$/.test(amount) || amount.split('.')[1]?.length > decimals) {
    throw Object.assign(new Error(`Enter an amount with up to ${decimals} decimal places`), { statusCode: 400 })
  }
  const [whole, fraction = ''] = amount.split('.')
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
}

function decimalsFor(chain) { return chain.kind === 'evm' ? 18 : chain.kind === 'solana' ? 9 : chain.kind === 'btc' ? 8 : 6 }

function explainWalletError(error) {
  const message = `${error?.code || ''} ${error?.reason || ''} ${error?.message || ''}`.toLowerCase()
  if (/insufficient.*(balance|fund|lamport|coin)|balance.*(too low|insufficient)|not enough.*(balance|fund)|transactionerror.*insufficient/.test(message)) return 'Your balance cannot cover that amount and the network fee. Try a smaller amount or use Max.'
  if (/invalid.*(address|recipient)|address.*(invalid|checksum)|bad address|valueerror.*address/.test(message)) return 'That address does not look valid for the selected network. Check the address and network, then try again.'
  if (/fee.*(exceed|high|limit)|maximumfeeexceeded/.test(message)) return 'The estimated network fee is above the wallet’s fee limit. Refresh the estimate or try again later.'
  if (/timeout|timed out|network|fetch failed|provider|rpc|429|rate limit|econn/.test(message)) return 'The network is taking too long to respond. Check your connection and try again.'
  if (/dust|below minimum|minimum amount/.test(message)) return 'That amount is below this network’s minimum send amount.'
  if (/nonce|replacement transaction|already known/.test(message)) return 'This wallet has a pending transaction. Wait for it to finish before trying another send.'
  return error?.message || 'Something went wrong. Please try again.'
}

function indexerApiKey() {
  const testNetworks = chains.some(chain => /test|devnet|shasta|amoy/i.test(chain.network))
  return testNetworks
    ? process.env.TEST_KEY || process.env.TES_KEY || process.env.WDK_INDEXER_API_KEY
    : process.env.PRODUCTION_KEY || process.env.WDK_INDEXER_API_KEY
}

async function fetchIndexerJson(path, apiKey) {
  const response = await fetch(`${indexerBaseUrl}${path}`, {
    headers: { 'x-api-key': apiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.message || `Indexer returned ${response.status}`)
    error.status = response.status
    throw error
  }
  return data
}

async function getIndexerCatalog(apiKey) {
  if (indexerCatalogCache.chains && indexerCatalogCache.expiresAt > Date.now()) return indexerCatalogCache.chains
  const data = await fetchIndexerJson('/api/v1/chains', apiKey)
  const catalog = Array.isArray(data.chains) ? data.chains : []
  indexerCatalogCache = { chains: catalog, expiresAt: Date.now() + 5 * 60 * 1000 }
  return catalog
}

function indexerNetworkFor(chain) {
  const network = chain.network.toLowerCase()
  if (chain.id === 'ethereum') return network === 'sepolia' ? 'sepolia' : network === 'mainnet' ? 'ethereum' : null
  if (chain.id === 'polygon') return network === 'mainnet' ? 'polygon' : null
  if (chain.id === 'arbitrum') return network === 'mainnet' ? 'arbitrum' : null
  if (chain.id === 'tron') return network === 'mainnet' ? 'tron' : null
  if (chain.id === 'bitcoin') return network === 'mainnet' ? 'bitcoin' : null
  return null
}

function normalizeIndexedTransfer(transfer, chain, token, address) {
  const timestampValue = transfer.timestamp ?? transfer.blockTimestamp ?? transfer.createdAt ?? transfer.time
  let createdAt = timestampValue ? new Date(typeof timestampValue === 'number' && timestampValue < 1e12 ? timestampValue * 1000 : timestampValue) : null
  if (!createdAt || Number.isNaN(createdAt.getTime())) createdAt = null
  const from = String(transfer.from || transfer.sender || '')
  const to = String(transfer.to || transfer.recipient || '')
  const addressKey = address.toLowerCase()
  const direction = from.toLowerCase() === addressKey ? 'Sent' : to.toLowerCase() === addressKey ? 'Received' : 'Transfer'
  return {
    chain: chain.id,
    token,
    symbol: token.toUpperCase(),
    amount: String(transfer.amount ?? transfer.value ?? '—'),
    from,
    to,
    hash: String(transfer.hash || transfer.transactionHash || transfer.txHash || transfer.transaction_id || transfer.id || ''),
    createdAt: createdAt?.toISOString() || null,
    direction,
    kind: 'indexed'
  }
}

async function getIndexedActivity(session) {
  const apiKey = indexerApiKey()
  if (!apiKey) return { activity: [], note: 'Historical indexing is not configured on this server.' }
  if (session.indexedActivity && session.indexedAt > Date.now() - 60_000) {
    return { activity: session.indexedActivity, note: session.indexedNote }
  }
  try {
    const catalog = await getIndexerCatalog(apiKey)
    const indexed = []
    const queried = []
    for (const walletChain of chains) {
      const blockchain = indexerNetworkFor(walletChain)
      const address = session.addresses[walletChain.id]
      const supported = catalog.find(item => item.name === blockchain)
      if (!blockchain || !address || !supported) continue
      const tokenNames = walletChain.id === 'bitcoin' ? ['btc'] : ['usdt']
      for (const token of tokenNames.filter(name => supported.tokens?.includes(name))) {
        const path = `/api/v1/${encodeURIComponent(blockchain)}/${token}/${encodeURIComponent(address)}/token-transfers?limit=100`
        const response = await fetchIndexerJson(path, apiKey)
        for (const transfer of response.transfers || []) indexed.push(normalizeIndexedTransfer(transfer, walletChain, token, address))
        queried.push(`${walletChain.name} ${token.toUpperCase()}`)
      }
    }
    const note = queried.length
      ? `Tether Indexer history: ${queried.join(', ')}. Native coin history and networks the indexer does not list are not included.`
      : 'Tether Indexer is connected, but it does not currently index these wallet networks.'
    session.indexedActivity = indexed
    session.indexedAt = Date.now()
    session.indexedNote = note
    return { activity: indexed, note }
  } catch (error) {
    const note = error.status === 401
      ? 'Tether Indexer rejected the configured key. Check TEST_KEY or PRODUCTION_KEY in .env.'
      : error.status === 429
        ? 'Tether Indexer is rate limiting requests. Try again shortly.'
        : 'Tether Indexer is temporarily unavailable. Session activity is still shown.'
    return { activity: [], note }
  }
}

async function openSession(username, seedPhrase, token = randomBytes(32).toString('base64url'), { persistHosted = true } = {}) {
  const wdk = new WDK(seedPhrase)
  const accountMap = new Map()
  const addresses = {}
  try {
    for (const chain of chains) {
      const rpc = chain.rpc || chain.defaultRpc
      try {
        if (chain.kind === 'evm') wdk.registerWallet(chain.id, WalletManagerEvm, { provider: rpc })
        if (chain.kind === 'solana') wdk.registerWallet(chain.id, WalletManagerSolana, { provider: rpc, rpcUrl: rpc, commitment: 'confirmed' })
        if (chain.kind === 'btc') wdk.registerWallet(chain.id, WalletManagerBtc, { network: chain.network, ...(chain.rpc ? { client: { type: 'blockbook-http', clientConfig: { url: chain.rpc } } } : {}) })
        if (chain.kind === 'tron') wdk.registerWallet(chain.id, WalletManagerTron, { provider: rpc })
        const account = await wdk.getAccount(chain.id, 0)
        accountMap.set(chain.id, account)
        addresses[chain.id] = await account.getAddress()
      } catch (error) {
        console.error(`Could not initialize ${chain.id}: ${error.message}`)
      }
    }
    if (!Object.keys(addresses).length) throw new Error('No wallet networks could be initialized')
    const session = { token, username, wdk, accounts: accountMap, addresses, activity: [], indexedActivity: null, indexedAt: 0, indexedNote: '' }
    if (hosted) {
      if (persistHosted) await saveHostedSession(session)
    } else sessions.set(token, session)
    return { token, session, wallet: sessionPayload(session) }
  } catch (error) {
    wdk.dispose()
    throw error
  }
}

async function getSession(req) {
  const token = req.headers.authorization?.match(/^Bearer ([\w-]+)$/)?.[1]
  if (!token) return undefined
  if (!hosted) return sessions.get(token)
  const saved = await redisCommand('GET', `orbit:session:${token}`)
  if (!saved) return undefined
  let data
  try { data = JSON.parse(saved) } catch { return undefined }
  const record = await getUser(String(data.username || '').toLowerCase())
  const password = req.headers['x-wallet-password']
  const phrase = record && typeof password === 'string' && password.length >= 10 && password.length <= 256 ? decryptSeed(record, password) : null
  if (!phrase) return undefined
  const opened = await openSession(record.username, phrase, token, { persistHosted: false })
  opened.session.activity = Array.isArray(data.activity) ? data.activity : []
  return opened.session
}

async function initializeStorage() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await chmod(dataDir, 0o700)
  try { users = JSON.parse(await readFile(usersFile, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

export async function handleRequest(req, res) {
  let activeSession
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,authorization,x-wallet-password' }); return res.end() }
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'POST' && url.pathname === '/api/register') {
        const input = await body(req)
        const username = normalizeUsername(input.username)
        if (typeof input.password !== 'string' || input.password.length < 10 || input.password.length > 256) return json(res, 400, { error: 'Choose a password with at least 10 characters' })
        const key = username.toLowerCase()
        const phrase = Wallet.createRandom().mnemonic.phrase
        const record = { username, ...encryptSeed(phrase, input.password), createdAt: new Date().toISOString() }
        if (!await createUser(key, record)) return json(res, 409, { error: 'That username is already registered' })
        const opened = await openSession(username, phrase)
        activeSession = opened.session
        return json(res, 201, { ...opened.wallet, token: opened.token, recoveryPhrase: phrase })
      }
      if (req.method === 'POST' && url.pathname === '/api/restore') {
        const input = await body(req)
        const username = normalizeUsername(input.username)
        if (typeof input.password !== 'string' || input.password.length < 10 || input.password.length > 256) return json(res, 400, { error: 'Choose a password with at least 10 characters' })
        if (typeof input.phrase !== 'string' || input.phrase.trim().split(/\s+/).length < 12) return json(res, 400, { error: 'Enter a valid 12 or 24 word recovery phrase' })
        let phrase
        try { Wallet.fromPhrase(input.phrase.trim()); phrase = input.phrase.trim().toLowerCase().replace(/\s+/g, ' ') }
        catch { return json(res, 400, { error: 'That recovery phrase is not valid' }) }
        const key = username.toLowerCase()
        if (!await createUser(key, { username, ...encryptSeed(phrase, input.password), createdAt: new Date().toISOString() })) return json(res, 409, { error: 'That username is already registered' })
        const opened = await openSession(username, phrase)
        activeSession = opened.session
        return json(res, 201, { ...opened.wallet, token: opened.token })
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const input = await body(req)
        let username
        try { username = normalizeUsername(input.username) } catch { return json(res, 401, { error: 'Username or password is incorrect' }) }
        const key = username.toLowerCase()
        const failures = await loginFailureCount(key)
        if (failures.blocked) return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' })
        const record = await getUser(key)
        const seedPhrase = record && typeof input.password === 'string' ? decryptSeed(record, input.password) : null
        if (!seedPhrase) {
          await recordLoginFailure(key)
          return json(res, 401, { error: 'Username or password is incorrect' })
        }
        await clearLoginFailures(key)
        const opened = await openSession(record.username, seedPhrase)
        activeSession = opened.session
        return json(res, 200, { ...opened.wallet, token: opened.token })
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const session = activeSession = await getSession(req)
        return json(res, 200, session ? sessionPayload(session) : { authenticated: false })
      }
      if (req.method === 'POST' && url.pathname === '/api/lock' && hosted) {
        const token = req.headers.authorization?.match(/^Bearer ([\w-]+)$/)?.[1]
        if (token) await redisCommand('DEL', `orbit:session:${token}`)
        return json(res, 200, { locked: true })
      }
      const session = activeSession = await getSession(req)
      if (!session) return json(res, 401, { error: 'Please log in again' })
      if (req.method === 'POST' && url.pathname === '/api/reveal-recovery') {
        const input = await body(req)
        const record = await getUser(session.username.toLowerCase())
        const phrase = record && typeof input.password === 'string' ? decryptSeed(record, input.password) : null
        if (!phrase) return json(res, 401, { error: 'Password is incorrect' })
        return json(res, 200, { phrase })
      }
      if (req.method === 'POST' && url.pathname === '/api/lock') {
        session.wdk.dispose()
        sessions.delete(session.token)
        return json(res, 200, { locked: true })
      }
      if (req.method === 'GET' && url.pathname === '/api/balances') {
        const values = await Promise.all(chains.map(async chain => {
          const account = session.accounts.get(chain.id)
          if (!account) return { id: chain.id, balance: null, error: 'Provider unavailable' }
          try { return { id: chain.id, balance: String(await account.getBalance()) } }
          catch (error) { return { id: chain.id, balance: null, error: error.message } }
        }))
        return json(res, 200, { balances: values })
      }
      if (req.method === 'GET' && url.pathname === '/api/activity') {
        const history = await getIndexedActivity(session)
        const seen = new Set(session.activity.map(item => item.hash).filter(Boolean))
        const activity = [...session.activity, ...history.activity.filter(item => !item.hash || !seen.has(item.hash))]
          .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
        return json(res, 200, { activity, historyNote: history.note })
      }
      if (req.method === 'POST' && url.pathname === '/api/send-max') {
        const { chain: id, to } = await body(req)
        const chain = chains.find(item => item.id === id)
        const account = session.accounts.get(id)
        if (!chain || !account) return json(res, 400, { error: 'This chain is not available' })
        if (typeof to !== 'string' || !to.trim()) return json(res, 400, { error: 'Enter the recipient address first so the wallet can estimate the fee' })
        let amount, fee
        if (chain.kind === 'btc') {
          const max = await account.getMaxSpendable()
          amount = BigInt(max.amount)
          fee = BigInt(max.fee)
        } else {
          const balance = BigInt(await account.getBalance())
          const decimals = decimalsFor(chain)
          let quote = await account.quoteSendTransaction({ to: to.trim(), value: 0n })
          fee = BigInt(quote.fee)
          amount = balance - fee
          // Some networks vary the fee slightly with the transaction value. Requote
          // until the displayed max amount includes the fee for that exact amount.
          for (let attempt = 0; attempt < 8 && amount > 0n; attempt += 1) {
            quote = await account.quoteSendTransaction({ to: to.trim(), value: amount })
            const updatedFee = BigInt(quote.fee)
            if (updatedFee === fee) break
            fee = updatedFee
            amount = balance - fee
          }
          if (amount > 0n) {
            quote = await account.quoteSendTransaction({ to: to.trim(), value: amount })
            const finalFee = BigInt(quote.fee)
            if (finalFee !== fee) {
              fee = finalFee
              amount = balance - fee
              quote = await account.quoteSendTransaction({ to: to.trim(), value: amount })
              fee = BigInt(quote.fee)
              if (amount + fee > balance) amount = balance - fee
            }
          }
          if (amount <= 0n) return json(res, 400, { error: `This wallet needs at least ${baseUnitsToDecimal(fee + 1n, decimals)} ${chain.symbol} to cover the network fee.` })
        }
        if (amount <= 0n) return json(res, 400, { error: `Your balance is not enough to cover this network’s fee.` })
        const decimals = decimalsFor(chain)
        return json(res, 200, { amount: amount.toString(), amountFormatted: baseUnitsToDecimal(amount, decimals), fee: fee.toString(), feeFormatted: baseUnitsToDecimal(fee, decimals), symbol: chain.symbol })
      }
      if (req.method === 'POST' && url.pathname === '/api/quote') {
        const { chain: id, to, amount } = await body(req)
        const chain = chains.find(item => item.id === id)
        const account = session.accounts.get(id)
        if (!chain || !account) return json(res, 400, { error: 'This chain is not available' })
        if (typeof to !== 'string' || !to.trim()) return json(res, 400, { error: 'Enter the recipient address first' })
        const decimals = decimalsFor(chain)
        const value = amountToBaseUnits(String(amount), decimals)
        if (value <= 0n) return json(res, 400, { error: 'Enter an amount greater than zero' })
        const quote = await account.quoteSendTransaction({ to: to.trim(), value })
        const balance = BigInt(await account.getBalance())
        const fee = BigInt(quote.fee)
        return json(res, 200, { fee: fee.toString(), feeFormatted: baseUnitsToDecimal(fee, decimals), symbol: chain.symbol, sufficient: value + fee <= balance, available: balance.toString() })
      }
      if (req.method === 'POST' && url.pathname === '/api/send') {
        const { chain: id, to, amount } = await body(req)
        const chain = chains.find(item => item.id === id)
        const account = session.accounts.get(id)
        if (!chain || !account) return json(res, 400, { error: 'This chain is not available' })
        if (typeof to !== 'string' || !to.trim()) return json(res, 400, { error: 'Enter the recipient address first' })
        if (typeof amount !== 'string' || !amount.trim()) return json(res, 400, { error: 'Enter an amount to send' })
        const decimals = decimalsFor(chain)
        const value = amountToBaseUnits(amount, decimals)
        if (value <= 0n) return json(res, 400, { error: 'Enter an amount greater than zero' })
        const quote = await account.quoteSendTransaction({ to: to.trim(), value })
        const balance = BigInt(await account.getBalance())
        if (value + BigInt(quote.fee) > balance) return json(res, 400, { error: `Your balance cannot cover ${amount} ${chain.symbol} plus the ${baseUnitsToDecimal(quote.fee, decimals)} ${chain.symbol} network fee. Use Max or lower the amount.` })
        const result = await account.sendTransaction({ to: to.trim(), value })
        const entry = { chain: id, to: to.trim(), amount: String(amount), hash: result.hash, fee: String(result.fee ?? ''), createdAt: new Date().toISOString(), kind: 'send' }
        session.activity.unshift(entry)
        if (hosted) {
          try { await saveHostedSession(session) }
          catch (error) { console.error(`Transaction ${entry.hash} was sent, but session history could not be saved: ${error.message}`) }
        }
        return json(res, 200, entry)
      }
      return json(res, 404, { error: 'Unknown API route' })
    }
    const safePath = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, '')
    const path = join(root, 'public', safePath || 'index.html')
    if (!(await stat(path)).isFile()) return json(res, 404, { error: 'Not found' })
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' }
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(await readFile(path))
  } catch (error) {
    const status = error.statusCode || 400
    if (status >= 500) console.error(error)
    json(res, status, { error: error.publicMessage || (status >= 500 ? 'The wallet could not complete that request. Please try again.' : explainWalletError(error)) })
  } finally {
    if (hosted && activeSession?.wdk) activeSession.wdk.dispose()
  }
}

if (!hosted) {
  await initializeStorage()
  const server = createServer(handleRequest)
  server.listen(port, '127.0.0.1', () => console.log(`Wallet app ready at http://localhost:${port}`))
}
