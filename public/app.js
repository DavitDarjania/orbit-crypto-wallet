const $ = (selector, parent = document) => parent.querySelector(selector)
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)]
const state = { chains: [], addresses: {}, balances: {}, activeChain: 'ethereum', hidden: false, view: 'overview', token: sessionStorage.getItem('orbit-session'), username: '', pendingWallet: null }
const titles = { ethereum: 'Ethereum', polygon: 'Polygon', arbitrum: 'Arbitrum', solana: 'Solana', bitcoin: 'Bitcoin', tron: 'TRON' }
const symbols = { ethereum: 'ETH', polygon: 'POL', arbitrum: 'ETH', solana: 'SOL', bitcoin: 'BTC', tron: 'TRX' }
const icons = { ethereum: 'Ξ', polygon: '⬡', arbitrum: '◉', solana: '◎', bitcoin: '₿', tron: '◉' }
const amounts = { ethereum: 18, polygon: 18, arbitrum: 18, solana: 9, bitcoin: 8, tron: 6 }
let toastTimer
let activityItems = []
let activityFilter = 'all'

async function api(path, data) {
  const headers = data ? { 'content-type': 'application/json' } : {}
  if (state.token) headers.authorization = `Bearer ${state.token}`
  let response
  try { response = await fetch(`/api/${path}`, { method: data ? 'POST' : 'GET', headers, body: data ? JSON.stringify(data) : undefined }) }
  catch { throw new Error('Could not reach the wallet service. Check your connection and try again.') }
  let result
  try { result = await response.json() }
  catch { throw new Error('The wallet service returned an unexpected response. Please try again.') }
  if (!response.ok) throw new Error(result.error || 'Something went wrong')
  return result
}
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.remove('hidden')
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 4200)
}
function addressShort(value) { return value ? `${value.slice(0, 6)}…${value.slice(-5)}` : 'Provider unavailable' }
function amountValue(raw, chain) {
  if (raw == null) return null
  const digits = amounts[chain] || 18
  try {
    const text = typeof raw === 'bigint' ? raw.toString() : String(raw)
    if (/^\d+$/.test(text)) return Number(text) / 10 ** digits
    return Number(text)
  } catch { return null }
}
function money(value) {
  if (state.hidden) return '••••••'
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US', { maximumFractionDigits: value > 100 ? 2 : 5 })
}
function setWallet(wallet) {
  if (wallet.token) { state.token = wallet.token; sessionStorage.setItem('orbit-session', wallet.token) }
  state.username = wallet.username || state.username
  state.chains = wallet.chains || []
  state.addresses = Object.fromEntries(state.chains.filter(c => c.address).map(c => [c.id, c.address]))
  $('#welcome').classList.add('hidden'); $('#wallet-shell').classList.remove('hidden')
  $('#profile-name').textContent = state.username || 'My wallet'
  $('#account-label').textContent = state.username || 'My wallet'
  $('#profile-avatar').textContent = (state.username || 'O').slice(0, 1).toUpperCase()
  $('#profile-address').textContent = addressShort(state.addresses.ethereum || Object.values(state.addresses)[0])
  renderAddresses()
  renderSidebarAddresses()
  refreshBalances()
}
async function refreshBalances() {
  $('#assets-list').innerHTML = '<div class="loading-row">Refreshing your network accounts<span class="loader"></span></div>'
  try {
    const result = await api('balances')
    state.balances = Object.fromEntries(result.balances.map(item => [item.id, amountValue(item.balance, item.id)]))
    renderAssets(); renderTotal(); await refreshActivity()
  } catch (error) { $('#assets-list').innerHTML = `<div class="loading-row">${escapeHtml(error.message)}</div>`; toast(error.message) }
}
async function refreshActivity() {
  try {
    const result = await api('activity')
    activityItems = result.activity
    const container = $('#recent-activity')
    if (!container) return
    if (!result.activity.length) { container.innerHTML = '<div class="empty-activity"><div class="empty-symbol">↗</div><div><b>Your activity will show up here</b><small>Transactions made from this wallet appear here.</small></div></div>'; return }
    container.innerHTML = result.activity.slice(0, 4).map(item => `<div class="provider-line"><span>${escapeHtml(item.direction || (item.kind === 'send' ? 'Sent' : 'Transfer'))} ${escapeHtml(item.amount)} ${escapeHtml(item.symbol || symbols[item.chain] || '')} · ${titles[item.chain] || escapeHtml(item.chain)}<small style="display:block;margin-top:5px">${item.createdAt ? new Date(item.createdAt).toLocaleString() : 'Time unavailable'}</small></span><a target="_blank" rel="noreferrer" href="${explorerUrl(item.chain, item.hash)}" class="text-button">View transaction ↗</a></div>`).join('')
  } catch { /* Activity is only available while a wallet session is unlocked. */ }
}
function explorerUrl(chain, hash) {
  if (chain === 'solana') return `https://explorer.solana.com/tx/${encodeURIComponent(hash || '')}?cluster=devnet`
  const bases = { ethereum: 'https://sepolia.etherscan.io/tx/', polygon: 'https://amoy.polygonscan.com/tx/', arbitrum: 'https://sepolia.arbiscan.io/tx/', solana: 'https://explorer.solana.com/tx/', bitcoin: 'https://mempool.space/testnet/tx/', tron: 'https://shasta.tronscan.org/#/transaction/' }
  return `${bases[chain] || '#'}${encodeURIComponent(hash || '')}`
}
function activityDayLabel(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return 'Date unavailable'
  const date = new Date(value), today = new Date(), yesterday = new Date()
  today.setHours(0, 0, 0, 0); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(0, 0, 0, 0)
  const day = new Date(date); day.setHours(0, 0, 0, 0)
  if (day.getTime() === today.getTime()) return 'Today'
  if (day.getTime() === yesterday.getTime()) return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}
