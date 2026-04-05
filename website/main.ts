import { createPublicClient, createWalletClient, custom, formatUnits, getAddress, getContract, http, parseUnits, toHex } from 'viem'
import type { Address, Hex, WalletClient } from 'viem'
import { sepolia } from 'viem/chains'
import 'viem/window';
import type { WormholeToken, SelfRelayInputs, BurnAccount, PreSyncedTree, PreSyncedTreeStringifyable } from '../src/types.js';
import { selfRelayTx, superSafeBurn } from '../src/transact.js';
import WormholeTokenArtifact from '../artifacts/contracts/WormholeToken.sol/WormholeToken.json' with {"type": "json"};
import sepoliaDeployments from "../ignition/deployments/chain-11155111/deployed_addresses.json" with {"type": "json"};
import type { WormholeTokenTest } from '../test/reMint3.test.ts';

import * as viem from 'viem'
import { ADDED_BITS_SECURITY, POW_BITS } from '../src/constants.ts';
import { syncBurnAccount, getSyncedMerkleTree, poseidon2IMTHashFunc } from '../src/syncing.ts';
import { LeanIMT } from '@zk-kit/lean-imt';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const defaultWormholeTokenAddress = sepoliaDeployments['wormholeToken#WormholeToken'] as Address;

// read token address from URL ?token=0x... or fall back to deployed default
function getTokenAddressFromUrl(): Address {
  const params = new URLSearchParams(window.location.search)
  const tokenParam = params.get('token')
  if (tokenParam) {
    try {
      return getAddress(tokenParam)
    } catch { /* invalid address, ignore */ }
  }
  return defaultWormholeTokenAddress
}

function setTokenAddressInUrl(address: Address) {
  const url = new URL(window.location.href)
  url.searchParams.set('token', address)
  window.history.replaceState({}, '', url.toString())
}

let wormholeTokenAddress = getTokenAddressFromUrl()
setTokenAddressInUrl(wormholeTokenAddress)

//@ts-ignore
window.wormholeTokenAddress = wormholeTokenAddress
//@ts-ignore
window.viem = viem
console.log({ wormholeTokenAddress })

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

const BURN_ACCOUNTS_PER_PAGE = 5
let currentBurnPage = 0
// Track which burn addresses are selected for remint across re-renders
const selectedRemintAddresses = new Set<string>()
let selectionInitialized = false

const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(process.env.ETHEREUM_RPC),
})

let wormholeToken = getContract({ abi: WormholeTokenArtifact.abi, address: wormholeTokenAddress, client: { public: publicClient } }) as unknown as WormholeToken
tokenAddressInputEl.value = wormholeTokenAddress
setNonWalletInfo(wormholeToken)

// --- helpers ---

function errorUi(message: string, error: unknown, replace = false) {
    if (replace) {
        errorEl!.innerText = ""
    }
    errorEl!.innerText += `\n ${message + "\n" + (error as Error).toString()}`
    throw new Error(message, { cause: error })
}

function logUi(message: string, replace = false, useHtml = false, logConsole=true) {
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
    let localStore = JSON.parse(localStorage.getItem(wormholeTokenAddress) || '{}')
    localStore[key] = item
    localStorage.setItem(wormholeTokenAddress, JSON.stringify(localStore))
}
//@ts-ignore
window.addToLocalStorage = addToLocalStorage

export function getFromLocalStorage(key: string) {
    let localStore = JSON.parse(localStorage.getItem(wormholeTokenAddress) || '{}')
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

        const blockNumbers = await Promise.all(relayerInput.publicInputs.burn_data_public.map((bData) => wormholeToken.read.nullifiers([BigInt(bData.nullifier)])))
        if (blockNumbers.every((b) => b === 0n)) {
            allRelayerInputClean.push(relayerInput)
        }
    }
    return allRelayerInputClean
}

// --- merkle tree localStorage ---

function savePreSyncedTree(preSyncedTree: PreSyncedTree) {
    const serialized: PreSyncedTreeStringifyable = {
        exportedNodes: preSyncedTree.tree.export(),
        lastSyncedBlock: toHex(preSyncedTree.lastSyncedBlock),
        firstSyncedBlock: toHex(preSyncedTree.firstSyncedBlock),
    }
    localStorage.setItem(`merkleTree_${wormholeTokenAddress}`, JSON.stringify(serialized))
}

