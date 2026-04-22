import { createPublicClient, createWalletClient, custom, formatUnits, getAddress, getContract, http, parseUnits, toHex } from 'viem'
import type { Address, Hex, WalletClient } from 'viem'
import { sepolia } from 'viem/chains'
import 'viem/window';
import type { TransWarpToken, SelfRelayInputs, BurnAccount, TranswarpContractConfig } from '../src/types.js';
import TransWarpTokenArtifact from '../artifacts/contracts/TransWarpToken.sol/TransWarpToken.json' with {"type": "json"};
import sepoliaDeployments from "../ignition/deployments/chain-11155111/deployed_addresses.json" with {"type": "json"};

import * as viem from 'viem'
import { ADDED_BITS_SECURITY, GAS_ESTIMATE_BUFFER_PERCENT, POW_BITS } from '../src/constants.ts';
import { BurnWallet } from '../src/BurnWallet.ts';
import { getContractConfig } from '../src/utils.ts';
import { selfRelayTx } from '../src/transact.ts';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const BURN_WALLET_LS_VERSION = 1;

// @TODO update when ever a new contract is used
const POW_EXPLANATION_MSG = `
The PoW is to generate a valid burn address, a PoW verification was added to the circuit since eth addresses are only 160 bits (20 bytes) and there for only have 80 bits of security against collision attacks. 
<br>See <a href="https://github.com/jimjimvalkema/EIP7503-ERC20/tree/f191226b323340f7f1c1b95ab42a68342860acb6?tab=readme-ov-file#burn-address-and-the-10-billion-collision-attack-eip-3607">readme</a> for more info.
<br>This PoW is ${Number(POW_BITS)} bits and adds ${Number(ADDED_BITS_SECURITY)} bits since it's only applied to one hash (the burn address).
<br>The original cost of attack was assumed to be $10 billion in EIP-3607. 
<br>With this PoW the new estimated cost of attack is $10B × 2^(PoW_Bits/2).
<br>So with this PoW the new attack cost is: $${new Intl.NumberFormat("en-US", { notation: "compact", compactDisplay: "long" }).format(10_000_000_000 * 2 ** (Number(POW_BITS) / 2))}.
`

const BURN_ACCOUNT_SYNCING_MSG = `
syncing the burn account by looking for nullifiers with an account nonce that incrementally go up.
<br> So it looks for <code>nullifier=poseidon2(viewing_key, account_nonce+=1)</code>
<br> Then it also looks the event of that nullifier which contains a encrypted blob that contains the total amount spent of that burn account.
`

const CREATING_PROOF_MSG = `The circuit verifies a signature which is a signed hash containing eip712 structured data. 
<br>The contract then reconstructs this hash, and uses the inputs from the pre-image (recipient,amount,fee,etc). 
<br>This allows for better security and hardware wallet support since the circuit does not require private keys for spending.
<br>Only the viewing key can be compromised not the users funds, if the ui is compromised. (or even machine in case of hardware wallets).
`

const defaultTransWarpTokenAddress = sepoliaDeployments['transwarpToken#TransWarpToken'] as Address;

// read token address from URL ?token=0x... or fall back to deployed default
function getTokenAddressFromUrl(): Address {
    const params = new URLSearchParams(window.location.search)
    const tokenParam = params.get('token')
    if (tokenParam) {
        try {
            return getAddress(tokenParam)
        } catch { /* invalid address, ignore */ }
    }
    return defaultTransWarpTokenAddress
}

function setTokenAddressInUrl(address: Address) {
    const url = new URL(window.location.href)
    url.searchParams.set('token', address)
    window.history.replaceState({}, '', url.toString())
}

let transwarpTokenAddress = getTokenAddressFromUrl()
setTokenAddressInUrl(transwarpTokenAddress)

//@ts-ignore
window.transwarpTokenAddress = transwarpTokenAddress
//@ts-ignore
window.viem = viem
console.log({ transwarpTokenAddress })

const logEl = document.getElementById("messages")
const errorEl = document.getElementById("errors")
const tokenAddressInputEl = document.getElementById('tokenAddressInput') as HTMLInputElement
const tokenLoadStatusEl = document.getElementById('tokenLoadStatus')
const transferRecipientInputEl = document.getElementById('transferRecipientInput')
const transferBurnAddressSelectEl = document.getElementById('transferBurnAddressSelect') as HTMLSelectElement
const transferAmountInputEl = document.getElementById('transferAmountInput')
const privateTransferRecipientInputEl = document.getElementById("privateTransferRecipientInput")
const remintBurnAddressSelectEl = document.getElementById("remintBurnAddressSelect") as HTMLSelectElement
const privateTransferAmountInputEl = document.getElementById("privateTransferAmountInput")
const burnAccountsListEl = document.getElementById("burnAccountsList")
const burnPageLabelEl = document.getElementById("burnPageLabel")
const totalSelectedSpendableEl = document.getElementById("totalSelectedSpendable")
const burnRecipientSelectEl = document.getElementById("burnRecipientSelect") as HTMLSelectElement
const burnAmountInputEl = document.getElementById("burnAmountInput")
const pendingRelayTxsEl = document.getElementById("pendingRelayTxs")
const bulkBurnAmountInputEl = document.getElementById("bulkBurnAmountInput") as HTMLInputElement
const bulkBurnTotalEl = document.getElementById("bulkBurnTotal")
const bulkBurnCountEl = document.getElementById("bulkBurnCount")
const treeSyncStatusEl = document.getElementById("treeSyncStatus")

const BURN_ACCOUNTS_PER_PAGE = 5
let currentBurnPage = 0
// Track which burn addresses are selected for remint across re-renders
const selectedRemintAddresses = new Set<string>()
let selectionInitialized = false
let importInProgress = false
let syncDotInterval: ReturnType<typeof setInterval> | null = null
let treeSyncDotInterval: ReturnType<typeof setInterval> | null = null