function renderActivityList() {
  const list = $('#activity-list')
  if (!list) return
  const filtered = activityFilter === 'all' ? activityItems : activityItems.filter(item => item.chain === activityFilter)
  const count = $('#activity-count')
  if (count) count.textContent = `${filtered.length} ${filtered.length === 1 ? 'transaction' : 'transactions'}`
  if (!filtered.length) {
    list.innerHTML = `<div class="activity-empty"><span class="activity-empty-mark" aria-hidden="true">↗</span><div><b>${activityItems.length ? 'No activity on this network' : 'No transactions found'}</b><small>${activityItems.length ? 'Choose another network to see its activity.' : 'Transactions will appear here when they are indexed or sent from this session.'}</small></div></div>`
    return
  }
  const groups = new Map()
  filtered.forEach(item => {
    const label = activityDayLabel(item.createdAt)
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label).push(item)
  })
  list.innerHTML = [...groups.entries()].map(([day, items]) => `<section class="activity-day" aria-label="${escapeHtml(day)}"><div class="activity-day-heading"><span>${escapeHtml(day)}</span><small>${items.length} ${items.length === 1 ? 'transaction' : 'transactions'}</small></div><div class="activity-day-rows" role="list">${items.map(item => {
    const direction = item.direction || (item.kind === 'send' ? 'Sent' : 'Transfer')
    const symbol = item.symbol || symbols[item.chain] || ''
    const chainTitle = titles[item.chain] || item.chain
    const network = state.chains.find(chain => chain.id === item.chain)?.network || ''
    const signedAmount = `${direction === 'Sent' ? '−' : direction === 'Received' ? '+' : ''}${escapeHtml(item.amount)} ${escapeHtml(symbol)}`
    const timestamp = item.createdAt && !Number.isNaN(new Date(item.createdAt).getTime()) ? new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Time unavailable'
    const link = item.hash ? `<a class="activity-explorer" target="_blank" rel="noreferrer" href="${explorerUrl(item.chain, item.hash)}" aria-label="View ${escapeHtml(chainTitle)} transaction on its explorer">Explorer <span aria-hidden="true">↗</span></a>` : '<span class="activity-no-link">Explorer unavailable</span>'
    return `<article class="activity-row" role="listitem"><span class="activity-direction ${direction.toLowerCase()}" aria-hidden="true">${direction === 'Sent' ? '↑' : direction === 'Received' ? '↓' : '↔'}</span><div class="activity-description"><b>${escapeHtml(direction)} ${escapeHtml(symbol)}</b><span>${escapeHtml(chainTitle)}${network ? ` · ${escapeHtml(network)}` : ''}${item.kind === 'indexed' ? ' · Indexed' : ''}</span><code>${escapeHtml(item.hash ? `${item.hash.slice(0, 8)}…${item.hash.slice(-6)}` : '')}</code></div><div class="activity-value"><strong>${signedAmount}</strong><time>${escapeHtml(timestamp)}</time></div><div class="activity-action">${link}</div></article>`
  }).join('')}</div></section>`).join('')
}
function renderTotal() {
  const entries = Object.entries(state.balances).filter(([, value]) => Number.isFinite(value))
  if (!entries.length) { $('#total-balance').innerHTML = `—<span class="balance-suffix"> USD</span>`; $('#balance-note').textContent = 'Network balance reads unavailable'; return }
  $('#total-balance').innerHTML = `${state.hidden ? '••••••' : '—'}<span class="balance-suffix"> USD</span>`
  $('#balance-note').textContent = 'USD pricing is unavailable · network balances shown below'
}
function renderAssets() {
  const items = state.chains.filter(chain => state.addresses[chain.id])
  if (!items.length) { $('#assets-list').innerHTML = '<div class="loading-row">No network accounts are available.</div>'; return }
  $('#assets-list').innerHTML = items.map(chain => {
    const value = state.balances[chain.id], shown = value == null ? '—' : `${money(value)} ${symbols[chain.id]}`
    const status = value == null ? 'Balance unavailable' : `${chain.network} · ${chain.configured ? 'RPC connected' : 'Public testnet RPC'}`
    return `<div class="asset-row"><div class="asset-name"><span class="coin-icon ${chain.id === 'solana' ? 'sol' : chain.id === 'bitcoin' ? 'btc' : chain.id === 'tron' ? 'tron' : ''}">${icons[chain.id]}</span><div><b>${titles[chain.id]}</b><small>${symbols[chain.id]}</small></div></div><div class="asset-amount">${shown}<small class="asset-status">${status}</small></div><div class="asset-usd">— USD</div></div>`
  }).join('')
}
function renderAddresses() {
  const container = $('#address-list')
  if (!container) return
  container.innerHTML = state.chains.map(chain => `<div class="address-row"><span class="coin-icon ${chain.id === 'solana' ? 'sol' : chain.id === 'bitcoin' ? 'btc' : chain.id === 'tron' ? 'tron' : ''}">${icons[chain.id]}</span><div class="address-chain"><b>${titles[chain.id]}</b><small>${chain.network} · ${symbols[chain.id]}</small></div><code title="${escapeHtml(chain.address)}">${escapeHtml(chain.address)}</code><button class="copy-address" data-copy="${chain.id}" aria-label="Copy ${titles[chain.id]} address">Copy</button></div>`).join('')
  $$('[data-copy]', container).forEach(button => button.addEventListener('click', () => copyAddress(button.dataset.copy)))
}
function renderSidebarAddresses() {
  const container = $('#sidebar-address-list')
  if (!container) return
  container.innerHTML = state.chains.filter(chain => state.addresses[chain.id]).map(chain => `<div class="sidebar-address-row"><div><b>${escapeHtml(titles[chain.id] || chain.name)}</b><small>${escapeHtml(chain.network)} · ${escapeHtml(symbols[chain.id] || chain.symbol)}</small></div><code title="${escapeHtml(chain.address)}">${escapeHtml(chain.address)}</code><button type="button" data-sidebar-copy="${chain.id}" aria-label="Copy ${escapeHtml(titles[chain.id] || chain.name)} public address">Copy</button></div>`).join('')
  $$('[data-sidebar-copy]', container).forEach(button => button.addEventListener('click', () => copyAddress(button.dataset.sidebarCopy)))
}
async function copyAddress(chainId) {
  try { await navigator.clipboard.writeText(state.addresses[chainId]); toast(`${titles[chainId]} address copied`) }
  catch { toast(`Copy unavailable. Address: ${state.addresses[chainId]}`) }
}
function escapeHtml(text) { return String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]) }
function openPhrase(phrase) {
  $('#phrase-grid').innerHTML = phrase.split(/\s+/).map((word, i) => `<div class="phrase-word"><b>${String(i + 1).padStart(2, '0')}</b>${escapeHtml(word)}</div>`).join('')
  $('#phrase-check').checked = false; $('#phrase-continue').disabled = true
  $('#phrase-dialog').showModal()
}
$('#phrase-check').addEventListener('change', event => { $('#phrase-continue').disabled = !event.target.checked })
$('#phrase-continue').addEventListener('click', event => { event.preventDefault(); $('#phrase-dialog').close(); setWallet(state.pendingWallet); state.pendingWallet = null })
$('#register-account').addEventListener('click', () => $('#register-dialog').showModal())
$('#login-account').addEventListener('click', () => $('#login-dialog').showModal())
let restoreWordCount = 12
let restoreWords = Array(24).fill('')
function renderRestoreWordInputs(count = restoreWordCount) {
  restoreWordCount = count
  $$('.word-count-option').forEach(button => button.classList.toggle('active', Number(button.dataset.wordCount) === count))
  $('#restore-words').innerHTML = Array.from({ length: count }, (_, index) => `<label class="recovery-word"><span>${String(index + 1).padStart(2, '0')}</span><input type="text" data-word-index="${index}" aria-label="Recovery word ${index + 1}" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="word ${index + 1}" value="${escapeHtml(restoreWords[index])}" /></label>`).join('')
  const fields = $$('[data-word-index]', $('#restore-words'))
  fields.forEach((field, index) => {
    field.addEventListener('input', () => {
      restoreWords[index] = field.value.trim().toLowerCase()
      $('#restore-word-count').textContent = `${fields.filter(input => input.value.trim()).length} of ${count} words entered`
      setFormError('restore-error', '')
    })
    field.addEventListener('keydown', event => {
      if ((event.key === ' ' || event.key === 'Enter') && field.value.trim()) {
        event.preventDefault()
        fields[index + 1]?.focus()
      } else if (event.key === 'Backspace' && !field.value && index > 0) fields[index - 1].focus()
    })
    field.addEventListener('paste', event => {
      const pasted = event.clipboardData.getData('text').trim().toLowerCase().split(/\s+/).filter(Boolean)
      if (pasted.length <= 1) return
      event.preventDefault()
      let startIndex = index
      if (pasted.length === 12 || pasted.length === 24) {
        restoreWords = Array(24).fill('')
        renderRestoreWordInputs(pasted.length)
        startIndex = 0
      }
      pasted.slice(0, restoreWordCount - startIndex).forEach((word, offset) => { restoreWords[startIndex + offset] = word })
      renderRestoreWordInputs(restoreWordCount)
      const nextIndex = Math.min(startIndex + pasted.length, restoreWordCount - 1)
      $$('[data-word-index]', $('#restore-words'))[nextIndex]?.focus()
      setFormError('restore-error', '')
    })
  })
  $('#restore-word-count').textContent = `${fields.filter(input => input.value.trim()).length} of ${count} words entered`
}
$$('.word-count-option').forEach(button => button.addEventListener('click', () => renderRestoreWordInputs(Number(button.dataset.wordCount))))
function openRestoreDialog() { renderRestoreWordInputs(restoreWordCount); setFormError('restore-error', ''); $('#restore-dialog').showModal() }
$('#restore-account').addEventListener('click', openRestoreDialog)
$('#login-restore').addEventListener('click', () => { $('#login-dialog').close(); openRestoreDialog() })
$('#register-submit').addEventListener('click', async event => {
  event.preventDefault()
  const username = $('#register-username').value.trim(), password = $('#register-password').value, confirmation = $('#register-password-confirm').value
  setFormError('register-error', '')
  if (password !== confirmation) return setFormError('register-error', 'Those passwords do not match.')
  const button = $('#register-submit'); button.disabled = true; button.textContent = 'Creating account…'
  try { const wallet = await api('register', { username, password }); $('#register-dialog').close(); $('#register-password').value = ''; $('#register-password-confirm').value = ''; state.pendingWallet = wallet; state.token = wallet.token; state.username = wallet.username; sessionStorage.setItem('orbit-session', wallet.token); openPhrase(wallet.recoveryPhrase) }
  catch (error) { setFormError('register-error', error.message) }
  finally { button.disabled = false; button.innerHTML = 'Create secure wallet <span>↗</span>' }
})
;['register-username', 'register-password', 'register-password-confirm'].forEach(id => $(`#${id}`).addEventListener('input', () => setFormError('register-error', '')))
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); setFormError('login-error', ''); const button = $('#login-submit'); button.disabled = true; button.textContent = 'Unlocking wallet…'
  try { const wallet = await api('login', { username: $('#login-username').value.trim(), password: $('#login-password').value }); $('#login-dialog').close(); $('#login-password').value = ''; setWallet(wallet) }
  catch (error) { setFormError('login-error', error.message) }
  finally { button.disabled = false; button.innerHTML = 'Log in securely <span>↗</span>' }
})
;['login-username', 'login-password'].forEach(id => $(`#${id}`).addEventListener('input', () => setFormError('login-error', '')))
$('#restore-submit').addEventListener('click', async event => {
  event.preventDefault(); setFormError('restore-error', '')
  const phrase = restoreWords.slice(0, restoreWordCount).map(word => word.trim()).join(' ')
  if (restoreWords.slice(0, restoreWordCount).some(word => !word.trim())) return setFormError('restore-error', `Enter all ${restoreWordCount} recovery words in order.`)
  const button = $('#restore-submit'); button.disabled = true; button.textContent = 'Restoring wallet…'
  try {
    const wallet = await api('restore', { phrase, username: $('#restore-username').value.trim(), password: $('#restore-password').value })
    $('#restore-dialog').close(); restoreWords = Array(24).fill(''); $('#restore-password').value = ''; setWallet(wallet); toast('Wallet restored securely')
  } catch (error) { setFormError('restore-error', error.message) }
  finally { button.disabled = false; button.innerHTML = 'Restore wallet <span>↗</span>' }
})
;['restore-username', 'restore-password'].forEach(id => $(`#${id}`).addEventListener('input', () => setFormError('restore-error', '')))
$('#lock-wallet').addEventListener('click', async () => { try { await api('lock', {}) } catch {} setPublicAddressesOpen(false); sessionStorage.removeItem('orbit-session'); state.token = null; state.addresses = {}; state.balances = {}; state.username = ''; $('#wallet-shell').classList.add('hidden'); $('#welcome').classList.remove('hidden') })
$('#refresh').addEventListener('click', refreshBalances)
$('#toggle-balance').addEventListener('click', () => { state.hidden = !state.hidden; renderTotal() })
$('#about-security').addEventListener('click', () => { $('#reveal-password').value = ''; $('#recovery-reveal').classList.add('hidden'); $('#recovery-words').replaceChildren(); $('#security-dialog').showModal() })
$('#reveal-submit').addEventListener('click', async event => {
  event.preventDefault(); const button = $('#reveal-submit'); button.disabled = true; button.textContent = 'Checking password…'
  try {
    const { phrase } = await api('reveal-recovery', { password: $('#reveal-password').value })
    $('#recovery-words').innerHTML = phrase.split(/\s+/).map((word, i) => `<div class="phrase-word"><b>${String(i + 1).padStart(2, '0')}</b>${escapeHtml(word)}</div>`).join('')
    $('#recovery-reveal').classList.remove('hidden'); $('#reveal-password').value = ''
  } catch (error) { toast(error.message) }
  finally { button.disabled = false; button.innerHTML = 'Reveal recovery phrase <span>↗</span>' }
})
$('#hide-recovery').addEventListener('click', () => { $('#recovery-words').replaceChildren(); $('#recovery-reveal').classList.add('hidden') })

