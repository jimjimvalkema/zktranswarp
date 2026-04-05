use reMintLib::{poseidon2_hasher, bulkReMint, BurnDataPublic, BurnDataPrivate, SignatureData};
use constants::{MAX_TREE_DEPTH};

// 3 because it's optimal for utxo management
// a user usually spends from an account, leaves tokens in that accounts, then creates a fresh account to collect refund from relayer.
// so an user creates one new account per spend, keeps the original one
// with size 1 = users accumulates refund burn accounts, +1 account
// with size 2 = users can always mix in 1 refund account, 0 account
// with size 3 = users can also mix in an additional account, -1 account
global BURN_ADDRESSES_LEN: u32 = 3; 
fn main(
    //----- public inputs
    root: pub Field,
    chain_id: pub Field,
    amount: pub Field,
    pow_difficulty: pub Field,
    re_mint_limit: pub Field,
    signature_hash: pub [u8;32],
    burn_data_public: pub [BurnDataPublic; BURN_ADDRESSES_LEN],
    // --- private inputs ---
    signature_data: SignatureData,      
    burn_data_private: [BurnDataPrivate<MAX_TREE_DEPTH>; BURN_ADDRESSES_LEN],
    amount_burn_addresses: u32 // always one but still a input to be consistent with other circuits
) {

    // one signature for all burns. Cheaper, better UX, but you cant spent with different private keys
    let valid_signature: bool = std::ecdsa_secp256k1::verify_signature(
        signature_data.public_key_x,
        signature_data.public_key_y,
        signature_data.signature,
        signature_hash,
    );
    assert(valid_signature, "invalid signature");

    // slice off the first byte so it fits in the field
    let mut small_pub_key_x: [u8; 32] = signature_data.public_key_x;
    small_pub_key_x[0] = 0;
    let pub_key_x_field: Field = Field::from_be_bytes(small_pub_key_x);

    bulkReMint::<MAX_TREE_DEPTH>(
        root,
        chain_id,
        amount,
        pow_difficulty,
        re_mint_limit,
        burn_data_public,
        //private
        burn_data_private,
        pub_key_x_field,      
        amount_burn_addresses,
        poseidon2_hasher,
        poseidon2_hasher,
        poseidon2_hasher,
        poseidon2_hasher,
        poseidon2_hasher,
    )
}