function startSyncDotAnimation() {
    if (syncDotInterval) return
    let dotCount = 0
    syncDotInterval = setInterval(() => {
        dotCount = (dotCount % 5) + 1
        const totalPages = Math.max(1, Math.ceil(Math.max(cachedBurnAccounts.length, (currentBurnPage + 1) * BURN_ACCOUNTS_PER_PAGE) / BURN_ACCOUNTS_PER_PAGE))
        burnPageLabelEl!.textContent = `(page ${currentBurnPage + 1} of ${totalPages}) syncing` + ".".repeat(dotCount)
    }, 400)
}

function stopSyncDotAnimation() {
    if (syncDotInterval) { clearInterval(syncDotInterval); syncDotInterval = null }
}

function startTreeSyncAnimation() {
    if (treeSyncDotInterval) return
    let dotCount = 0
    treeSyncDotInterval = setInterval(() => {
        dotCount = (dotCount % 5) + 1
        treeSyncStatusEl!.textContent = "syncing merkle tree" + ".".repeat(dotCount)
    }, 400)
}

function stopTreeSyncAnimation() {
    if (treeSyncDotInterval) { clearInterval(treeSyncDotInterval); treeSyncDotInterval = null }
    treeSyncStatusEl!.textContent = ""
}

const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(process.env.ETHEREUM_RPC),
})

let transwarpToken = getContract({ abi: TransWarpTokenArtifact.abi, address: transwarpTokenAddress, client: { public: publicClient } }) as unknown as TransWarpToken
tokenAddressInputEl.value = transwarpTokenAddress
const contractConfig = await getContractConfig(transwarpTokenAddress, publicClient)
//@ts-ignore
window.contractConfig = contractConfig
setNonWalletInfo(contractConfig)

// --- helpers ---

function errorUi(message: string, error: unknown, replace = false) {
    if (replace) {
        errorEl!.innerText = ""
    }
    errorEl!.innerText += `\n ${message + "\n" + (error as Error).toString()}`
    throw new Error(message, { cause: error })
}

function logUi(message: string, replace = false, useHtml = false, logConsole = true) {
    if (replace) {
        logEl!.innerHTML = ""
    }
    if (useHtml) {
        logEl!.innerHTML += `\n ${message}`
    } else {
        logEl!.innerText += `\n ${message}`
    }
    if (logConsole) {
        console.log(message)
    }
}

async function everyClass(className: string, func: (el: HTMLElement) => void) {
    document.querySelectorAll(className).forEach(async (el) => {
        await func(el as HTMLElement)
    })
}

async function txInUi(txHash: Hex) {
    logUi(`tx sent at: https://sepolia.etherscan.io/tx/${txHash}`, true)
    await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1
    })
}

// --- localStorage relay queue ---

export function addToLocalStorage(key: string, item: any) {
    let localStore = JSON.parse(localStorage.getItem(transwarpTokenAddress) || '{}')
    localStore[key] = item
    localStorage.setItem(transwarpTokenAddress, JSON.stringify(localStore))
}
//@ts-ignore
window.addToLocalStorage = addToLocalStorage

export function getFromLocalStorage(key: string) {
    let localStore = JSON.parse(localStorage.getItem(transwarpTokenAddress) || '{}')
    return localStore[key]
}

const relayerInputsLocalStoreName = "relayerInputs"

export function addRelayInputsToLocalStorage(relayInputs: SelfRelayInputs) {
    let allRelayerInputs = getFromLocalStorage(relayerInputsLocalStoreName)
    allRelayerInputs ??= []
    allRelayerInputs.push(relayInputs)
    addToLocalStorage(relayerInputsLocalStoreName, allRelayerInputs)
}

export async function getRelayInputsFromLocalStorage(): Promise<SelfRelayInputs[]> {
    const allRelayerInputs: SelfRelayInputs[] = getFromLocalStorage(relayerInputsLocalStoreName)
    if (!allRelayerInputs) return []
    const allRelayerInputClean: SelfRelayInputs[] = []
    for (const relayerInput of allRelayerInputs) {

        const blockNumbers = await Promise.all(relayerInput.publicInputs.burn_data_public.map((bData) => transwarpToken.read.nullifiers([BigInt(bData.nullifier)])))
        if (blockNumbers.every((b) => b === 0n)) {
            allRelayerInputClean.push(relayerInput)
        }
    }
    return allRelayerInputClean
}

// --- BurnWallet localStorage ---

function burnWalletLsKey() {
    return `burnWalletData_v${BURN_WALLET_LS_VERSION}`
}

function saveBurnWallet(burnWallet: BurnWallet) {
    const currentExport = JSON.parse(burnWallet.exportWallet({ paranoidMode: false }))
    const stored = localStorage.getItem(burnWalletLsKey())
    if (stored) {
        const storedData = JSON.parse(stored)
        // merge burn accounts per signer so other signers' data isn't lost
        if (storedData.privateData?.burnAccounts && currentExport.privateData?.burnAccounts) {
            currentExport.privateData.burnAccounts = {
                ...storedData.privateData.burnAccounts,
                ...currentExport.privateData.burnAccounts,
            }
        }
    }
    localStorage.setItem(burnWalletLsKey(), JSON.stringify(currentExport))
}

function loadBurnWalletData(): string | null {
    return localStorage.getItem(burnWalletLsKey())
}

// ---

async function setNonWalletInfo(contractConfig: TranswarpContractConfig) {
    const amountFreeTokens = contractConfig.amountFreeTokens
    const name = contractConfig.tokenName
    const ticker = contractConfig.tokenSymbol
    const decimals = contractConfig.tokenDecimals
    const formatAmountFreeTokens = formatUnits(await amountFreeTokens, Number(await decimals))
    everyClass(".amountFreeTokens", (el) => { el.innerText = formatAmountFreeTokens })
    everyClass(".ticker", async (el) => el.innerText = await ticker)
    everyClass(".tokenName", async (el) => el.innerText = await name)
}