const publicAddressToggle = $('#toggle-public-addresses'), publicAddressPanel = $('#sidebar-addresses')
function setPublicAddressesOpen(open) {
  publicAddressPanel.classList.toggle('hidden', !open)
  publicAddressToggle.setAttribute('aria-expanded', String(open))
  publicAddressToggle.setAttribute('aria-label', open ? 'Hide public addresses' : 'Show public addresses')
  publicAddressToggle.classList.toggle('expanded', open)
}
publicAddressToggle.addEventListener('click', () => setPublicAddressesOpen(publicAddressPanel.classList.contains('hidden')))
document.addEventListener('click', event => { if (!event.target.closest('.sidebar')) setPublicAddressesOpen(false) })
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !publicAddressPanel.classList.contains('hidden')) { setPublicAddressesOpen(false); publicAddressToggle.focus() } })

function setView(view) {
  setPublicAddressesOpen(false)
  state.view = view
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view))
  $('#overview-view').classList.toggle('hidden', view !== 'overview')
  $('#secondary-view').classList.toggle('hidden', view === 'overview')
  const labels = { overview: 'Overview', tokens: 'Tokens', activity: 'Activity', swap: 'Swap', buy: 'Buy crypto' }
  $('#view-title').textContent = labels[view]
  if (view === 'overview') return
  const providers = state.chains.map(chain => `<div class="provider-line"><span>${titles[chain.id]} <small>${symbols[chain.id]}</small></span><small>${chain.network} · ${chain.configured ? 'RPC configured' : 'Public testnet'}</small></div>`).join('')
  if (view === 'tokens') {
    $('#secondary-view').innerHTML = `<div class="secondary-head"><div><span class="section-eyebrow">YOUR WALLET</span><h3>Tokens</h3></div><input class="search-box" id="token-search" placeholder="Search tokens or networks" /></div><div class="chain-filter"><button class="filter-pill active" data-filter="all">All networks</button>${state.chains.map(c => `<button class="filter-pill" data-filter="${c.id}">${titles[c.id]}</button>`).join('')}</div><div class="view-table-head"><span>ASSET</span><span>BALANCE</span><span>VALUE</span></div><div id="token-rows">${tokenRows()}</div>`
    $('#token-search').addEventListener('input', filterTokenRows)
    $$('.filter-pill').forEach(button => button.addEventListener('click', () => { $$('.filter-pill').forEach(p => p.classList.toggle('active', p === button)); filterTokenRows() }))
  } else if (view === 'activity') {
    activityFilter = 'all'
    const activityNetworks = state.chains.filter(chain => state.addresses[chain.id])
    $('#secondary-view').innerHTML = `<div class="secondary-head activity-page-head"><div><span class="section-eyebrow">YOUR WALLET</span><h3>Activity</h3><small id="activity-count" class="activity-count">Loading transactions…</small></div><label class="activity-filter-label">Network<select id="activity-filter"><option value="all">All networks</option>${activityNetworks.map(chain => `<option value="${chain.id}">${titles[chain.id]} · ${chain.network}</option>`).join('')}</select></label></div><div id="activity-note" class="activity-note" aria-live="polite">Loading indexed wallet activity…</div><div id="activity-list"></div>`
    $('#activity-filter').addEventListener('change', event => { activityFilter = event.target.value; renderActivityList() })
    api('activity').then(result => {
      activityItems = result.activity
      $('#activity-count').textContent = `${activityItems.length} ${activityItems.length === 1 ? 'transaction' : 'transactions'}`
      $('#activity-note').textContent = result.historyNote || 'Session activity is shown below.'
      renderActivityList()
    }).catch(error => { $('#activity-note').textContent = error.message; $('#activity-count').textContent = 'History unavailable'; renderActivityList() })
  } else {
    const title = view === 'swap' ? 'Swap tokens across supported networks' : 'Buy crypto with a payment method'
    const desc = view === 'swap' ? 'Quotes and execution require a configured swap provider and explicit slippage limits.' : 'Fiat purchases require a configured on-ramp account and region eligibility.'
    $('#secondary-view').innerHTML = `<div class="secondary-head"><div><span class="section-eyebrow">COMING ONLINE</span><h3>${labels[view]}</h3></div></div><div class="notice-panel"><h4>${title}</h4><p>${desc} No provider credentials are configured, so this action is unavailable right now. Your wallet remains usable for supported network sends and receives.</p><div class="provider-list">${providers}</div></div>`
  }
}
function tokenRows() { return state.chains.filter(c => state.addresses[c.id]).map(c => `<div class="asset-row token-row" data-name="${titles[c.id]} ${symbols[c.id]}" data-chain="${c.id}"><div class="asset-name"><span class="coin-icon ${c.id === 'solana' ? 'sol' : c.id === 'bitcoin' ? 'btc' : c.id === 'tron' ? 'tron' : ''}">${icons[c.id]}</span><div><b>${titles[c.id]}</b><small>${symbols[c.id]}</small></div></div><div class="asset-amount">${state.balances[c.id] == null ? '—' : `${money(state.balances[c.id])} ${symbols[c.id]}`}</div><div class="asset-usd">— USD</div></div>`).join('') }
function filterTokenRows() { const query = $('#token-search')?.value.toLowerCase() || '', selected = $('.filter-pill.active')?.dataset.filter || 'all'; $$('.token-row').forEach(row => row.classList.toggle('hidden', !(row.dataset.name.toLowerCase().includes(query) && (selected === 'all' || row.dataset.chain === selected)))) }
$$('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)))

function setFormError(id, message) {
  const box = $(`#${id}`)
  if (!box) return
  box.textContent = message
  box.classList.toggle('hidden', !message)
}
function clearSendFeedback() {
  setFormError('send-error', '')
  $('#send-fee').textContent = 'Add a recipient and amount to estimate the network fee.'
  $('#send-fee').classList.remove('fee-error')
}
let quoteTimer, quoteSequence = 0
function sendForm() {
  const options = state.chains.filter(c => state.addresses[c.id])
  const symbol = symbols[state.activeChain] || 'token'
  return `<div id="send-error" class="form-error hidden" role="alert" aria-live="polite"></div><div class="warning-box">Test networks are active. Review the recipient, network, and estimated fee before confirming.</div><label class="form-label" for="send-chain">Network</label><select id="send-chain">${options.map(c => `<option value="${c.id}" ${c.id === state.activeChain ? 'selected' : ''}>${titles[c.id]} · ${symbols[c.id]} · ${c.network}</option>`).join('')}</select><label class="form-label" for="send-to">Recipient address</label><input id="send-to" placeholder="Paste destination address" autocomplete="off" /><label class="form-label" for="send-amount">Amount (${symbol})</label><div class="amount-control"><input id="send-amount" class="amount-input" placeholder="0.00" inputmode="decimal" autocomplete="off" /><button type="button" id="max-send" class="max-button">Max</button></div><div id="send-fee" class="fee-note" aria-live="polite">Add a recipient and amount to estimate the network fee.</div><button type="button" class="button primary full" id="review-send">Review transfer <span>↗</span></button>`
}
function bindSendForm() {
  const content = $('#operation-content')
  $('#send-chain').addEventListener('change', event => {
    state.activeChain = event.target.value
    $('#send-amount').previousElementSibling.textContent = `Amount (${symbols[state.activeChain]})`
    clearSendFeedback()
    scheduleFeeQuote()
  })
  $('#send-to').addEventListener('input', () => { clearSendFeedback(); scheduleFeeQuote() })
  $('#send-amount').addEventListener('input', () => { clearSendFeedback(); scheduleFeeQuote() })
  $('#max-send').addEventListener('click', async () => {
    const button = $('#max-send'), chain = $('#send-chain').value, to = $('#send-to').value.trim()
    setFormError('send-error', '')
    if (!to) return setFormError('send-error', 'Enter the recipient address first so the wallet can include the right network fee.')
    button.disabled = true; button.textContent = '…'
    try {
      const result = await api('send-max', { chain, to })
      if ($('#send-chain').value !== chain || $('#send-to').value.trim() !== to) return
      $('#send-amount').value = result.amountFormatted
      $('#send-fee').textContent = `Estimated network fee: ${result.feeFormatted} ${result.symbol}. Max amount is fee-aware.`
      $('#send-fee').classList.remove('fee-error')
    } catch (error) { setFormError('send-error', error.message) }
    finally { button.disabled = false; button.textContent = 'Max' }
  })
  $('#review-send').addEventListener('click', reviewTransfer)
}
function scheduleFeeQuote() {
  clearTimeout(quoteTimer)
  const sequence = ++quoteSequence
  quoteTimer = setTimeout(async () => {
    const chain = $('#send-chain')?.value, to = $('#send-to')?.value.trim(), amount = $('#send-amount')?.value.trim()
    if (!chain || !to || !amount || !/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) return
    $('#send-fee').textContent = 'Estimating network fee…'
    try {
      const result = await api('quote', { chain, to, amount })
      if (sequence !== quoteSequence) return
      if (!result.sufficient) {
        $('#send-fee').textContent = `Estimated fee: ${result.feeFormatted} ${result.symbol} · balance is too low for this amount.`
        $('#send-fee').classList.add('fee-error')
      } else {
        $('#send-fee').textContent = `Estimated network fee: ${result.feeFormatted} ${result.symbol}`
        $('#send-fee').classList.remove('fee-error')
      }
    } catch (error) {
      if (sequence === quoteSequence) { $('#send-fee').textContent = error.message; $('#send-fee').classList.add('fee-error') }
    }
  }, 500)
}
async function reviewTransfer() {
  const chainId = $('#send-chain').value, to = $('#send-to').value.trim(), amount = $('#send-amount').value.trim()
  setFormError('send-error', '')
  if (!to) return setFormError('send-error', 'Enter the recipient address.')
  const precision = amounts[chainId] || 18
  if (!amount || !new RegExp(`^\\d+(\\.\\d{1,${precision}})?$`).test(amount) || !/[1-9]/.test(amount)) return setFormError('send-error', `Enter an amount greater than zero with up to ${precision} decimal places.`)
  const button = $('#review-send'); button.disabled = true; button.textContent = 'Checking fee…'
  try {
    const quote = await api('quote', { chain: chainId, to, amount })
    if ($('#send-chain').value !== chainId || $('#send-to').value.trim() !== to || $('#send-amount').value.trim() !== amount) return
    if (!quote.sufficient) {
      setFormError('send-error', `Your balance cannot cover ${amount} ${symbols[chainId]} plus the estimated ${quote.feeFormatted} ${symbols[chainId]} network fee. Use Max or lower the amount.`)
      return
    }
    showTransferReview({ chainId, to, amount, quote })
  } catch (error) { setFormError('send-error', error.message) }
  finally { if (button.isConnected) { button.disabled = false; button.innerHTML = 'Review transfer <span>↗</span>' } }
}
function showTransferReview({ chainId, to, amount, quote }) {
  $('#operation-kicker').textContent = 'CHECK THE DETAILS'
  $('#operation-title').textContent = 'Review transfer'
  $('#operation-content').innerHTML = `<div class="review-summary"><div><small>NETWORK</small><strong>${titles[chainId]} · ${state.chains.find(c => c.id === chainId)?.network}</strong></div><div><small>RECIPIENT</small><code>${escapeHtml(to)}</code></div><div><small>YOU SEND</small><strong>${escapeHtml(amount)} ${symbols[chainId]}</strong></div><div><small>ESTIMATED NETWORK FEE</small><strong>${quote.feeFormatted} ${symbols[chainId]}</strong></div></div><div id="send-review-error" class="form-error hidden" role="alert" aria-live="polite"></div><button type="button" class="button primary full" id="final-send">Confirm and send <span>↗</span></button><button type="button" class="dialog-link" id="edit-send">Back to edit</button>`
  $('#edit-send').addEventListener('click', () => { $('#operation-content').innerHTML = sendForm(); bindSendForm() })
  $('#final-send').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true; button.textContent = 'Sending…'
    try {
      const result = await api('send', { chain: chainId, to, amount })
      $('#operation-dialog').close(); toast(`Transaction submitted: ${addressShort(result.hash)}`); await refreshBalances()
    } catch (error) { setFormError('send-review-error', error.message) }
    finally { if (button.isConnected) { button.disabled = false; button.innerHTML = 'Confirm and send <span>↗</span>' } }
  })
}

