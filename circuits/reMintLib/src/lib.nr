mod domain_separators;
use domain_separators::{
    BURN_ADDRESS_TYPE, FAKE_LEAF, FAKE_NULLIFIER, NULLIFIER, TOTAL_BURNED_DOMAIN, TOTAL_MINTED,
};

use dep::poseidon::poseidon2::Poseidon2;
//use dep::poseidon::{poseidon};

//use dep::keccak256::keccak256;
use dep::std::field::{bn254::{assert_lt, gt}, bytes32_to_field};
use binary_merkle_root::binary_merkle_root;

pub fn poseidon2_hasher<let N: u32>(inputs: [Field; N]) -> Field {
    Poseidon2::hash(inputs, N)
}

fn merkle_hash_root<let MAX_TREE_DEPTH: u32>(
    leaf: Field,
    merkle_data: MerkleData<MAX_TREE_DEPTH>,
    hasher: fn([Field; 2]) -> Field,
) -> Field {
    binary_merkle_root(
        hasher,
        leaf,
        merkle_data.depth,
        merkle_data.indices,
        merkle_data.siblings,
    )
}

// @notice chain_id is not used in this repo but can be used to make this cross-chain like warptoad
// viewing_key is there so it is committed in the burn address,
// to prevent spenders from using a different key and pretend they never spent before when ever the create the nullifier at account_nonce=0
fn hash_blinded_burn_address_data(
    spending_pub_key: Field,
    chain_id: Field,
    viewing_key: Field,
    hasher: fn([Field; 3]) -> Field,
) -> Field {
    hasher([spending_pub_key, viewing_key, chain_id])
}

fn verify_pow(blinded_address_data_hash: Field, pow_nonce: Field, pow_difficulty: Field) {
    let pow_hash: Field = Poseidon2::hash([blinded_address_data_hash, pow_nonce], 2);
    assert_lt(pow_hash, pow_difficulty); //"pow failed: pow_nonce results in hash that is not < pow_difficulty"
}

// pow_nonce acts both as a PoW to make finding a hash collision between EOA and BurnAddress harder
fn hash_burn_address(
    blinded_address_data_hash: Field,
    pow_nonce: Field,
    hasher: fn([Field; 3]) -> Field,
) -> Field {
    let address_hash: Field = hasher([blinded_address_data_hash, pow_nonce, BURN_ADDRESS_TYPE]);

    // // replace last 12 bytes with zero since a eth address is only 20 bytes (noir doesn't support a nicer method hence whacky for loop)
    let bytes: [u8; 32] = address_hash.to_be_bytes();
    let mut eth_address: Field = 0;
    for i in 12..32 {
        eth_address = eth_address * 256 + bytes[i] as Field;
    }
    eth_address
}

fn hash_total_burned_leaf(
    burn_address: Field,
    total_burned: Field,
    hasher: fn([Field; 3]) -> Field,
) -> Field {
    hasher([burn_address, total_burned, TOTAL_BURNED_DOMAIN])
}

/*
total_minted: total_minted for that specific burn address
blinded_address_data_hash: this ties this commitment to the chain_id which is crucial for cross-chain warptoad like use cases, also ties it to the rest of the data in that hash
viewing_key: is already inside blinded_address_data_hash, but is used again here so blinded_address_data_hash is sharable so sender can create burn addresses on the recipients behave
*/
fn hash_total_minted_leaf(
    total_minted: Field,
    account_nonce: Field,
    blinded_address_data_hash: Field,
    viewing_key: Field,
    hasher: fn([Field; 5]) -> Field,
) -> Field {
    hasher(
        [total_minted, account_nonce, blinded_address_data_hash, viewing_key, TOTAL_MINTED],
    )
}

fn hash_fake_leaf(viewing_key: Field) -> Field {
    Poseidon2::hash([viewing_key, FAKE_LEAF], 2)
}

fn hash_fake_nullifier(viewing_key: Field) -> Field {
    Poseidon2::hash([viewing_key, FAKE_NULLIFIER], 2)
}

// account_nonce makes sure the hash is never the same even when the total_minted is not different
// viewing_key is so others cant try and find the pre-image (since this hash is posted onchain)
// and viewing_key is also committed inside the burn address pre-image, so spender is forced to only use that viewing key. To prevent them using a new one and pretending they never spent before
fn hash_nullifier(account_nonce: Field, viewing_key: Field) -> Field {
    Poseidon2::hash([account_nonce, viewing_key, NULLIFIER], 3)
}

fn lower_then_or_equal(a: Field, b: Field) -> bool {
    !gt(a, b)
}

pub struct SignatureData {
    pub public_key_x: [u8; 32],
    pub public_key_y: [u8; 32],
    pub signature: [u8; 64],
}

pub struct MerkleData<let MAX_TREE_DEPTH: u32> {
    depth: u32,
    // TODO maybe we can save on memory computing indices on the spot instead?
    indices: [u1; MAX_TREE_DEPTH],
    siblings: [Field; MAX_TREE_DEPTH],
}