function loadPreSyncedTree(): PreSyncedTree | null {
    const raw = localStorage.getItem(`merkleTree_${wormholeTokenAddress}`)
    if (!raw) return null
    try {
        const data = JSON.parse(raw) as PreSyncedTreeStringifyable
        const tree = LeanIMT.import(poseidon2IMTHashFunc, data.exportedNodes)
        return { tree, lastSyncedBlock: BigInt(data.lastSyncedBlock), firstSyncedBlock: BigInt(data.firstSyncedBlock) }
    } catch {
        return null
    }
}

// ---

// --- private wallet localStorage ---

function privateWalletLsKey(ethAccount: Address) {
    return `burnWalletData_${ethAccount}`
}

function savePrivateWalletData(privateWallet: BurnViewKeyManager) {
    localStorage.setItem(privateWalletLsKey(privateWallet.privateData.ethAccount), JSON.stringify(privateWallet.privateData))
}

function loadPrivateWalletData(ethAccount: Address): ViewKeyData | null {
    const raw = localStorage.getItem(privateWalletLsKey(ethAccount))
    if (!raw) return null
    try {
        const data = JSON.parse(raw) as ViewKeyData
        if (data.ethAccount?.toLowerCase() !== ethAccount.toLowerCase()) return null
        return data
    } catch {
        return null
    }
}

// ---

async function setNonWalletInfo(wormholeToken: WormholeToken) {
    const amountFreeTokens = wormholeToken.read.amountFreeTokens()
    const name = wormholeToken.read.name()
    const ticker = wormholeToken.read.symbol()
    const decimals = wormholeToken.read.decimals()
    const formatAmountFreeTokens = formatUnits(await amountFreeTokens, Number(await decimals))
    everyClass(".amountFreeTokens", (el) => { el.innerText = formatAmountFreeTokens })
    everyClass(".ticker", async (el) => el.innerText = await ticker)
    everyClass(".tokenName", async (el) => el.innerText = await name)
}

// --- wallet info ui ---

async function updateWalletInfoUi(
    wormholeTokenWallet: WormholeToken,
    publicAddress: Address,
    burnAccount?: BurnAccount,
    showBurnMsg = false
) {

    everyClass(".publicAddress", (el) => el.innerText = publicAddress)
    const decimals = Number(await wormholeTokenWallet.read.decimals())
    const publicBalance = await wormholeTokenWallet.read.balanceOf([publicAddress])
    everyClass(".publicBalance", (el) => el.innerText = formatUnits(publicBalance, decimals))
    //@ts-ignore
    const privateWallet = window.privateWallet as BurnViewKeyManager | undefined
    const allBurnAccounts = privateWallet ? getDeterministicBurnAccounts(privateWallet) : [];
    if (privateWallet && allBurnAccounts.length > 0) {
        let dotCount = 0;
        const burnMsg = showBurnMsg ? POW_EXPLANATION_MSG : "" + `<br><br>`
        const powInterval = setInterval(() => {
            dotCount = (dotCount % 5) + 1;
            logUi(
                burnMsg +
                "----------Syncing burn Accounts" + ".".repeat(dotCount) + `<br>` +
                BURN_ACCOUNT_SYNCING_MSG + `<br>` +
                "----------Syncing burn Accounts" + ".".repeat(dotCount)
                , true, true,false);
        }, 500);
        const syncPromises = allBurnAccounts.map((ba) =>
            syncBurnAccount({ wormholeToken: wormholeTokenWallet, burnAccount: ba, archiveNode: publicClient })
                .then((synced) => { privateWallet.importBurnAccount(synced) })
        )
        await Promise.all(syncPromises)
        await sleep(500)
        clearInterval(powInterval);
        updateBurnAccountsListUi(getDeterministicBurnAccounts(privateWallet), decimals)
    }
}

// --- burn address list in walletUi ---

let cachedDecimals = 18
let powDotInterval: ReturnType<typeof setInterval> | null = null

