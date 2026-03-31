# An alternative implementation of EIP7503 that is account based and has re-usable burn address
This repo is a PoC of a better way of doing plausible deniability on ethereum.   
However this repo is built as a ERC-20 compatible token but it can and should also be built into the base-layer of ethereum!
You can clone the repo and try-out the ui or try it on sepolia here: https://eip7503-erc20.jimjim.dev/

## The original EIP7503 
* Base layer of ethereum
* No re-usable addresses: `nullifier=hash(0x01,secret)` and the `address=hash(secret)` which means you cannot re-use that burn address
* No Hardware wallet support: because `address=hash(secret)` and the secret is a private input for the circuit, the hardware wallet would need to make the zk-proof on device which is not possible on the ledger, trezor, etc
* Uses the state-trie for inclusion proof (a hexanary tree with keccak), this is slow to proof and requires ton of ram.


## This repo 
* Is on the application layer (a contract) *(but can/should be implemented on base layer as well!!)*
* Uses a in-contract binary merkle tree with the poseidon2 hash function. 
* Re usable address: The balance tracking is split into 2, the total received and total spend.  
The total received is just the burned balance.  
The total spend is tracked inside a note based commitment scheme.   
* Hardware wallet support: `address=poseidon2Hash(public_key,shared_secret,"ZKWORMHOLE")` the circuit verifies a secp256k1 signature that authorize that pub_key to spend the funds. Here the hardware wallet can create the signature and then the users machine can create the proof.    


## nullifier and balance tracking
Instead of nullifying the entire address the circuit checks: `assert(burned_balance - total_spend >= amount_spend_in_tx)`.  
The `total_spend` is tracked in an account based note system where:   
`note_hash=poseidon2Hash(total_spent, account_nonce, viewing_key)` and   
`nullifier=poseidon2Hash(account_nonce, viewing_key)`    
The circuit does an inclusion proof of `prev_note_hash`, nullifies it and then creates a new note hash with the new total amount spend that is:   
`new_note_hash=poseidon2Hash(prev_total_minted+amount_spend_in_tx, account_nonce+1, viewing_key)`.    
On the first spend the inclusion proof of `prev_note_hash` is skipped (since it doesn't exist), but there is a nullifier is emitted, ensuring this can only happen once.  
  
The `burned_balance` is tracked by the contract in the merkle tree with a leaf that is `leaf=poseidon2Hash(recipient_address, balance)` and the circuit uses that to make inclusion proof.  
*note some code is different then the source for simplicity like the domain separators being omitted here ex:TOTAL_RECEIVED_DOMAIN*

## burn address and the 10$ billion collision attack (eip-3607)
The address scheme is `address=poseidon2Hash(public_key,shared_secret,"ZKWORMHOLE")`   
`"ZKWORMHOLE"`: is a string add as an extra measure to make sure zkwormhole addresses never collide with ethereum address even if they switched to poseidon2. `public_key` here is the x coordinate of the secp256k1 public key.  
`shared_secret`: a number that results in a valid PoW hash that makes finding a collision with EOA addresses much harder.
The PoW is verified like this:   
```rs
let address_hash: Field = Poseidon2::hash([pub_key,shared_secret, PRIVATE_ADDRESS_TYPE], 3);
let pow_hash: Field = Poseidon2::hash([shared_secret, address_hash], 2); 
assert_lt(pow_hash, POW_DIFFICULTY); 
```  

`address_hash` then has the first 12 bytes set to 0, so it the same length as ethereum address *(this is also the cause of that collision attack vector 😬).*

## TODO BurnAccounts should store sync data chain->contractAddress->syncData. 
Currently assumes state is same across every contract, which will break
## TODO EXPLAIN MULTISPENDS
## TODO PROTOCOL SPEC
## TODO rename token to not be workHoleToken wormToken. Since it confuses with the worm token live on mainnet
## TODO rename all inconsistent naming
privateTransfer -> remintTransaction, privateWallet -> burnWallet, amountSpent -> amountReMinted, amountReceived -> amountBurned  
Technically nothing is actually burned or reMinted, But that is the original language 7503 used so it is preferred and more clear.  
Instead docs should just explain that you can treat the accounting like that (spent + received)  
# TODO rename repo
Something like, erc20 with native plausible deniability
# TODO lower 100in circuit
Estimation goes over the tx gas limit, rn the workaround is to hardcode a lower limit, but as the tree grow this will break.  
I think it's best to reduce the size of the circuit to 32, since that's plenty and it saves a lott on merkle tree inserts and logs.  
Also the encrypted total amount spent (aka reMinted :p ) can also be reduced in size to save gas.  

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

deploy split contract (used for batch erc20 sends in ui)
```shell
yarn hardhat ignition deploy ignition/modules/split.ts --verify --network sepolia
```
<!-- ```shell
yarn hardhat run scripts/deploy.ts --network sepolia
``` -->


deploy poseidon2 hasher with create2 (if it's not deployed yet)
```shell
yarn hardhat run scripts/deployPoseidon2.ts --network sepolia
```

## deployed addresses TODO UPDATE THESE
### sepolia  
WormholeToken - [0x6B1474930d4e956A32c72074efe5e1cD279CB5b8](https://sepolia.etherscan.io/address/0x6B1474930d4e956A32c72074efe5e1cD279CB5b8)  


reMint2Verifier - [0x0b85504e9D0A6A4A8BB079156F66f8e5C47caF1B](https://sepolia.etherscan.io/address/0x0b85504e9D0A6A4A8BB079156F66f8e5C47caF1B)
reMint32Verifier - [0x80B904340a5005FC4B4AAefBb9357d54009B2889](https://sepolia.etherscan.io/address/0x80B904340a5005FC4B4AAefBb9357d54009B2889)   
reMint100Verifier - [0xa3124d86e06C718EcDD1AdD52613726f04BD665d](https://sepolia.etherscan.io/address/0xa3124d86e06C718EcDD1AdD52613726f04BD665d)  
ZKTranscriptLib - [0x6Ed252215c01A25A3389332E08F2C79157884c9C](https://sepolia.etherscan.io/address/0x6Ed252215c01A25A3389332E08F2C79157884c9C)  
leanIMTPoseidon2 - [0xb999F48C77cEe08CDc6d264C79DAfCaB129068BA](https://sepolia.etherscan.io/address/0xb999F48C77cEe08CDc6d264C79DAfCaB129068BA)  


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