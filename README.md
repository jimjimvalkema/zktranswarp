# An alternative implementation of EIP7503 that is account based and has re-usable burn address
This repo is a PoC for a better method for doing plausible deniability on ethereum.   
This repo is built as a ERC-20 compatible token but it can and **should** also be researched to be at the base-layer of ethereum!
You can clone the repo and try-out the ui or try it on sepolia here: https://eip7503-erc20.jimjim.dev/

## The original EIP7503 
* Base layer of ethereum
* No re-usable addresses: `nullifier=hash(0x01,secret)` and the `address=hash(secret)` which means you cannot re-use that burn address
* No Hardware wallet support: because `address=hash(secret)` and the secret is a private input for the circuit, the hardware wallet would need to make the zk-proof on device which is not possible on the ledger, trezor, etc
* Uses the state-trie for inclusion proof (a hexanary tree with keccak), this is slow to proof and requires ton of ram.


## This repo 
* Is on the application layer (a contract) *(but can/should be implemented on base layer as well!!)*
* Uses a in-contract binary merkle tree with the poseidon2 hash function. 
* Re-usable address: The balance tracking is split into 2, the total received and total spend.  
The total received is just the burned balance.  
The total spend is tracked inside a note based commitment scheme.   
* Hardware wallet support: `address=poseidon2Hash(public_key,pow_nonce,"ZKWORMHOLE")` the circuit verifies a secp256k1 signature that authorize that pub_key to spend the funds. Here the hardware wallet can create the signature and then the users machine can create the proof.  
* eip712 signing: contents of the signature are formatted with eip712, so normale ethereum (hw) wallets show human readable data that is being signed


## nullifier and balance tracking
Instead of nullifying the entire address the circuit checks: `assert(burned_balance - total_minted >= amount_spend_in_tx)`.  
The `total_minted` is tracked in an account based note system where:   
`total_minted_leaf=poseidon2Hash(total_minted, account_nonce, blinded_address_data_hash, viewing_key, "TOTAL_MINTED")` and   
`nullifier=poseidon2Hash(account_nonce, viewing_key, "NULLIFIER"))`  
Here `viewing_key` blinds these hashes, `blinded_address_data_hash` makes sure `total_minted_leaf` is commited to that accounts `chainId`, `viewing_key`, `pub_key`.   
   