pub struct BurnDataPublic {
    total_minted_leaf: Field,
    nullifier: Field,
}

pub struct BurnDataPrivate<let MAX_TREE_DEPTH: u32> {
    //-----very privacy sensitive data -----
    /*blinds note hashes and nullifiers, separate from blinding_pow to support senders making fresh burn account on the recipients behave*/
    viewing_key: Field,
    /*Serves as a PoW to defend against the address collision attack (similar problem to eip-3607) */
    pow_nonce: Field,
    // amounts
    total_burned: Field,
    prev_total_minted: Field,
    amount_to_mint: Field,
    // inclusion proof
    prev_account_nonce: Field,
    prev_account_note_merkle_data: MerkleData<MAX_TREE_DEPTH>,
    total_burned_merkle_data: MerkleData<MAX_TREE_DEPTH>,
}

pub fn bulkReMint<let MAX_TREE_DEPTH: u32>(
    // public
    root: Field,
    chain_id: Field,
    total_amount_to_spent: Field,
    pow_difficulty: Field,
    re_mint_limit: Field,
    burn_data_public: [BurnDataPublic],
    // private
    burn_data_private: [BurnDataPrivate<MAX_TREE_DEPTH>],
    spending_pub_key: Field,
    amount_burn_addresses: u32,
    // config
    // hashers
    hasher_merkle: fn([Field; 2]) -> Field,
    hasher_leaf_total_burned: fn([Field; 3]) -> Field,
    hasher_total_minted_leaf: fn([Field; 5]) -> Field,
    hasher_burn_address: fn([Field; 3]) -> Field,
    hasher_blinded_burn_address_data: fn([Field; 3]) -> Field,
) {
    let mut amount_verified: Field = 0;
    for i in 0..burn_data_private.len() {
        if (i < amount_burn_addresses) {
            reMint::<MAX_TREE_DEPTH>(
                // public
                root,
                chain_id,
                pow_difficulty,
                re_mint_limit,
                burn_data_public[i].total_minted_leaf,
                burn_data_public[i].nullifier,
                // private
                spending_pub_key,
                burn_data_private[i].viewing_key,
                burn_data_private[i].pow_nonce,
                burn_data_private[i].amount_to_mint,
                burn_data_private[i].total_burned,
                burn_data_private[i].prev_total_minted,
                burn_data_private[i].prev_account_nonce,
                burn_data_private[i].prev_account_note_merkle_data,
                burn_data_private[i].total_burned_merkle_data,
                // hashers
                hasher_merkle,
                hasher_leaf_total_burned,
                hasher_total_minted_leaf,
                hasher_burn_address,
                hasher_blinded_burn_address_data,
            );

            amount_verified = amount_verified + burn_data_private[i].amount_to_mint;
        } else {
            // If an user decides to hide the actual amount of burn addresses, they need to emit fake nullifiers and leafs.
            // The user cant just make burn accounts for free, they need to make burn txs to those addresses for it to exist in the tree! So instead we allow them to fake the data
            // but to prevent a infinite mint bug, we need to make 100% sure that fake data does not have a valid pre-image that can potentially fake 0 tokens reMinted
            if (burn_data_public[i].total_minted_leaf != 0) {
                let fake_leaf: Field = hash_fake_leaf(burn_data_private[i].viewing_key);
                assert(fake_leaf == burn_data_public[i].total_minted_leaf);
            }

            // Doing this to nullifiers also prevents potential grieving attacks where the attacker bricks another users account by nullifying a total_minted_leaf without inserting the next.
            // Although that attack require knowledge of the viewing_key of the victim.
            if (burn_data_public[i].nullifier != 0) {
                let fake_nullifier: Field = hash_fake_nullifier(burn_data_private[i].viewing_key);
                assert(fake_nullifier == burn_data_public[i].nullifier);
            }
        }
    }

    assert(
        amount_verified == total_amount_to_spent,
        "aggregated burn address amounts do not match amount to spend",
    );
}

