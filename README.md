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
* multi-pends: you can spend from multiple burnAccounts in one tx. The public cant distinguish if you spend from 1,2,3 burn accounts. Since public inputs are padded to look like 3,32,100 spends.Public can only know if you spend from <=3, <=32 or <=10.
* stealth address like: The protocol support an "stealth address like ux": where an sender can make an fresh burn account on the sender behave. While preserving plausible deniability for sender and no data from recipient leaking to the public or the sender.

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
`"ZKWORMHOLE"`: is a string add as an extra measure to make sure zktranswarp addresses never collide with ethereum address even if they switched to poseidon2. `spending_pub_key` here is the x coordinate of the secp256k1 public key.  
`blinded_burn_address_data` is blinded so it can be shared in public.
`pow_nonce`: a number that results in a valid PoW hash that makes finding a collision with EOA addresses much harder. Specifically it adds half a bit of security for each bit of PoW. So a PoW with one leading zero = 8 bits = 4 bits of added security = 160 + 4 = 164 bits of security.   
  
Sadly to achieve the 128 bits of security requirement for the ethereum core protocol, this PoW mechanism is unusable. 32 byte address are needed. Possibly even more if 128 bit post quantum is required (>48 bytes). Luckily post quantum pub key
The PoW is verified like this:   
```rs
let pow_hash: Field = hasher([blinded_address_data_hash, pow_nonce], 2);
assert_lt(pow_hash, pow_difficulty); //"pow failed: pow_nonce results in hash that is not < pow_difficulty"
```  

`address_hash` then has the first 12 bytes set to 0, so it the same length as ethereum address *(this is also the cause of that collision attack vector 😬).*

## stealth address like ux support
The address contains `blinded_burn_address_data` in it's pre-image. This is blinded by the recipients `viewing_key` so it can be shared in public, and anyone can generate a new burn address on the recipients behave by finding a new `pow_nonce`. Then this `pow_nonce` is shared in secret to the recipient, ensuring the public only sees **an** address and never knows it's an burn address. The recipient is then able to claim funds by reconstructing the burn address with that shared `pow_nonce`.  
`blinded_burn_address_data` is blinded so it can be public without anyone knowing the public key chainId or viewing key or other data of the recipient. And the public saw only a regular transfer, and senders plausible deniability is maintained.  

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
yarn hardhat ignition deploy ignition/modules/warptoken.ts --verify --network sepolia
```  

deploy poseidon2 hasher with create2 (if it's not deployed yet)
```shell
yarn hardhat run scripts/deployPoseidon2.ts --network sepolia
```

## deployed addresses
### sepolia  
TransWarpToken - [0x787c3CEd84107aeeE29e54674905B47C63992024](https://sepolia.etherscan.io/address/0x787c3CEd84107aeeE29e54674905B47C63992024)  

reMint3Verifier - [0x803ef880ADa65077b9DBA722d2510d71B26169EA](https://sepolia.etherscan.io/address/0x803ef880ADa65077b9DBA722d2510d71B26169EA)  
reMint32Verifier - [0x5244F623A83574cebd08d4D2a39D0036008e2b65](https://sepolia.etherscan.io/address/0x5244F623A83574cebd08d4D2a39D0036008e2b65)  
reMint100Verifier - [0xc55e812c85f45c21735114a5E507906a00dFcA86](https://sepolia.etherscan.io/address/0xc55e812c85f45c21735114a5E507906a00dFcA86)  
ZKTranscriptLib - [0xd8b988472374F98D2Dc5B38321c6DA4Ae0aC2de9](https://sepolia.etherscan.io/address/0xd8b988472374F98D2Dc5B38321c6DA4Ae0aC2de9)  
leanIMTPoseidon2 - [0x904826FA0ccB82393a214955AB805B684BA51E79](https://sepolia.etherscan.io/address/0x904826FA0ccB82393a214955AB805B684BA51E79)  


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

## TODO document PROTOCOL SPEC
## TODO make relayer service
## TODO build PoC of "stealth address like ux"
## TODO PoC of cross-chain