// --- wallet info ui ---

async function updateWalletInfoUi(
    transwarpTokenWallet: TransWarpToken,
    publicAddress: Address,
    showBurnMsg = false,
) {

    everyClass(".publicAddress", (el) => el.innerText = publicAddress)
    const decimals = Number(await transwarpTokenWallet.read.decimals())
    const publicBalance = await transwarpTokenWallet.read.balanceOf([publicAddress])
    everyClass(".publicBalance", (el) => el.innerText = formatUnits(publicBalance, decimals))
    //@ts-ignore
    const burnWallet = window.burnWallet as BurnWallet | undefined
    if (!burnWallet) return

    let allBurnAccounts: BurnAccount[]
    try {
        allBurnAccounts = await burnWallet.getBurnAccounts(transwarpTokenWallet.address, { type: "derived" })
    } catch {
        return
    }
    if (allBurnAccounts.length > 0) {
        // render existing burn accounts immediately, sync in background
        updateBurnAccountsListUi(allBurnAccounts, decimals)
        let dotCount = 0;
        const burnMsg = showBurnMsg ? POW_EXPLANATION_MSG : "" + `<br><br>`
        const powInterval = setInterval(() => {
            dotCount = (dotCount % 5) + 1;
            logUi(
                burnMsg +
                "----------Syncing burn Accounts" + ".".repeat(dotCount) + `<br>` +
                BURN_ACCOUNT_SYNCING_MSG + `<br>` +
                "----------Syncing burn Accounts" + ".".repeat(dotCount)
                , true, true, false);
        }, 500);
        const burnAddressesToSync = allBurnAccounts.map((ba) => ba.burnAddress)
        startSyncDotAnimation()
        burnWallet.syncBurnAccounts(transwarpTokenAddress, { burnAddressesToSync, onAccountSynced: () => debouncedReRenderBurnAccounts(burnWallet) })
            .then(async () => {
                await sleep(500)
                clearInterval(powInterval);
                stopSyncDotAnimation()
                const synced = await burnWallet.getBurnAccounts(transwarpTokenAddress, { type: "derived" })
                saveBurnWallet(burnWallet)
                updateBurnAccountsListUi(synced, decimals)
            })
            .catch((e) => {
                clearInterval(powInterval);
                stopSyncDotAnimation()
                console.warn("burn account sync failed", e)
            })
    }
}

// --- burn address list in walletUi ---

let progressRenderTimeout: ReturnType<typeof setTimeout> | null = null
function debouncedReRenderBurnAccounts(burnWallet: BurnWallet, intervalMs = 500) {
    if (progressRenderTimeout) return
    progressRenderTimeout = setTimeout(async () => {
        progressRenderTimeout = null
        try {
            const latest = await burnWallet.getBurnAccounts(transwarpTokenAddress, { type: "derived" })
            updateBurnAccountsListUi(latest, cachedDecimals)
        } catch { }
    }, intervalMs)
}

let cachedDecimals = 18
let cachedBurnAccounts: BurnAccount[] = []
let powDotInterval: ReturnType<typeof setInterval> | null = null
// Track which burn account indices have info expanded (index 0 starts expanded)
const expandedInfoIndices = new Set<number>([0])

function updateTotalSelectedSpendable() {
    //@ts-ignore
    const burnWallet = window.burnWallet as BurnWallet | undefined
    if (!burnWallet) { totalSelectedSpendableEl!.textContent = "0"; return }

    let total = 0n
    for (const addr of selectedRemintAddresses) {
        const ba = cachedBurnAccounts.find((b) => b?.burnAddress === addr)
        if (ba && 'syncData' in ba && ba.syncData) {
            const chainId = toHex(sepolia.id)
            const syncEntry = ba.syncData[chainId]?.[transwarpTokenAddress]
            if (syncEntry) {
                total += BigInt(syncEntry.spendableBalance)
            }
        }
    }
    totalSelectedSpendableEl!.textContent = formatUnits(total, cachedDecimals)
}

function updateBulkBurnTotal() {
    const count = selectedRemintAddresses.size
    bulkBurnCountEl!.textContent = String(count)
    try {
        const amountPerAddress = parseUnits(bulkBurnAmountInputEl.value, cachedDecimals)
        bulkBurnTotalEl!.textContent = formatUnits(amountPerAddress * BigInt(count), cachedDecimals)
    } catch {
        bulkBurnTotalEl!.textContent = "?"
    }
}