pub fn reMint<let MAX_TREE_DEPTH: u32>(
    // public
    root: Field,
    chain_id: Field,
    pow_difficulty: Field,
    re_mint_limit: Field,
    total_minted_leaf: Field,
    nullifier: Field,
    // private, keys
    spending_pub_key: Field,
    viewing_key: Field,
    pow_nonce: Field,
    // private balances
    amount_to_mint: Field,
    total_burned: Field,
    prev_total_minted: Field,
    // private inclusion proof
    prev_account_nonce: Field,
    prev_account_note_merkle_data: MerkleData<MAX_TREE_DEPTH>,
    total_burned_merkle_data: MerkleData<MAX_TREE_DEPTH>,
    // config
    // hashers
    hasher_merkle: fn([Field; 2]) -> Field,
    hasher_leaf_total_burned: fn([Field; 3]) -> Field,
    hasher_total_minted_leaf: fn([Field; 5]) -> Field,
    hasher_burn_address: fn([Field; 3]) -> Field,
    hasher_blinded_burn_address_data: fn([Field; 3]) -> Field,
) {
    let blinded_address_data_hash: Field = hash_blinded_burn_address_data(
        spending_pub_key,
        chain_id,
        viewing_key,
        hasher_blinded_burn_address_data,
    );
    let burn_address: Field =
        hash_burn_address(blinded_address_data_hash, pow_nonce, hasher_burn_address);
    verify_pow(blinded_address_data_hash, pow_nonce, pow_difficulty);

    // verify how much is "burned"
    let total_burned_leaf: Field =
        hash_total_burned_leaf(burn_address, total_burned, hasher_leaf_total_burned);
    let root_total_burned_root: Field = merkle_hash_root::<MAX_TREE_DEPTH>(
        total_burned_leaf,
        total_burned_merkle_data,
        hasher_merkle,
    );
    assert(root_total_burned_root == root, "total_burned merkle proof invalid");

    if prev_account_nonce != 0 {
        // verify how much was spent in total before this tx: verify prev_total_minted
        let prev_total_minted_leaf: Field = hash_total_minted_leaf(
            prev_total_minted,
            prev_account_nonce,
            blinded_address_data_hash,
            viewing_key,
            hasher_total_minted_leaf,
        );
        let prev_total_spend_root: Field = merkle_hash_root::<MAX_TREE_DEPTH>(
            prev_total_minted_leaf,
            prev_account_note_merkle_data,
            hasher_merkle,
        );
        assert(prev_total_spend_root == root, "prev account note merkle proof invalid");
    } else {
        // we have to skip merkle proofs since a previous spent balance does not exist

        // this assert prevents you from effectively burning money on the first tx
        assert(prev_total_minted == 0, "prev_account_nonce = 0 but prev_total_minted is not 0.");
    }

    // nullify the prev_total_minted, which is inside prev_total_minted_leaf and tied to prev_account_nonce + viewing_key
    let new_nullifier: Field = hash_nullifier(prev_account_nonce, viewing_key);
    assert(new_nullifier == nullifier, "nullifier mismatch");

    // check amount spent
    let new_total_minted: Field = prev_total_minted + amount_to_mint;
    assert_lt(new_total_minted, re_mint_limit); //, "burn account went over the re_mint_limit limit");
    assert_lt(prev_total_minted, new_total_minted); //, "prev_total_minted is overflowing";
    assert(lower_then_or_equal(new_total_minted, total_burned), "spend exceeds total received");

    //
    let current_account_nonce: Field = prev_account_nonce + 1;
    let new_total_minted_leaf: Field = hash_total_minted_leaf(
        new_total_minted,
        current_account_nonce,
        blinded_address_data_hash,
        viewing_key,
        hasher_total_minted_leaf,
    );
    assert(new_total_minted_leaf == total_minted_leaf, "account note hash mismatch");
}

pub fn reMintPoseidon2<let MAX_TREE_DEPTH: u32>(
    // public
    root: Field,
    chain_id: Field,
    pow_difficulty: Field,
    re_mint_limit: Field,
    total_minted_leaf: Field,
    nullifier: Field,
    // private, keys
    spending_pub_key: Field,
    viewing_key: Field,
    pow_nonce: Field,
    // private balances
    amount_to_mint: Field,
    total_burned: Field,
    prev_total_minted: Field,
    // private inclusion proof
    prev_account_nonce: Field,
    prev_account_note_merkle_data: MerkleData<MAX_TREE_DEPTH>,
    total_burned_merkle_data: MerkleData<MAX_TREE_DEPTH>,
) {
    reMint(
        root,
        chain_id,
        pow_difficulty,
        re_mint_limit,
        total_minted_leaf,
        nullifier,
        spending_pub_key,
        viewing_key,
        pow_nonce,
        amount_to_mint,
        total_burned,
        prev_total_minted,
        prev_account_nonce,
        prev_account_note_merkle_data,
        total_burned_merkle_data,
        // config
        // hashers
        poseidon2_hasher,
        poseidon2_hasher,
        poseidon2_hasher,
        poseidon2_hasher,
        poseidon2_hasher,
    )
}

pub fn bulkReMintPoseidon2<let MAX_TREE_DEPTH: u32>(
    // public
    root: Field,
    chain_id: Field,
    total_amount_to_spent: Field,
    pow_difficulty: Field,
    re_mint_limit: Field,
    burn_data_public: [BurnDataPublic],
    // private
    burn_data_private: [BurnDataPrivate<MAX_TREE_DEPTH>],
    spending_pub_key: Field,
    amount_burn_addresses: u32,
) {
    bulkReMint(
        root,
        chain_id,
        total_amount_to_spent,
        pow_difficulty,
        re_mint_limit,
        burn_data_public,
        burn_data_private,
        spending_pub_key,
        amount_burn_addresses,
        poseidon2_hasher,
        poseidon2_hasher,
        poseidon2_hasher,
        poseidon2_hasher,
        poseidon2_hasher,
    )
}