The circuit does an inclusion proof of `prev_total_minted_leaf`, nullifies it and then creates a new note hash with the new total amount spend that is:   
`new_total_minted_leaf=poseidon2Hash(prev_total_minted+amount_spend_in_tx, account_nonce+1, viewing_key)`.    
On the first spend the inclusion proof of `prev_total_minted_leaf` is skipped (since it doesn't exist), but there is a nullifier is emitted, ensuring this can only happen once.  
  
The `burned_balance` is tracked by the contract in the merkle tree with a leaf that is `leaf=poseidon2Hash(recipient_address, balance)` and the circuit uses that to make inclusion proof.  
*note some code is different then the source for simplicity*

## burn address and the 10$ billion collision attack (eip-3607)
The address scheme is 
```rs
let blinded_burn_address_data = hasher([spending_pub_key, viewing_key, chain_id])
let address = hasher([blinded_address_data_hash, pow_nonce, "ZKWORMHOLE"]).slice(-20) // remove last 12 bytes
```
`"ZKWORMHOLE"`: is a string add as an extra measure to make sure zktranswarp addresses never collide with ethereum address even if they switched to poseidon2. `public_key` here is the x coordinate of the secp256k1 public key.  
`blinded_burn_address_data` is blinded so it can be shared in public, and anyone can generate a new burn address on the recipients behave by finding a new `pow_nonce`. Then this `pow_nonce` is shared in secret and the recipient is then able to claim fund. This way the sender does not know the public key chainId or viewing key of the recipient. And the public saw only a regular transfer, and senders plausible deniability is maintained.  
`pow_nonce`: a number that results in a valid PoW hash that makes finding a collision with EOA addresses much harder. Specifically it adds half a bit of security for each bit of PoW. So a PoW with one leading zero = 8 bits = 4 bits of added security = 160 + 4 = 164 bits of security.   
  
Sadly to achieve the 128 bits of security requirement for the ethereum core protocol, this PoW mechanism is unusable. 32 byte address are needed. Possibly even more if 128 bit post quantum is required (>48 bytes). Luckily post quantum pub key
The PoW is verified like this:   
```rs
let pow_hash: Field = hasher([blinded_address_data_hash, pow_nonce], 2);
assert_lt(pow_hash, pow_difficulty); //"pow failed: pow_nonce results in hash that is not < pow_difficulty"
```  

`address_hash` then has the first 12 bytes set to 0, so it the same length as ethereum address *(this is also the cause of that collision attack vector 😬).*

## TODO EXPLAIN MULTISPENDS
## TODO PROTOCOL SPEC
## TODO rename token to not be workHoleToken wormToken. Since it confuses with the worm token live on mainnet
## TODO rename all inconsistent naming
privateTransfer -> remintTransaction, privateWallet -> burnWallet, amountSpent -> amountReMinted, amountReceived -> amountBurned  
Technically nothing is actually burned or reMinted, But that is the original language 7503 used so it is preferred and more clear.  
Instead docs should just explain that you can treat the accounting like that (spent + received)  
# TODO rename repo
Something like, erc20 with native plausible deniability
# TODO off by one bug in gigaBridge/ultils scanEventInchunks

## optimizations
Merkle tree: The balances tracked in the merkle tree update on **every** transfer, even if a user never intends to use any privacy. This is to preserve plausible deniability. However this can optimized by:
* Only updating the recipient in the transfer, since burn addresses will never be senders! *(note that this does make the balance inaccurate for non burn addresses)*
* skipping merkle tree updates when `tx.origin==recipient`, since then the recipient is for sure a EOA and not a burn address.  
* WARNING: you might be tempted to check if recipient is a contract with `recipient.code!=0x00`, but this incentives EOAs to set code or user to use smart contract wallet to save on gas. **This breaks plausible deniability**.

## relayer
The relayer logic does accounting based on the baseFee which makes it more fair then the relayer in ex: tornadocash.   
Currently the ui has no relayer and just stores the proofs in localstorage to be self relayed from a different account.  
But the contract and circuit does support external relays and it is tested in `test/Token.test.ts`

## WARNINGS
* The value `POW_DIFFICULTY` has been set to an arbitrary number and **IS LIKELY INSECURE**   
https://github.com/jimjimvalkema/EIP7503-ERC20/blob/7a4850ddc6503442dfbd484ac3754a1bd0c02796/circuits/privateTransfer/src/main.nr#L13  
https://github.com/jimjimvalkema/EIP7503-ERC20/blob/7a4850ddc6503442dfbd484ac3754a1bd0c02796/src/constants.ts#L17  
* Compliance (not legal advice ofc): the viewing_key can be used to reveal transaction history but that use case needs more research. It should also be possible to make a PoI scheme work without modifying the circuits/contracts like on railgun. As of now this repo doesn't provide tools for compliance.  
* This is unaudited and experimental. The poseidon2 contract is also experimental and built with huff: https://github.com/zemse/poseidon2-evm  
## deploy
setup secrets:  
`yarn hardhat keystore set SEPOLIA_RPC_URL`  
`yarn hardhat keystore set SEPOLIA_PRIVATE_KEY`  
`yarn hardhat keystore set ETHERSCAN_API_KEY`  

deploy main contracts:  
```shell
yarn hardhat ignition deploy ignition/modules/wormtoken.ts --verify --network sepolia
```  

deploy poseidon2 hasher with create2 (if it's not deployed yet)
```shell
yarn hardhat run scripts/deployPoseidon2.ts --network sepolia
```

## deployed addresses
### sepolia  
TranswarpToken - [0x00BfCb575241cA4285cD20843A6bd6d026b65775](https://sepolia.etherscan.io/address/0x00BfCb575241cA4285cD20843A6bd6d026b65775)  

reMint3Verifier - [0xd32fFb6e84D0C2A9E72c37548bBbb85917eE3603](https://sepolia.etherscan.io/address/0xd32fFb6e84D0C2A9E72c37548bBbb85917eE3603)  
reMint32Verifier - [0x94250907391f063ecf3aFaABE9898cD65DfEF7FE](https://sepolia.etherscan.io/address/0x94250907391f063ecf3aFaABE9898cD65DfEF7FE)  
reMint100Verifier - [0x85B739609d681b285da4Ad03B5AD746e46A54cAa](https://sepolia.etherscan.io/address/0x85B739609d681b285da4Ad03B5AD746e46A54cAa)  
ZKTranscriptLib - [0x96BFB37dE8b66c395c41A5afF35f4f44a11E1Bbe](https://sepolia.etherscan.io/address/0x96BFB37dE8b66c395c41A5afF35f4f44a11E1Bbe)  
leanIMTPoseidon2 - [0x138aFa3b2962A8f5c27Fb0bb91a4B6AB649C49d8](https://sepolia.etherscan.io/address/0x138aFa3b2962A8f5c27Fb0bb91a4B6AB649C49d8)  


## install
```shell
bbup --version 3.0.0-nightly.20251030-2;
noirup --version 1.0.0-beta.14;
```
## run ui
compile
```shell
yarn noir;
yarn solidity;
```

```shell
yarn vite website;
```


## verifier gas cost
```
=== verifier.verify() (isolated) (gas) ===
┌───────────────────┬───────┬─────────┬─────────┬─────────┐
│ (index)           │ count │ min     │ max     │ avg     │
├───────────────────┼───────┼─────────┼─────────┼─────────┤
│ verify (size 3)   │ 1     │ 4032215 │ 4032215 │ 4032215 │
│ verify (size 32)  │ 1     │ 4338564 │ 4338564 │ 4338564 │
│ verify (size 100) │ 1     │ 4687974 │ 4687974 │ 4687974 │
└───────────────────┴───────┴─────────┴─────────┴─────────┘
```

## relayer gas
```
=== remint3WithRelayer.test (gas) ===
┌──────────────────────────────────────────┬───────┬─────────┬─────────┬─────────┐
│ (index)                                  │ count │ min     │ max     │ avg     │
├──────────────────────────────────────────┼───────┼─────────┼─────────┼─────────┤
│ superSafeBurn (transfer to burn address) │ 6     │ 158716  │ 189530  │ 169371  │
│ reMint (relayer, size 3)                 │ 3     │ 4401745 │ 4475067 │ 4441105 │
└──────────────────────────────────────────┴───────┴─────────┴─────────┴─────────┘
```

## self relay gas
```
=== remint3.test (gas) ===
┌──────────────────────────────────────────┬───────┬─────────┬─────────┬─────────┐
│ (index)                                  │ count │ min     │ max     │ avg     │
├──────────────────────────────────────────┼───────┼─────────┼─────────┼─────────┤
│ transfer (no merkle insert)              │ 1     │ 27374   │ 27374   │ 27374   │
│ transfer (with merkle insert)            │ 1     │ 168601  │ 168601  │ 168601  │
│ superSafeBurn (transfer to burn address) │ 18    │ 158759  │ 195005  │ 178188  │
│ reMint (selfRelay, size 3)               │ 8     │ 4403909 │ 4493684 │ 4434754 │
└──────────────────────────────────────────┴───────┴─────────┴─────────┴─────────┘
```

## other gas
```
=== remint3.test (gas) ===
┌──────────────────────────────────────────┬───────┬─────────┬─────────┬─────────┐
│ (index)                                  │ count │ min     │ max     │ avg     │
├──────────────────────────────────────────┼───────┼─────────┼─────────┼─────────┤
│ transfer (no merkle insert)              │ 1     │ 27300   │ 27300   │ 27300   │
│ transfer (with merkle insert)            │ 1     │ 168510  │ 168510  │ 168510  │
│ superSafeBurn (transfer to burn address) │ 18    │ 158668  │ 194914  │ 178097  │
│ reMint (selfRelay, size 3)               │ 8     │ 4400951 │ 4491110 │ 4432064 │
└──────────────────────────────────────────┴───────┴─────────┴─────────┴─────────┘

=== remint32.test (gas) ===
┌──────────────────────────────────────────┬───────┬─────────┬─────────┬─────────┐
│ (index)                                  │ count │ min     │ max     │ avg     │
├──────────────────────────────────────────┼───────┼─────────┼─────────┼─────────┤
│ superSafeBurn (transfer to burn address) │ 99    │ 168498  │ 236250  │ 197945  │
│ reMint (selfRelay, size 32)              │ 6     │ 6932724 │ 7038449 │ 6965843 │
└──────────────────────────────────────────┴───────┴─────────┴─────────┴─────────┘
=== remint100.test (gas) ===
┌──────────────────────────────────────────┬───────┬──────────┬──────────┬──────────┐
│ (index)                                  │ count │ min      │ max      │ avg      │
├──────────────────────────────────────────┼───────┼──────────┼──────────┼──────────┤
│ superSafeBurn (transfer to burn address) │ 515   │ 168498   │ 285369   │ 227530   │
│ reMint (selfRelay, size 100)             │ 11    │ 12450245 │ 12550202 │ 12496333 │
└──────────────────────────────────────────┴───────┴──────────┴──────────┴──────────┘
```