function showOperation(type) {
  const dialog = $('#operation-dialog'), content = $('#operation-content')
  $('#operation-kicker').textContent = ({ send: 'SEND FROM YOUR WALLET', receive: 'INCOMING ASSETS', swap: 'SWAP PROVIDER', buy: 'FIAT ON-RAMP' })[type]
  if (type === 'receive') {
    const address = state.addresses[state.activeChain] || Object.values(state.addresses)[0]
    $('#operation-title').textContent = 'Receive crypto'
    content.innerHTML = `<label class="form-label">Network</label><select id="receive-chain">${state.chains.filter(c => state.addresses[c.id]).map(c => `<option value="${c.id}" ${c.id === state.activeChain ? 'selected' : ''}>${titles[c.id]} · ${c.network}</option>`).join('')}</select><div class="address-box" id="receive-address">${escapeHtml(address || 'No active address')}</div><button class="button primary full" id="copy-address">Copy address <span>↗</span></button><p style="margin:12px 0 0">Only send ${symbols[state.activeChain] || 'assets'} on the selected network to this address.</p>`
    dialog.showModal(); $('#receive-chain').addEventListener('change', event => { state.activeChain = event.target.value; $('#receive-address').textContent = state.addresses[state.activeChain] })
    $('#copy-address').addEventListener('click', async event => { event.preventDefault(); try { await navigator.clipboard.writeText($('#receive-address').textContent); toast('Address copied') } catch { toast('Select and copy the address') } }); return
  }
  if (type === 'send') {
    $('#operation-title').textContent = 'Send crypto'
    content.innerHTML = sendForm()
    dialog.showModal(); bindSendForm(); return
  }
  const name = type === 'swap' ? 'Swap tokens' : 'Buy crypto'
  $('#operation-title').textContent = name
  content.innerHTML = `<div class="notice-panel"><h4>${type === 'swap' ? 'Swap service not configured' : 'Purchase provider not configured'}</h4><p>${type === 'swap' ? 'Connect a swap protocol and its provider keys before quoting or executing trades.' : 'Configure a supported fiat on-ramp and API credentials before offering a purchase flow.'}</p></div>`
  dialog.showModal()
}
$$('[data-modal]').forEach(button => button.addEventListener('click', () => showOperation(button.dataset.modal)))
// Handle close in both click and form-submit paths; dialog close must not rely
// on the browser's implicit method="dialog" submit behavior.
$$('.modal-close').forEach(button => { button.type = 'button' })
document.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement
  const closeButton = target?.closest('.modal-close')
  if (!closeButton) return
  event.preventDefault()
  closeButton.closest('dialog')?.close()
}, true)
$$('dialog').forEach(dialog => {
  dialog.addEventListener('click', event => { if (event.target === dialog && dialog.id !== 'phrase-dialog') dialog.close() })
  if (dialog.id === 'phrase-dialog') dialog.addEventListener('cancel', event => event.preventDefault())
  if (dialog.id === 'security-dialog') dialog.addEventListener('close', () => { $('#recovery-words').replaceChildren(); $('#recovery-reveal').classList.add('hidden'); $('#reveal-password').value = '' })
  if (dialog.id === 'register-dialog') dialog.addEventListener('close', () => { $('#register-password').value = ''; $('#register-password-confirm').value = '' })
  if (dialog.id === 'login-dialog') dialog.addEventListener('close', () => { $('#login-password').value = '' })
  if (dialog.id === 'restore-dialog') dialog.addEventListener('close', () => { restoreWords = Array(24).fill(''); $('#restore-password').value = ''; setFormError('restore-error', '') })
})
$$('dialog form').forEach(form => form.addEventListener('submit', event => {
  if (form.id === 'login-form') return
  event.preventDefault()
  const submit = form.querySelector('button[id$="-submit"], #phrase-continue, #confirm-send, #review-send, #final-send')
  if (submit && !submit.disabled) submit.click()
}))

api('state').then(result => { if (result.authenticated) setWallet(result); else { state.token = null; sessionStorage.removeItem('orbit-session') } }).catch(() => {})