function updateBurnAccountsListUi(burnAccounts: BurnAccount[], decimals: number) {
    cachedDecimals = decimals
    cachedBurnAccounts = burnAccounts
    burnAccountsListEl!.innerHTML = ""

    // stop any existing dot animation
    if (powDotInterval) { clearInterval(powDotInterval); powDotInterval = null }

    // on first render with accounts, auto-select #0 if nothing selected yet
    if (!selectionInitialized && burnAccounts.length > 0 && burnAccounts[0]) {
        selectedRemintAddresses.add(burnAccounts[0].burnAddress)
        selectionInitialized = true
    }

    // --- populate all burn address dropdowns (always show ALL accounts, not just current page) ---
    const allBurnSelects = [burnRecipientSelectEl, transferBurnAddressSelectEl, remintBurnAddressSelectEl]
    for (const selectEl of allBurnSelects) {
        selectEl.innerHTML = ""
        const placeholder = document.createElement("option")
        placeholder.value = ""
        placeholder.disabled = true
        placeholder.selected = true
        placeholder.textContent = burnAccounts.length === 0 ? "connect private wallet first" : "set to burn address"
        selectEl.appendChild(placeholder)
        for (let i = 0; i < burnAccounts.length; i++) {
            const ba = burnAccounts[i]
            if (!ba) continue
            const opt = document.createElement("option")
            opt.value = ba.burnAddress
            const short = ba.burnAddress.slice(0, 8) + "…" + ba.burnAddress.slice(-6)
            opt.textContent = `#${i}: ${short}`
            selectEl.appendChild(opt)
        }
    }

    // --- paginated list: always show BURN_ACCOUNTS_PER_PAGE slots ---
    const startIndex = currentBurnPage * BURN_ACCOUNTS_PER_PAGE
    const pageEndIndex = startIndex + BURN_ACCOUNTS_PER_PAGE
    const totalPages = Math.max(1, Math.ceil(Math.max(burnAccounts.length, pageEndIndex) / BURN_ACCOUNTS_PER_PAGE))
    burnPageLabelEl!.textContent = `(page ${currentBurnPage + 1} of ${totalPages})`
    if (importInProgress) { startSyncDotAnimation() }

    const pendingSpans: HTMLElement[] = []

    for (let i = startIndex; i < pageEndIndex; i++) {
        const burnAccount = burnAccounts[i]
        const li = document.createElement("li")
        li.style.marginBottom = "0.4em"
        li.id = `burnAccountLi_${i}`

        if (!burnAccount) {
            // --- placeholder: still doing PoW ---
            const span = document.createElement("span")
            span.textContent = `#${i}: doing PoW...`
            span.className = "powPendingSpan"
            pendingSpans.push(span)
            li.appendChild(span)
        } else {
            const short = burnAccount.burnAddress.slice(0, 8) + "…" + burnAccount.burnAddress.slice(-6)

            // --- remint checkbox: restore from selectedRemintAddresses ---
            const cb = document.createElement("input")
            cb.type = "checkbox"
            cb.name = "remintBurnAddresses"
            cb.value = burnAccount.burnAddress
            cb.id = `remintBurnCb_${i}`
            cb.checked = selectedRemintAddresses.has(burnAccount.burnAddress)
            cb.addEventListener("change", () => {
                if (cb.checked) {
                    selectedRemintAddresses.add(burnAccount.burnAddress)
                } else {
                    selectedRemintAddresses.delete(burnAccount.burnAddress)
                }
                updateTotalSelectedSpendable()
                updateBulkBurnTotal()
            })

            const chainId = toHex(sepolia.id)
            const syncEntry = ('syncData' in burnAccount && burnAccount.syncData)
                ? burnAccount.syncData[chainId]?.[transwarpTokenAddress]
                : undefined

            const cbLabel = document.createElement("label")
            cbLabel.htmlFor = cb.id
            cbLabel.innerHTML = ` #${i}: ${short} <br> Spendable: ${formatUnits(BigInt(syncEntry ? syncEntry.spendableBalance : 0), decimals)} `

            // --- show info toggle ---
            const infoDiv = document.createElement("div")
            infoDiv.style.fontSize = "85%"
            infoDiv.style.marginLeft = "1.5em"
            const isExpanded = expandedInfoIndices.has(i)
            infoDiv.style.display = isExpanded ? "block" : "none"

            if (syncEntry) {
                infoDiv.innerHTML =
                    `burn address: ${burnAccount.burnAddress}<br>` +
                    `burned balance: ${formatUnits(BigInt(syncEntry.totalBurned), decimals)}<br>` +
                    `private minted balance: ${formatUnits(BigInt(syncEntry.totalMinted), decimals)}<br>` +
                    `spendable balance: ${formatUnits(BigInt(syncEntry.spendableBalance), decimals)}<br>` +
                    `account nonce (txs made): ${Number(syncEntry.accountNonce)}`
            } else {
                infoDiv.textContent = "(not synced yet)"
            }

            const toggleBtn = document.createElement("button")
            toggleBtn.textContent = isExpanded ? "hide info" : "show info"
            toggleBtn.style.fontSize = "70%"
            toggleBtn.addEventListener("click", () => {
                const visible = infoDiv.style.display !== "none"
                infoDiv.style.display = visible ? "none" : "block"
                toggleBtn.textContent = visible ? "show info" : "hide info"
                if (visible) {
                    expandedInfoIndices.delete(i)
                } else {
                    expandedInfoIndices.add(i)
                }
            })

            li.appendChild(cb)
            li.appendChild(cbLabel)
            li.appendChild(toggleBtn)
            li.appendChild(infoDiv)
        }

        burnAccountsListEl!.appendChild(li)
    }

    // animate dots on pending spans
    if (pendingSpans.length > 0) {
        let dotCount = 0
        powDotInterval = setInterval(() => {
            dotCount = (dotCount % 5) + 1
            for (const span of pendingSpans) {
                const idx = span.textContent?.match(/#(\d+)/)?.[1] ?? "?"
                span.textContent = `#${idx}: doing PoW` + ".".repeat(dotCount)
            }
        }, 400)
    }

    updateTotalSelectedSpendable()
    updateBulkBurnTotal()
}

function getSelectedRemintBurnAddresses(): Address[] {
    return Array.from(selectedRemintAddresses) as Address[]
}

// --- wallet connection ---

async function connectPublicWallet() {
    if (!('ethereum' in window)) {
        throw new Error('No Ethereum wallet detected. Please install MetaMask.')
    }

    const tempWalletClient = createWalletClient({
        chain: sepolia,
        transport: custom(window.ethereum!),
    })

    try {
        await tempWalletClient.switchChain({ id: sepolia.id })
        const addresses = await tempWalletClient.requestAddresses()

        // recreate with account set so BurnWallet can use it
        const walletClient = createWalletClient({
            account: addresses[0],
            chain: sepolia,
            transport: custom(window.ethereum!),
        })

        //@ts-ignore
        window.publicAddress = addresses[0]
        //@ts-ignore
        window.publicWallet = walletClient

        const transwarpTokenWallet = getContract({
            abi: TransWarpTokenArtifact.abi,
            address: transwarpTokenAddress,
            client: { wallet: walletClient, public: publicClient }
        }) as unknown as TransWarpToken

        //@ts-ignore
        window.transwarpTokenWallet = transwarpTokenWallet
        // tree sync is handled by connectBurnWallet / getBurnWallet, not here
        updateWalletInfoUi(transwarpTokenWallet, addresses[0])
        return { address: addresses[0], publicWallet: walletClient }
    } catch (error) {
        errorUi("wallet connection failed. try installing metamask?", error)
        throw error
    }
}

async function getPublicWallet() {
    //@ts-ignore
    if (!window.publicWallet) {
        await connectPublicWallet()
    }
    //@ts-ignore
    const publicWallet = window.publicWallet as WalletClient
    //@ts-ignore
    const transwarpTokenWallet = window.transwarpTokenWallet as TransWarpToken
    //@ts-ignore
    const publicAddress = window.publicAddress as Address
    return { publicWallet, transwarpTokenWallet, publicAddress }
}

/**
 * Generates and syncs burn accounts for a given page if they don't already exist.
 * Creates all missing accounts in parallel with async PoW.
 * Progressively updates the UI as each account finishes.
 */
async function ensurePageAccounts(page: number, burnWallet: BurnWallet, clearMsg = true) {
    const startIndex = page * BURN_ACCOUNTS_PER_PAGE
    const endIndex = startIndex + BURN_ACCOUNTS_PER_PAGE
    const decimals = Number(await transwarpToken.read.decimals())
    // figure out which indices need generating
    const indicesToGenerate: number[] = []
    let allBurnAccounts: BurnAccount[]
    try {
        allBurnAccounts = await burnWallet.getBurnAccounts(transwarpTokenAddress, { type: "derived" })
    } catch {
        allBurnAccounts = []
    }
    for (let i = startIndex; i < endIndex; i++) {
        if (!allBurnAccounts[i]) {
            indicesToGenerate.push(i)
        }
    }
    if (indicesToGenerate.length === 0) return

    // render the page now — missing accounts show as "doing PoW..."
    updateBurnAccountsListUi(allBurnAccounts, decimals)

    // generate + sync each account, re-render as each one completes
    logUi(
        `<br><br>` + POW_EXPLANATION_MSG + `<br><br>`
        , clearMsg, true)
    const perAccountPromises = indicesToGenerate.map((i) =>
        burnWallet.createBurnAccount(transwarpTokenAddress, { async: true, viewingKeyIndex: i })
            .then(async (ba) => {
                await burnWallet.syncBurnAccounts(transwarpTokenAddress, { burnAddressesToSync: [ba.burnAddress] })
                saveBurnWallet(burnWallet)
                // re-render so this account replaces its placeholder
                if (currentBurnPage === page) {
                    const updatedBurnAccounts = await burnWallet.getBurnAccounts(transwarpTokenAddress, { type: "derived" })
                    updateBurnAccountsListUi(updatedBurnAccounts, decimals)
                }
            })
    )

    await Promise.all(perAccountPromises)
}

async function connectBurnWallet() {
    const { publicWallet, publicAddress, transwarpTokenWallet } = await getPublicWallet()

    const chainId = await publicClient.getChainId()

    const burnWallet = new BurnWallet(publicWallet, {
        archiveNodes: { [chainId]: publicClient },
        acceptedChainIds: [chainId],
        //@ts-ignore
        contractConfigs: { [chainId]: window.contractConfig }
    })

    const storedData = loadBurnWalletData()
    await burnWallet.connect(publicWallet)
    //@ts-ignore
    window.burnWallet = burnWallet

    // start merkle tree sync in background (before import so they run concurrently)
    startTreeSyncAnimation()
    burnWallet.syncTree(transwarpTokenAddress)
        .then(() => { stopTreeSyncAnimation(); saveBurnWallet(burnWallet) })
        .catch(e => { stopTreeSyncAnimation(); console.warn("background tree sync failed", e) })

    if (storedData) {
        logUi("restoring private wallet from local storage...\n please sign the message in your wallet", true)
        importInProgress = true
        await burnWallet.importWallet(storedData, transwarpTokenAddress, {
            forceReSign: false, onlyImportSigner: true,
            onAccountImported: () => debouncedReRenderBurnAccounts(burnWallet)
        })
        importInProgress = false
        stopSyncDotAnimation()
    }

    // generate first page of burn accounts in parallel (UI updates progressively)
    currentBurnPage = 0
    await ensurePageAccounts(0, burnWallet, false)
    saveBurnWallet(burnWallet)

    const decimals = (await burnWallet.getContractConfig(transwarpToken.address)).tokenDecimals
    const allBurnAccounts = await burnWallet.getBurnAccounts(transwarpTokenAddress, { type: "derived" })
    updateBurnAccountsListUi(allBurnAccounts, decimals)

    logUi("done! created private wallet with burn addresses", false, true)
}

async function reconnectBurnWalletSigner(burnWallet: BurnWallet, walletClient: WalletClient) {
    await burnWallet.connect(walletClient)
    const storedData = loadBurnWalletData()
    if (storedData) {
        importInProgress = true
        await burnWallet.importWallet(storedData, transwarpTokenAddress, {
            forceReSign: false, onlyImportSigner: true,
            onAccountImported: () => debouncedReRenderBurnAccounts(burnWallet)
        })
        importInProgress = false
        stopSyncDotAnimation()
    }
    startTreeSyncAnimation()
    burnWallet.syncTree(transwarpTokenAddress)
        .then(() => { stopTreeSyncAnimation(); saveBurnWallet(burnWallet) })
        .catch(e => { stopTreeSyncAnimation(); console.warn("background tree sync failed", e) })
}

async function getBurnWallet() {
    const { publicWallet, transwarpTokenWallet, publicAddress } = await getPublicWallet()
    if ("burnWallet" in window === false) {
        await connectBurnWallet()
    } else if (publicWallet.account?.address !== (window.burnWallet as BurnWallet).viemWallet.account?.address) {
        await reconnectBurnWalletSigner(window.burnWallet as BurnWallet, publicWallet)
    }

    //@ts-ignore
    const burnWallet = window.burnWallet as BurnWallet
    return { publicWallet, transwarpTokenWallet, publicAddress, burnWallet }
}

// --- post-tx refresh ---

async function refreshAfterTx() {
    const burnWallet = (window as any).burnWallet as BurnWallet | undefined
    const transwarpTokenWallet = (window as any).transwarpTokenWallet as TransWarpToken | undefined
    const publicAddress = (window as any).publicAddress as Address | undefined

    if (!transwarpTokenWallet || !publicAddress) return

    const decimals = Number(await transwarpToken.read.decimals())

    // update public balance
    const publicBalance = await transwarpTokenWallet.read.balanceOf([publicAddress])
    everyClass(".publicBalance", (el) => el.innerText = formatUnits(publicBalance, decimals))

    if (!burnWallet) return

    let allBurnAccounts: BurnAccount[]
    try {
        allBurnAccounts = await burnWallet.getBurnAccounts(transwarpTokenAddress, { type: "derived" })
    } catch { return }

    if (allBurnAccounts.length === 0) return

    const burnAddressesToSync = allBurnAccounts.map((ba) => ba.burnAddress)
    await burnWallet.syncBurnAccounts(transwarpTokenAddress, { burnAddressesToSync })

    // re-fetch after sync and update UI
    const synced = await burnWallet.getBurnAccounts(transwarpTokenAddress, { type: "derived" })
    saveBurnWallet(burnWallet)
    updateBurnAccountsListUi(synced, decimals)

    // refresh public balance again in case it changed during sync (e.g. relay)
    const updatedPublicBalance = await transwarpTokenWallet.read.balanceOf([publicAddress])
    everyClass(".publicBalance", (el) => el.innerText = formatUnits(updatedPublicBalance, decimals))
}

// --- handlers ---

async function mintBtnHandler() {
    const { publicAddress, transwarpTokenWallet } = await getPublicWallet()
    try {
        const tx = await transwarpTokenWallet.write.getFreeTokens([publicAddress], { account: publicAddress, chain: sepolia })
        await txInUi(tx)
    } catch (error) {
        errorUi("aaa that didn't work :( did you cancel it?", error)
        return
    }

    await refreshAfterTx()
}

function prevBurnAccountsPageHandler() {
    if (currentBurnPage <= 0) return
    currentBurnPage -= 1
    updateBurnAccountsListUi(cachedBurnAccounts, cachedDecimals)
}

async function nextBurnAccountsPageHandler() {
    //@ts-ignore
    const burnWallet = window.burnWallet as BurnWallet | undefined
    if (!burnWallet) return
    currentBurnPage += 1
    updateBurnAccountsListUi(cachedBurnAccounts, cachedDecimals)

    if (!importInProgress) {
        try {
            await ensurePageAccounts(currentBurnPage, burnWallet)
        } catch (error) {
            currentBurnPage -= 1
            errorUi("failed to generate burn addresses for next page", error)
            return
        }
        const decimals = Number(await transwarpToken.read.decimals())
        const updated = await burnWallet.getBurnAccounts(transwarpTokenAddress, { type: "derived" })
        updateBurnAccountsListUi(updated, decimals)
        logUi(`page ${currentBurnPage + 1} ready`, false, true)
    }
}

function selectAllRemintHandler() {
    //@ts-ignore
    const burnWallet = window.burnWallet as BurnWallet | undefined
    if (!burnWallet) return

    const allSelected = cachedBurnAccounts.every((b) => b && selectedRemintAddresses.has(b.burnAddress))

    if (allSelected) {
        selectedRemintAddresses.clear()
    } else {
        for (const b of cachedBurnAccounts) {
            if (b?.burnAddress) selectedRemintAddresses.add(b.burnAddress)
        }
    }

    const checkboxes = Array.from(burnAccountsListEl!.querySelectorAll<HTMLInputElement>('input[name="remintBurnAddresses"]'))
    for (const cb of checkboxes) {
        cb.checked = selectedRemintAddresses.has(cb.value)
    }
    updateTotalSelectedSpendable()
    updateBulkBurnTotal()
}

async function setToPublicAddressBtnHandler(where: HTMLElement) {
    const { publicAddress } = await getPublicWallet()
        ; (where as HTMLInputElement).value = publicAddress
}

async function transferBtnHandler() {
    const { transwarpTokenWallet, publicAddress } = await getPublicWallet()
    const decimals = Number(await transwarpToken.read.decimals())
    const amount = parseUnits((transferAmountInputEl as HTMLInputElement).value, decimals)

    let to: Address
    try {
        to = getAddress((transferRecipientInputEl as HTMLInputElement).value)
    } catch (error) {
        errorUi("this might not be a valid address?", error)
        return
    }

    try {
        const estimatedGas = await transwarpTokenWallet.estimateGas.transfer([to, amount], { account: publicAddress })
        const tx = await transwarpTokenWallet.write.transfer([to, amount], { chain: sepolia, account: publicAddress, gas: estimatedGas * GAS_ESTIMATE_BUFFER_PERCENT / 100n })
        await txInUi(tx)
    } catch (error) {
        errorUi("Something wrong, did you cancel?", error)
        return
    }

    await refreshAfterTx()
}

async function burnBtnHandler() {
    const { transwarpTokenWallet, publicAddress, burnWallet } = await getBurnWallet()
    const decimals = Number(await transwarpToken.read.decimals())

    const to = burnRecipientSelectEl.value as Address
    if (!to) {
        errorUi("please select a burn address", new Error("no burn address selected"))
        return
    }

    let amount: bigint
    try {
        amount = parseUnits((burnAmountInputEl as HTMLInputElement).value, decimals)
    } catch (error) {
        errorUi("something went wrong, is this not a valid number?", error)
        return
    }

    // superSafeBurn needs a burn account — verify the recipient matches a known one
    const allBurnAccounts = await burnWallet.getBurnAccounts(transwarpTokenAddress, { type: "derived" })
    const targetBurnAccount = allBurnAccounts.find((b) => b.burnAddress === to)
    if (!targetBurnAccount) {
        logUi("WARNING: not a known burn address")
        return
    }

    logUi("running superSafeBurn checks and sending tx...", true)
    try {
        const txHash = await burnWallet.superSafeBurn(transwarpTokenAddress, amount, targetBurnAccount)
        await txInUi(txHash as Hex)
    } catch (error) {
        errorUi("safe burn failed", error)
        return
    }

    await refreshAfterTx()
}

async function bulkBurnBtnHandler() {
    const { burnWallet } = await getBurnWallet()
    const decimals = Number(await transwarpToken.read.decimals())

    let amountPerAddress: bigint
    try {
        amountPerAddress = parseUnits(bulkBurnAmountInputEl.value, decimals)
    } catch (error) {
        errorUi("something went wrong, is this not a valid number?", error)
        return
    }

    const selected = getSelectedRemintBurnAddresses()
    if (selected.length === 0) {
        errorUi("select at least one burn address from the list above", new Error("no burn addresses selected"))
        return
    }

    const allBurnAccounts = await burnWallet.getBurnAccounts(transwarpTokenAddress, { type: "derived" })
    const recipientsAndAmounts: { burnAccount: BurnAccount, amount: bigint }[] = []
    for (const address of selected) {
        const burnAccount = allBurnAccounts.find((b) => b.burnAddress === address)
        if (!burnAccount) {
            errorUi(`burn address ${address} is not a known burn account`, new Error("unknown burn address"))
            return
        }
        recipientsAndAmounts.push({ burnAccount, amount: amountPerAddress })
    }

    logUi(`running superSafeBurnBulk checks and sending tx for ${selected.length} addresses...`, true)
    try {
        const txHash = await burnWallet.superSafeBurnBulk(transwarpTokenAddress, recipientsAndAmounts)
        await txInUi(txHash as Hex)
    } catch (error) {
        errorUi("bulk burn failed", error)
        return
    }

    await refreshAfterTx()
}

async function proofPrivateTransferBtnHandler() {
    const { transwarpTokenWallet, publicAddress, burnWallet } = await getBurnWallet()
    const decimals = Number(await transwarpToken.read.decimals())

    let recipient: Address
    try {
        recipient = getAddress((privateTransferRecipientInputEl as HTMLInputElement).value)
    } catch (error) {
        errorUi("something went wrong, is it a real address?", error)
        return
    }

    let amount: bigint
    try {
        amount = parseUnits((privateTransferAmountInputEl as HTMLInputElement).value, decimals)
    } catch (error) {
        errorUi("something went wrong, is this not a valid number?", error)
        return
    }

    // get selected burn addresses from checkboxes
    const selectedBurnAddresses = getSelectedRemintBurnAddresses()
    if (selectedBurnAddresses.length === 0) {
        errorUi("please select at least one burn address to spend from", new Error("no burn addresses selected"))
        return
    }

    try {
        // 1. sync tree + accounts concurrently to the same block
        logUi("syncing burn accounts..." + `<br>` + BURN_ACCOUNT_SYNCING_MSG, true, true, true)
        const { syncedTree, syncedBurnAccounts } = burnWallet.sync(transwarpTokenAddress, {
            burnAddressesToSync: selectedBurnAddresses,
        })

        // 2. wait for accounts (needed before selection)
        await syncedBurnAccounts

        // 3. select burn accounts for spend
        logUi("selecting burn accounts for spend...", true, true, true)
        const selection = await burnWallet.selectBurnAccountsForSpend(transwarpTokenAddress, amount, {
            burnAddresses: selectedBurnAddresses,
        })

        // 4. sign
        logUi("signing transaction... please sign in your wallet", true, true, true)
        const signed = await burnWallet.signReMint(recipient, selection)

        // 5. wait for tree sync
        logUi("waiting for tree sync to finish...", true, true, true)
        await syncedTree

        // 6. generate proof (animated)
        let dotCount = 0;
        const proofInterval = setInterval(() => {
            dotCount = (dotCount % 5) + 1;
            logUi(
                "generating zero-knowledge proof" + ".".repeat(dotCount) + "<br><br>" +
                CREATING_PROOF_MSG
                , true, true, false);
        }, 500);

        const selfRelayInputs = await burnWallet.proof(signed)
        clearInterval(proofInterval)

        addRelayInputsToLocalStorage(selfRelayInputs)
        saveBurnWallet(burnWallet)
    } catch (error) {
        errorUi("proof creation failed", error)
    }
    logUi("proof done! saved to pending relay txs")
    await refreshAfterTx()
    await listPendingRelayTxs()
}

async function listPendingRelayTxs() {
    pendingRelayTxsEl!.innerHTML = ""
    const relayInputs = await getRelayInputsFromLocalStorage()
    const decimals = Number(await transwarpToken.read.decimals())
    for (const relayInput of relayInputs) {
        const relayFunc = async () => {
            const { publicAddress, transwarpTokenWallet, publicWallet } = await getPublicWallet()
            //@ts-ignore
            const burnWallet = window.burnWallet as BurnWallet | undefined
            try {
                let tx: Hex
                if (publicWallet) {
                    tx = await selfRelayTx(relayInput, publicWallet)
                    // is nice but i dont want to force signin and PoW just to relay a tx
                    //tx = await burnWallet.selfRelayTx(relayInput)
                } else {
                    // fallback: import selfRelayTx would be needed, but BurnWallet should always exist here
                    throw new Error("connect wallet first")
                }
                await txInUi(tx)
                await listPendingRelayTxs()
                await refreshAfterTx()
            } catch (error) {
                errorUi("relay failed", error)
            }
        }
        const relayTxBtn = document.createElement("button")
        relayTxBtn.onclick = relayFunc
        relayTxBtn.innerText = `relay tx: ${formatUnits(BigInt(relayInput.publicInputs.amount), decimals)} tokens to ${relayInput.signatureInputs.recipient}`
        const li = document.createElement("li")
        li.appendChild(relayTxBtn)
        pendingRelayTxsEl!.appendChild(li)
    }
}

// --- event listeners ---

async function loadTokenHandler() {
    const input = tokenAddressInputEl.value.trim()
    let newAddress: Address
    try {
        newAddress = getAddress(input)
    } catch {
        tokenLoadStatusEl!.textContent = "invalid address"
        return
    }

    tokenLoadStatusEl!.textContent = "loading..."

    // update globals
    transwarpTokenAddress = newAddress
    //@ts-ignore
    window.transwarpTokenAddress = transwarpTokenAddress
    setTokenAddressInUrl(transwarpTokenAddress)

    // recreate read-only contract
    transwarpToken = getContract({ abi: TransWarpTokenArtifact.abi, address: transwarpTokenAddress, client: { public: publicClient } }) as unknown as TransWarpToken
    // reset private wallet state
    //@ts-ignore
    window.burnWallet = undefined
    selectedRemintAddresses.clear()
    selectionInitialized = false
    currentBurnPage = 0
    burnAccountsListEl!.innerHTML = "<li>connect private wallet first</li>"
    burnPageLabelEl!.textContent = ""
    totalSelectedSpendableEl!.textContent = "0"
    bulkBurnTotalEl!.textContent = "0"
    bulkBurnCountEl!.textContent = "0"

    // if public wallet connected, recreate the wallet-bound contract
    //@ts-ignore
    if (window.publicWallet) {
        //@ts-ignore
        const walletClient = window.publicWallet as WalletClient
        const transwarpTokenWallet = getContract({
            abi: TransWarpTokenArtifact.abi,
            address: transwarpTokenAddress,
            client: { wallet: walletClient, public: publicClient }
        }) as unknown as TransWarpToken
        //@ts-ignore
        window.transwarpTokenWallet = transwarpTokenWallet
        //@ts-ignore
        await updateWalletInfoUi(transwarpTokenWallet, window.publicAddress as Address)
    }

    try {
        const contractConfig = await getContractConfig(transwarpTokenAddress, publicClient)
        //@ts-ignore
        window.contractConfig = contractConfig
        //@ts-ignore
        await setNonWalletInfo(window.contractConfig)
        tokenLoadStatusEl!.textContent = "loaded!"
        setTimeout(() => { tokenLoadStatusEl!.textContent = "" }, 2000)
    } catch (error) {
        tokenLoadStatusEl!.textContent = "failed - is this a valid TransWarpToken?"
        console.error(error)
    }

    await listPendingRelayTxs()
}

document.getElementById('loadTokenBtn')?.addEventListener('click', loadTokenHandler)
// also load on Enter in the input
tokenAddressInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadTokenHandler()
})
document.getElementById('connectPublicWalletBtn')?.addEventListener('click', connectPublicWallet)
document.getElementById('connectPrivateWalletBtn')?.addEventListener('click', connectBurnWallet)
document.getElementById('mintBtn')?.addEventListener('click', mintBtnHandler)
document.getElementById('setToPublicWalletBtn')?.addEventListener('click', () => setToPublicAddressBtnHandler(transferRecipientInputEl!))
document.getElementById('setPrivateTransferToPublicWalletBtn')?.addEventListener('click', () => setToPublicAddressBtnHandler(privateTransferRecipientInputEl!))
transferBurnAddressSelectEl.addEventListener('change', () => {
    (transferRecipientInputEl as HTMLInputElement).value = transferBurnAddressSelectEl.value
})
remintBurnAddressSelectEl.addEventListener('change', () => {
    (privateTransferRecipientInputEl as HTMLInputElement).value = remintBurnAddressSelectEl.value
})
document.getElementById('transferBtn')?.addEventListener('click', transferBtnHandler)
document.getElementById('prevBurnAccountsPage')?.addEventListener('click', prevBurnAccountsPageHandler)
document.getElementById('nexBurnAccountsPage')?.addEventListener('click', nextBurnAccountsPageHandler)
document.getElementById('selectAllRemintBtn')?.addEventListener('click', selectAllRemintHandler)
document.getElementById('burnBtn')?.addEventListener('click', burnBtnHandler)
document.getElementById('bulkBurnBtn')?.addEventListener('click', bulkBurnBtnHandler)
bulkBurnAmountInputEl.addEventListener('input', updateBulkBurnTotal)
document.getElementById('proofPrivaterTransferBtn')?.addEventListener('click', proofPrivateTransferBtnHandler)