function updateTotalSelectedSpendable() {
    //@ts-ignore
    const privateWallet = window.privateWallet as BurnViewKeyManager | undefined
    if (!privateWallet) { totalSelectedSpendableEl!.textContent = "0"; return }

    let total = 0n
    for (const addr of selectedRemintAddresses) {
        const ba = getDeterministicBurnAccounts(privateWallet).find((b) => b?.burnAddress === addr)
        if (ba && 'spendableBalance' in ba && ba.spendableBalance !== undefined) {
            total += BigInt(ba.spendableBalance)
        }
    }
    totalSelectedSpendableEl!.textContent = formatUnits(total, cachedDecimals)
}

function updateBurnAccountsListUi(burnAccounts: BurnAccount[], decimals: number) {
    cachedDecimals = decimals
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

    const pendingSpans: HTMLElement[] = []

    for (let i = startIndex; i < pageEndIndex; i++) {
        const burnAccount = burnAccounts[i] as SyncedBurnAccountDet
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
            })

            const cbLabel = document.createElement("label")
            cbLabel.htmlFor = cb.id
            cbLabel.textContent = ` #${i}: ${short} `

            // --- show info toggle ---
            const infoDiv = document.createElement("div")
            infoDiv.style.fontSize = "85%"
            infoDiv.style.marginLeft = "1.5em"
            const isFirstAccount = i === 0
            infoDiv.style.display = isFirstAccount ? "block" : "none"

            const isSynced = 'totalBurned' in burnAccount && burnAccount.totalBurned !== undefined
            if (isSynced) {
                const synced = burnAccount as SyncedBurnAccountNonDet
                infoDiv.innerHTML =
                    `burn address: ${burnAccount.burnAddress}<br>` +
                    `burned balance: ${formatUnits(BigInt(synced.totalBurned), decimals)}<br>` +
                    `private spent balance: ${formatUnits(BigInt(synced.totalSpent), decimals)}<br>` +
                    `spendable balance: ${formatUnits(BigInt(synced.spendableBalance), decimals)}<br>` +
                    `account nonce (txs made): ${Number(synced.accountNonce)}`
            } else {
                infoDiv.textContent = "(not synced yet)"
            }

            const toggleBtn = document.createElement("button")
            toggleBtn.textContent = isFirstAccount ? "hide info" : "show info"
            toggleBtn.style.fontSize = "70%"
            toggleBtn.addEventListener("click", () => {
                const visible = infoDiv.style.display !== "none"
                infoDiv.style.display = visible ? "none" : "block"
                toggleBtn.textContent = visible ? "show info" : "hide info"
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
}

function getSelectedRemintBurnAddresses(): Address[] {
    return Array.from(selectedRemintAddresses) as Address[]
}

// --- wallet connection ---

async function connectPublicWallet() {
    if (!('ethereum' in window)) {
        throw new Error('No Ethereum wallet detected. Please install MetaMask.')
    }

    const walletClient = createWalletClient({
        chain: sepolia,
        transport: custom(window.ethereum!),
    })

    try {
        await walletClient.switchChain({ id: sepolia.id })
        const addresses = await walletClient.requestAddresses()

        //@ts-ignore
        window.publicAddress = addresses[0]
        //@ts-ignore
        window.publicWallet = walletClient

        const wormholeTokenWallet = getContract({
            abi: WormholeTokenArtifact.abi,
            address: wormholeTokenAddress,
            client: { wallet: walletClient, public: publicClient }
        }) as unknown as WormholeToken

        //@ts-ignore
        window.wormholeTokenWallet = wormholeTokenWallet
        // background tree sync — uses stored tree as starting point so only new blocks are fetched
        getSyncedMerkleTree({ wormholeToken: wormholeTokenWallet, publicClient, preSyncedTree: loadPreSyncedTree() ?? undefined })
            .then(savePreSyncedTree)
            .catch(e => console.warn("background tree sync failed", e))
        await updateWalletInfoUi(wormholeTokenWallet, addresses[0])
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
    const wormholeTokenWallet = window.wormholeTokenWallet as WormholeToken
    //@ts-ignore
    const publicAddress = window.publicAddress as Address
    return { publicWallet, wormholeTokenWallet, publicAddress }
}

/**
 * Generates and syncs burn accounts for a given page if they don't already exist.
 * Creates all missing accounts in parallel with async PoW.
 * Progressively updates the UI as each account finishes.
 */
async function ensurePageAccounts(page: number, privateWallet: BurnViewKeyManager, wormholeTokenWallet: WormholeToken, clearMsg = true) {
    const startIndex = page * BURN_ACCOUNTS_PER_PAGE
    const endIndex = startIndex + BURN_ACCOUNTS_PER_PAGE
    const decimals = Number(await wormholeToken.read.decimals())
    // figure out which indices need generating
    const indicesToGenerate: number[] = []
    const allBurnAccounts = getDeterministicBurnAccounts(privateWallet)
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
        privateWallet.createBurnAccount({ async: true, viewingKeyIndex: i })
            .then((ba) =>
                syncBurnAccount({ wormholeToken: wormholeTokenWallet, burnAccount: ba, archiveNode: publicClient })
            )
            .then((synced) => {
                privateWallet.importBurnAccount(synced)
                savePrivateWalletData(privateWallet)
                // re-render so this account replaces its placeholder
                if (currentBurnPage === page) {
                    const updatedBurnAccounts = getDeterministicBurnAccounts(privateWallet)
                    updateBurnAccountsListUi(updatedBurnAccounts, decimals)
                }
            })
    )

    await Promise.all(perAccountPromises)
}

async function connectPrivateWallet() {
    const { publicWallet, publicAddress, wormholeTokenWallet } = await getPublicWallet()

    //@ts-ignore
    publicWallet.account = { address: publicAddress }

    const chainId = BigInt(await publicClient.getChainId())
    const POW_DIFFICULTY = BigInt(await wormholeTokenWallet.read.POW_DIFFICULTY())

    const storedData = loadPrivateWalletData(publicAddress)
    let privateWallet: BurnViewKeyManager
    if (storedData) {
        logUi("restoring private wallet from local storage...", true)
        privateWallet = new BurnViewKeyManager(publicWallet, POW_DIFFICULTY, { viewKeyData: storedData, acceptedChainIds: [chainId] })
    } else {
        privateWallet = new BurnViewKeyManager(publicWallet, POW_DIFFICULTY, { acceptedChainIds: [chainId] })
        logUi("creating private wallet...\n please sign the message in your wallet", true)
        await privateWallet.getDeterministicViewKeyRoot()
    }

    //@ts-ignore
    window.privateWallet = privateWallet
    //@ts-ignore
    window.burnAccount = null

    // generate first page of burn accounts in parallel (UI updates progressively)
    currentBurnPage = 0
    await ensurePageAccounts(0, privateWallet, wormholeTokenWallet, false)
    savePrivateWalletData(privateWallet)

    const decimals = Number(await wormholeToken.read.decimals())
    updateBurnAccountsListUi(getDeterministicBurnAccounts(privateWallet), decimals)

    //@ts-ignore
    window.burnAccount = getDeterministicBurnAccounts(privateWallet)[0]
    logUi("done! created private wallet with burn addresses", false, true)
}

async function getPrivateWallet() {
    const { publicWallet, wormholeTokenWallet, publicAddress } = await getPublicWallet()
    //@ts-ignore
    if (!window.privateWallet) {
        await connectPrivateWallet()
    }
    //@ts-ignore
    const privateWallet = window.privateWallet as BurnViewKeyManager
    //@ts-ignore
    const burnAccount = window.burnAccount
    return { publicWallet, wormholeTokenWallet, publicAddress, privateWallet, burnAccount }
}

// --- handlers ---

async function mintBtnHandler() {
    const { publicAddress, wormholeTokenWallet } = await getPublicWallet()
    try {
        const tx = await wormholeTokenWallet.write.getFreeTokens([publicAddress], { account: publicAddress, chain: sepolia })
        await txInUi(tx)
    } catch (error) {
        errorUi("aaa that didn't work :( did you cancel it?", error)
    }

    //@ts-ignore
    await updateWalletInfoUi(wormholeTokenWallet, publicAddress, window.burnAccount)
}

async function prevBurnAccountsPageHandler() {
    if (currentBurnPage <= 0) return
    currentBurnPage -= 1
    //@ts-ignore
    const privateWallet = window.privateWallet as BurnViewKeyManager | undefined
    if (!privateWallet) return
    const decimals = Number(await wormholeToken.read.decimals())
    updateBurnAccountsListUi(getDeterministicBurnAccounts(privateWallet), decimals)
}

async function nextBurnAccountsPageHandler() {
    const { privateWallet, wormholeTokenWallet } = await getPrivateWallet()
    currentBurnPage += 1
    try {
        await ensurePageAccounts(currentBurnPage, privateWallet, wormholeTokenWallet)
    } catch (error) {
        currentBurnPage -= 1
        errorUi("failed to generate burn addresses for next page", error)
        return
    }
    const decimals = Number(await wormholeToken.read.decimals())
    updateBurnAccountsListUi(getDeterministicBurnAccounts(privateWallet), decimals)
    logUi(`page ${currentBurnPage + 1} ready`, false, true)
}

function selectAllRemintHandler() {
    //@ts-ignore
    const privateWallet = window.privateWallet as BurnViewKeyManager | undefined
    if (!privateWallet) return

    const checkboxes = Array.from(burnAccountsListEl!.querySelectorAll<HTMLInputElement>('input[name="remintBurnAddresses"]'))
    const allChecked = checkboxes.every((cb) => cb.checked)

    // toggle all on current page
    for (const cb of checkboxes) {
        cb.checked = !allChecked
        if (cb.checked) {
            selectedRemintAddresses.add(cb.value)
        } else {
            selectedRemintAddresses.delete(cb.value)
        }
    }
    updateTotalSelectedSpendable()
}

async function setToPublicAddressBtnHandler(where: HTMLElement) {
    const { publicAddress } = await getPublicWallet()
        ; (where as HTMLInputElement).value = publicAddress
}

async function transferBtnHandler() {
    const { wormholeTokenWallet, publicAddress } = await getPublicWallet()
    const decimals = Number(await wormholeToken.read.decimals())
    const amount = parseUnits((transferAmountInputEl as HTMLInputElement).value, decimals)

    let to: Address
    try {
        to = getAddress((transferRecipientInputEl as HTMLInputElement).value)
    } catch (error) {
        errorUi("this might not be a valid address?", error)
        return
    }

    try {
        const tx = await wormholeTokenWallet.write.transfer([to, amount], { chain: sepolia, account: publicAddress })
        await txInUi(tx)
    } catch (error) {
        errorUi("Something wrong, did you cancel?", error)
    }

    //@ts-ignore
    await updateWalletInfoUi(wormholeTokenWallet, publicAddress, window.burnAccount)
}

async function burnBtnHandler() {
    const { wormholeTokenWallet, publicAddress, privateWallet, burnAccount } = await getPrivateWallet()
    const decimals = Number(await wormholeToken.read.decimals())

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

    // superSafeBurn needs an UnsyncedBurnAccount with viewingKey, chainId, spendingPubKeyX etc.
    // Verify the recipient matches a known burn account
    const targetBurnAccount = getDeterministicBurnAccounts(privateWallet).find((b) => b.burnAddress === to)
    if (!targetBurnAccount) {
        logUi("WARNING not a ")
        return
    }

    logUi("running superSafeBurn checks and sending tx...", true)
    try {
        const tx = await superSafeBurn(targetBurnAccount, amount, wormholeTokenWallet as WormholeTokenTest, privateWallet.privateData.ethAccount)
        await txInUi(tx)
    } catch (error) {
        errorUi("safe burn failed", error)
    }

    //@ts-ignore
    await updateWalletInfoUi(wormholeTokenWallet, publicAddress, window.burnAccount)
}

async function proofPrivateTransferBtnHandler() {
    const { wormholeTokenWallet, publicAddress, privateWallet, burnAccount } = await getPrivateWallet()
    const decimals = Number(await wormholeToken.read.decimals())

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

    // Animated PoW loading indicator
    let dotCount = 0;
    const powInterval = setInterval(() => {
        dotCount = (dotCount % 5) + 1;
        logUi(
            "creating proof..." + ".".repeat(dotCount) + "<br><br>" +
            CREATING_PROOF_MSG
            , true, true, false);
    }, 500);
    try {
        // get selected burn addresses from checkboxes
        const selectedBurnAddresses = getSelectedRemintBurnAddresses()
        if (selectedBurnAddresses.length === 0) {
            clearInterval(powInterval)
            errorUi("please select at least one burn address to spend from", new Error("no burn addresses selected"))
            return
        }

        const chainId = BigInt(await publicClient.getChainId())
        const relayInputsPromise = createRelayerInputs(
            recipient,
            amount,
            privateWallet,
            wormholeToken,
            publicClient,
            {
                chainId,
                burnAddresses: selectedBurnAddresses,
                preSyncedTree: loadPreSyncedTree() ?? undefined,
            })

        const { relayInputs: relayerInputs, syncedData: { syncedPrivateWallet, syncedTree } } = await relayInputsPromise
        addRelayInputsToLocalStorage(relayerInputs)
        savePreSyncedTree(syncedTree)
        //@ts-ignore
        window.burnAccount = syncedPrivateWallet.getDeterministicBurnAccounts()[0]
        //@ts-ignore
        window.merkleTree = syncedTree
    } catch (error) {
        errorUi("proof creation failed", error)
    }
    clearInterval(powInterval);
    logUi("proof done! saved to pending relay txs")
    //@ts-ignore
    const syncedBurnAccount = window.burnAccount as SyncedBurnAccountNonDet
    await updateWalletInfoUi(wormholeTokenWallet, publicAddress, syncedBurnAccount as SyncedBurnAccountNonDet)
    await listPendingRelayTxs()
}

async function listPendingRelayTxs() {
    pendingRelayTxsEl!.innerHTML = ""
    const relayInputs = await getRelayInputsFromLocalStorage()
    const decimals = Number(await wormholeToken.read.decimals())
    for (const relayInput of relayInputs) {
        const relayFunc = async () => {
            const { publicWallet, publicAddress, wormholeTokenWallet } = await getPublicWallet()
            //@ts-ignore
            publicWallet.account = { address: publicAddress }
            try {
                const tx = await selfRelayTx(
                    relayInput,
                    publicWallet,
                    wormholeTokenWallet as WormholeTokenTest
                )
                await txInUi(tx)
                await listPendingRelayTxs()
                //@ts-ignore
                await updateWalletInfoUi(wormholeTokenWallet, publicAddress, window.burnAccount)
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
  wormholeTokenAddress = newAddress
  //@ts-ignore
  window.wormholeTokenAddress = wormholeTokenAddress
  setTokenAddressInUrl(wormholeTokenAddress)

  // recreate read-only contract
  wormholeToken = getContract({ abi: WormholeTokenArtifact.abi, address: wormholeTokenAddress, client: { public: publicClient } }) as unknown as WormholeToken

  // reset private wallet state
  //@ts-ignore
  window.privateWallet = undefined
  //@ts-ignore
  window.burnAccount = undefined
  selectedRemintAddresses.clear()
  selectionInitialized = false
  currentBurnPage = 0
  burnAccountsListEl!.innerHTML = "<li>connect private wallet first</li>"
  burnPageLabelEl!.textContent = ""
  totalSelectedSpendableEl!.textContent = "0"

  // if public wallet connected, recreate the wallet-bound contract
  //@ts-ignore
  if (window.publicWallet) {
    //@ts-ignore
    const walletClient = window.publicWallet as WalletClient
    const wormholeTokenWallet = getContract({
      abi: WormholeTokenArtifact.abi,
      address: wormholeTokenAddress,
      client: { wallet: walletClient, public: publicClient }
    }) as unknown as WormholeToken
    //@ts-ignore
    window.wormholeTokenWallet = wormholeTokenWallet
    //@ts-ignore
    await updateWalletInfoUi(wormholeTokenWallet, window.publicAddress)
  }

  try {
    await setNonWalletInfo(wormholeToken)
    tokenLoadStatusEl!.textContent = "loaded!"
    setTimeout(() => { tokenLoadStatusEl!.textContent = "" }, 2000)
  } catch (error) {
    tokenLoadStatusEl!.textContent = "failed - is this a valid WormholeToken?"
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
document.getElementById('connectPrivateWalletBtn')?.addEventListener('click', connectPrivateWallet)
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
document.getElementById('proofPrivaterTransferBtn')?.addEventListener('click', proofPrivateTransferBtnHandler)

listPendingRelayTxs()