// update UI when user switches accounts or chain in MetaMask
if ('ethereum' in window && window.ethereum) {
    window.ethereum.on('accountsChanged', async (accounts: string[]) => {
        if (accounts.length === 0) {
            // user disconnected all accounts
            //@ts-ignore
            window.publicAddress = undefined
            //@ts-ignore
            window.publicWallet = undefined
            //@ts-ignore
            window.transwarpTokenWallet = undefined
            return
        }
        // skip if no previous account (initial connection) or address hasn't changed
        //@ts-ignore
        if (!window.publicAddress || window.publicAddress.toLowerCase() === accounts[0].toLowerCase()) return
        // re-connect with the new account
        try {
            // reconnect burn wallet with new signer BEFORE connectPublicWallet,
            // because connectPublicWallet calls updateWalletInfoUi which needs the burn accounts
            const burnWallet = (window as any).burnWallet as BurnWallet | undefined
            if (burnWallet) {
                const newWalletClient = createWalletClient({
                    account: getAddress(accounts[0]),
                    chain: sepolia,
                    transport: custom(window.ethereum!),
                })
                await reconnectBurnWalletSigner(burnWallet, newWalletClient)
            }

            await connectPublicWallet()
            if (burnWallet) {
                await ensurePageAccounts(0, burnWallet, false)
            }
        } catch (error) {
            console.error('Failed to switch account', error)
        }
    })
}

listPendingRelayTxs()