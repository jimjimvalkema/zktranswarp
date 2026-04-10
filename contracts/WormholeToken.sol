// SPDX-License-Identifier: MIT
// Compatible with OpenZeppelin Contracts ^5.0.0


// @TODO 
pragma solidity ^0.8.20;

import {ERC20WithWormHoleMerkleTree} from "./ERC20WithWormHoleMerkleTree.sol"; 
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {LeanIMTData, Hasher} from "zk-kit-lean-imt-custom-hash/InternalLeanIMT.sol";
import {leanIMTPoseidon2} from "./leanIMTPoseidon2.sol";
import {IVerifier} from "./reMint3Verifier.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

struct FeeData {
    uint256 tokensPerEthPrice;
    uint256 maxFee; 
    uint256 amountForRecipient;
    uint256 relayerBonus;
    uint256 estimatedGasCost; 
    uint256 estimatedPriorityFee;
    address refundAddress;
    address relayerAddress;
}

struct SignatureInputs {
    address recipient;
    uint256 amountToReMint;
    bytes callData;
    bool callCanFail;
    uint256 callValue;
    bytes[] encryptedTotalMinted;
}


error VerificationFailed();
// nullifier is indexed so users can search for it and find out the total amount spend, which is needed to make the next spend the next spent
// the nullifiers mapping contains the blockNumber it was nullified at. This can be used for a faster syncing strategy
event Nullified(uint256 indexed nullifier, bytes encryptedTotalMinted);
event StorageRootAdded(uint256 blockNumber);
event NewLeaf(uint256 leaf);

struct Verifier {
    address contractAddress;
    uint8 size;
}

contract WormholeToken is ERC20WithWormHoleMerkleTree, EIP712, ReentrancyGuard {
    // this is so leafs from received balance and spent balance wont get mixed up
    uint256 constant public TOTAL_BURNED_DOMAIN = 0x544f54414c5f4255524e4544; //  UTF8("TOTAL_BURNED").toHex()
    address internal constant POSEIDON2_ADDRESS = 0x382ABeF9789C1B5FeE54C72Bd9aaf7983726841C; // yul-recompile-200: 0xb41072641808e6186eF5246fE1990e46EB45B65A gas: 62572, huff: 0x382ABeF9789C1B5FeE54C72Bd9aaf7983726841C gas:39 627, yul-lib: 0x925e05cfb89f619BE3187Bf13D355A6D1864D24D,

    // @notice nullifier = poseidon(nonce, viewingKey)
    // @notice accountNoteHash = poseidon(totalAmountSpent, nonce, viewingKey)
    mapping (uint256 => uint256) public nullifiers; // nullifier -> blockNumber
    mapping (uint256 => bool) public roots;

    uint256 public amountFreeTokens = 1000000*10**decimals();
    uint256 public decimalsTokenPrice = 8;

    LeanIMTData public tree;

    mapping (uint8 => address) public VERIFIERS_PER_SIZE;
    
    // configurable circuit constants
    // an issuer might change these values depending on their needs
    uint8[] public VERIFIER_SIZES;
    uint8 public AMOUNT_OF_VERIFIERS;    

    uint256[] public ACCEPTED_CHAIN_IDS;
    uint8 public AMOUNT_OF_CHAIN_IDS;

    bytes32 public POW_DIFFICULTY; // find a nonce that result in a hash that is hash < pow_difficulty
    bytes32 public RE_MINT_LIMIT;
    // this one is the only that is not used by the contract, 
    // but is just here so a ui interfacing with this token knows the tree depth that circuit uses
    uint16 public MAX_TREE_DEPTH;

    bool public IS_CROSS_CHAIN;
    uint256 public DEPLOYMENT_BLOCK;

    /**
     * 
     * @param _verifiers needs to be sorted smallest to lowest.
     * @param _powDifficulty a number where the PoW in the circuit asserts pow_hash < _powDifficulty
     * @param _reMintLimit a maximum total amount one burn address can reMint
     */
    constructor(
        bytes32 _powDifficulty, 
        uint256 _reMintLimit, 
        uint16 _maxTreeDepth, 
        bool _isCrossChain,
        string memory _tokenName,
        string memory _tokenSymbol,
        string memory _712Version,
        Verifier[] memory _verifiers, 
        uint256[] memory _acceptedChainIds
    )
        ERC20WithWormHoleMerkleTree(_tokenName, _tokenSymbol)
        EIP712(_tokenName, _712Version) 
    {
        AMOUNT_OF_VERIFIERS = uint8(_verifiers.length);
        uint8 _lastSize = 0;
        for (uint256 i = 0; i < _verifiers.length; i++) {
            Verifier memory _verifier = _verifiers[i];
            require(_lastSize < _verifier.size, "_verifiers needs to be sorted from smallest to largest size");
            _lastSize = _verifier.size;
            VERIFIERS_PER_SIZE[_verifier.size] = _verifier.contractAddress;
            VERIFIER_SIZES.push(_verifier.size);
        }

        AMOUNT_OF_CHAIN_IDS = uint8(_acceptedChainIds.length);
        for (uint256 i = 0; i < _acceptedChainIds.length; i++) {
            ACCEPTED_CHAIN_IDS.push(_acceptedChainIds[i]);
        }

        POW_DIFFICULTY = _powDifficulty;
        RE_MINT_LIMIT = bytes32(_reMintLimit);
        MAX_TREE_DEPTH = _maxTreeDepth;
        IS_CROSS_CHAIN = _isCrossChain;
        DEPLOYMENT_BLOCK = block.number;
    }

    function treeSize() public view  returns (uint256) {
        return tree.size;
    }

    bytes32 private constant _RE_MINT_TYPEHASH =
        keccak256(
            "reMint(address _recipient,uint256 _amount,bytes _callData,bool _callCanFail,uint256 _callValue,bytes[] _encryptedTotalMinted)"
        );

    bytes32 private constant _RE_MINT_RELAYER_TYPEHASH =
        keccak256(
            "reMintRelayer(address _recipient,uint256 _amount,bytes _callData,bool _callCanFail,uint256 _callValue,bytes[] _encryptedTotalMinted,FeeData _feeData)FeeData(uint256 tokensPerEthPrice,uint256 maxFee,uint256 amountForRecipient,uint256 relayerBonus,uint256 estimatedGasCost,uint256 estimatedPriorityFee,address refundAddress,address relayerAddress)"
        );

    bytes32 private constant _FEEDATA_TYPEHASH = keccak256(
        "FeeData(uint256 tokensPerEthPrice,uint256 maxFee,uint256 amountForRecipient,uint256 relayerBonus,uint256 estimatedGasCost,uint256 estimatedPriorityFee,address refundAddress,address relayerAddress)"
    );

    function _hashBytesArray(bytes[] memory items) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](items.length);
        for (uint256 i = 0; i < items.length; i++) {
            hashes[i] = keccak256(items[i]);
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function _hashFeeData(FeeData memory _feeData) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            _FEEDATA_TYPEHASH,
            _feeData.tokensPerEthPrice,
            _feeData.maxFee,
            _feeData.amountForRecipient,
            _feeData.relayerBonus,
            _feeData.estimatedGasCost,
            _feeData.estimatedPriorityFee,
            _feeData.refundAddress,
            _feeData.relayerAddress
        ));
    }

    function _hashSignatureInputs(
        SignatureInputs calldata _signatureInputs
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                _RE_MINT_TYPEHASH,
                _signatureInputs.recipient,
                _signatureInputs.amountToReMint,
                keccak256(_signatureInputs.callData),
                _signatureInputs.callCanFail,
                _signatureInputs.callValue,
                _hashBytesArray(_signatureInputs.encryptedTotalMinted)
            )
        );
        return _hashTypedDataV4(structHash);
    }

    function _hashSignatureInputsRelayer(
        SignatureInputs calldata _signatureInputs,
        FeeData calldata _feeData
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                _RE_MINT_RELAYER_TYPEHASH,
                _signatureInputs.recipient,
                _signatureInputs.amountToReMint,
                keccak256(_signatureInputs.callData),
                _signatureInputs.callCanFail,
                _signatureInputs.callValue,
                _hashBytesArray(_signatureInputs.encryptedTotalMinted),
                _hashFeeData(_feeData)
            )
        );
        return _hashTypedDataV4(structHash);
    }

    function hashPoseidon2T3(uint256[3] memory input) public view returns (uint256) {
        (, bytes memory result) = POSEIDON2_ADDRESS.staticcall(abi.encode(input));
        return uint256(bytes32(result));
    }

    function hashPoseidon2T6(uint256[6] memory input) public view returns (uint256) {
        (, bytes memory result) = POSEIDON2_ADDRESS.staticcall(abi.encode(input));
        return uint256(bytes32(result));
    }

    // The function used for hashing the balanceLeaf
    function hashBalanceLeaf(address _to, uint256 _newBalance) private view returns (uint256) {
        uint256[3] memory input;
        input[0] = _addressToUint256(_to);
        input[1] = _newBalance;
        input[2] = TOTAL_BURNED_DOMAIN;
        return hashPoseidon2T3(input);
    }

    function _insertInMerkleTree(uint256 leaf) internal {
        leanIMTPoseidon2.insert(tree, leaf);
        emit NewLeaf(leaf);
        roots[leanIMTPoseidon2.root(tree)] = true;
    }

    function _insertManyInMerkleTree(uint256[] memory leafs) override internal {
        if(leafs.length > 0) {
            leanIMTPoseidon2.insertMany(tree, leafs);
            for (uint i = 0; i < leafs.length; i++) {
                emit NewLeaf(leafs[i]);
            }
            roots[leanIMTPoseidon2.root(tree)] = true;

        }
    }

    // check if account == tx.origin since in that case it's not a private address.
    // and we only need to insert _accountNoteHash
    // tx.origin is always a EOA
    // address(0) is not a burn address and can also cause issues when used in _insertInMerkleTree
    function _notABurnAddress(address to) private view returns(bool) {
        // @WARNING you might be tempted to create smarter ways to check if its for sure not a private address. 
        // Example: check that `_to` is an smart contract (_to.code.length > 0) or store the tx.origin address somewhere in a mapping like "allKnownEOAs" to check to save gas on future transfers. 
        // Registering your EOA in "allKnownEOAs" / using smart contract accounts saves you on gas in the future. But that creates perverse incentives that break plausible deniability.
        // doing so will cause every EOA owner to register in "allKnownEOAs" / use smart contract accounts and then there is no plausible deniability left since it's now "looks weird" to not do that.
        // Even doing account != contract is bad in that sense. Since account based wallets would also save on gas.
        return tx.origin == to || to == address(0);
    }

    function _updateBalanceInMerkleTree(address _to, uint256 _newBalance) override internal {        
        if (_notABurnAddress(_to)) {return;}
        uint256 leaf = hashBalanceLeaf(_to, _newBalance);
        if (leanIMTPoseidon2.has(tree,leaf)) {
            // it's already in there! (rarely happens but can happen if an EOA receives an amount that results in a balance it had before)
            return;
        } else {
            _insertInMerkleTree(leaf);
        }
    }

    function _updateBalanceInMerkleTree(address _to, uint256 _newBalance, uint256[] memory _totalMintedLeafs) override internal {        
        if (_notABurnAddress(_to)) {
            // _totalMintedLeafs still need to get inserted
            _insertManyInMerkleTree(_totalMintedLeafs);
        } else {
            uint256 accountBalanceLeaf = hashBalanceLeaf(_to, _newBalance);

            if (leanIMTPoseidon2.has(tree, accountBalanceLeaf)) {
                // only happens when someone receives an amount that exactly adds up to a balance that results a balance that had before
                // very rare don't really want to check for this but leanIMT wont allow me to insert the same leaf twice
                _insertManyInMerkleTree(_totalMintedLeafs);
            } else {
                uint256[] memory leafs = new uint256[](1 + _totalMintedLeafs.length);
                leafs[0] = accountBalanceLeaf;
                for (uint i = 0; i < _totalMintedLeafs.length; i++) {
                    leafs[i+1] = _totalMintedLeafs[i];
                }
                _insertManyInMerkleTree(leafs);
            }
        }
    }

    function _updateBalanceInMerkleTree(address[] memory _accounts, uint256[] memory _newBalances, uint256[] memory _totalMintedLeafs) override internal {        
        uint256[] memory leafs = new uint256[](_accounts.length + _totalMintedLeafs.length);

        uint256 leafsIndex = 0;
        for (uint256 i = 0; i < _accounts.length; i++) {
            address to = _accounts[i];
            if (_notABurnAddress(to) == false) {
                uint256 accountBalanceLeaf = hashBalanceLeaf(to, _newBalances[i]);
                // only happens when someone receives an amount that exactly adds up to a balance that results a balance that had before
                // very rare don't really want to check for this but leanIMT wont allow me to insert the same leaf twice
                if(leanIMTPoseidon2.has(tree,accountBalanceLeaf) == false) {
                    leafs[leafsIndex++] = accountBalanceLeaf;
                }
            }
        }
        if(_totalMintedLeafs.length > 0) {
            for (uint256 i = 0; i < _totalMintedLeafs.length; i++) {
                leafs[leafsIndex++] = _totalMintedLeafs[i];
            }
        }

        if (leafsIndex > 0) {
            // Trim array to actual length
            assembly { mstore(leafs, leafsIndex) }

            _insertManyInMerkleTree(leafs);
        }
    }

    function root() public view returns(uint256){
        return leanIMTPoseidon2.root(tree);
    }

    // @WARNING remove this in prod, anyone can mint for free!
    function getFreeTokens(address _to) public {
        _mint(_to, amountFreeTokens);
    }


    function _addressToUint256(address _address) private pure returns (uint256) {
        return uint256(uint160(bytes20(_address)));
    }

    function _formatPublicInputs(
        uint256 _root,
        uint256 _chainId,
        uint256 _amount,
        bytes32 _signatureHash,
        uint256[] memory _totalMintedLeafs,        // a commitment inserted in the merkle tree, tracks how much is spend after this transfer hash(prev_total_minted+amount, prev_account_nonce, viewing_key)
        uint256[] memory _nullifiers   // nullifies the previous account_note.  hash(prev_account_nonce, viewing_key)
    ) public view returns (bytes32[] memory) {
        require(_totalMintedLeafs.length == _nullifiers.length, "did not receive the same amount of leafs as nullifiers");
        uint256 signatureHashOffset = 5;
        uint256 verifierSize = _nullifiers.length;
        bytes32[] memory publicInputs = new bytes32[](signatureHashOffset + 32 + verifierSize*2);

        publicInputs[0] = bytes32(_root);
        publicInputs[1] = bytes32(_chainId);
        publicInputs[2] = bytes32(uint256(_amount));
        publicInputs[3] = POW_DIFFICULTY;
        publicInputs[4] = RE_MINT_LIMIT;
        for (uint256 i = 0; i < 32; i++) {
            publicInputs[i + signatureHashOffset] = bytes32(uint256(uint8(_signatureHash[i])));
        }

        uint256 noteHashesOffSet = 32 + signatureHashOffset;
        for (uint256 i = 0; i < _totalMintedLeafs.length ; i++) {
            publicInputs[2 * i + noteHashesOffSet] = bytes32(_totalMintedLeafs[i]);
            publicInputs[2 * i + noteHashesOffSet + 1] = bytes32(_nullifiers[i]);
        }

        return publicInputs;
    }


    function _verifyReMint(
        uint256 _root,
        uint256 _chainId,
        uint256 _amount,
        bytes32 signatureHash,
        uint256[] memory _totalMintedLeafs,         // a commitment inserted in the merkle tree, tracks how much is spend after this transfer hash(prev_total_minted+amount, prev_account_nonce, viewing_key)
        uint256[] memory _nullifiers,               // nullifies the previous account_note.  hash(prev_account_nonce, viewing_key)
        bytes[] calldata _encryptedTotalMinted,
        bytes calldata _snarkProof
    ) private {
        require(_chainId == block.chainid || IS_CROSS_CHAIN==false, "chainId not matched and cross chain is enabled, can't spend this burn account on this chain");
        require(roots[_root], "invalid root");
        // check and store nullifiers, emit Nullified events with _encryptedTotalMinted blobs
        for (uint256 i = 0; i < _nullifiers.length; i++) {
            uint256 _nullifier = _nullifiers[i];
            if(_nullifier != 0) {
                require(nullifiers[_nullifier] == uint256(0), "nullifier already exist");
                nullifiers[_nullifier] = block.number;
                emit Nullified(_nullifier, _encryptedTotalMinted[i]); 
            }
        }

        // format public inputs and verify proof 
        bytes32[] memory publicInputs = _formatPublicInputs(_root, _chainId, _amount, signatureHash, _totalMintedLeafs, _nullifiers);
        uint8 verifierSize = uint8(_nullifiers.length);
        address verifierAddress = VERIFIERS_PER_SIZE[verifierSize];
        require(verifierAddress != address(0), "amount of note hashes not supported");
        if (!IVerifier(verifierAddress).verify(_snarkProof, publicInputs)) {
            revert VerificationFailed();
        }
    }

    function reMint(
        uint256 _root,
        uint256 _chainId,
        uint256[] memory _totalMintedLeafs, // a blinded commitment inserted in the merkle tree, tracks how much is spend after this transfer hash(prev_total_minted+amount, prev_account_nonce, viewing_key)
        uint256[] memory _nullifiers,       // nullifies the previous account_note.  hash(prev_account_nonce, viewing_key)
        bytes calldata _snarkProof,
        SignatureInputs calldata _signatureInputs
    ) public nonReentrant{
        bytes32 _signatureHash = _hashSignatureInputs(_signatureInputs);
        _verifyReMint(_root, _chainId, _signatureInputs.amountToReMint, _signatureHash, _totalMintedLeafs, _nullifiers, _signatureInputs.encryptedTotalMinted, _snarkProof);
        
        // modified version of _mint that also inserts noteHashes and_chainId does not modify total supply!
        _reMint(_signatureInputs.recipient, _signatureInputs.amountToReMint, _totalMintedLeafs);
        _processCall(_signatureInputs);
    }

    function _calculateFee(FeeData calldata _feeData, uint256 _amountToReMint) public view returns(uint256,uint256) {
        uint256 _feeInWei =  _feeData.estimatedGasCost * (block.basefee + _feeData.estimatedPriorityFee);
        uint256 _fee = ((_feeInWei * _feeData.tokensPerEthPrice) / 10**decimalsTokenPrice) + _feeData.relayerBonus;
        require(_fee < _feeData.maxFee, "relayer fee is too high");
        require(_amountToReMint > _fee, "fee is more then amount being reMinted");
        require((_amountToReMint - _fee) >= _feeData.amountForRecipient , "not enough left after fees for recipient");
        uint256 _refundAmount = _feeData.maxFee - _fee;
        require(_fee + _refundAmount + _feeData.amountForRecipient <= _amountToReMint, "total amount send exceeds _amountToReMint from proof");
        return (_fee, _refundAmount);
    }

    function reMintRelayer(
        uint256 _root,
        uint256 _chainId,
        uint256[] memory _totalMintedLeafs,         // a commitment inserted in the merkle tree, tracks how much is spend after this transfer hash(prev_total_minted+amount, prev_account_nonce, viewing_key)
        uint256[] memory _nullifiers,               // nullifies the previous account_note.  hash(prev_account_nonce, viewing_key)
        bytes calldata _snarkProof,
        SignatureInputs calldata _signatureInputs,
        FeeData calldata _feeData
    ) public nonReentrant {
        (uint256 _fee, uint256 _refundAmount) = _calculateFee(_feeData, _signatureInputs.amountToReMint);
        bytes32 _signatureHash = _hashSignatureInputsRelayer(_signatureInputs, _feeData);
        _verifyReMint(_root, _chainId, _signatureInputs.amountToReMint, _signatureHash, _totalMintedLeafs, _nullifiers, _signatureInputs.encryptedTotalMinted, _snarkProof);

        // optional let anyone claim the fee
        address relayerAddress;
        if (_feeData.relayerAddress == address(1)) {
            relayerAddress = msg.sender;
        } else {
            relayerAddress = _feeData.relayerAddress;
        }

        // giga ugly solidity array bs :/
        if(_signatureInputs.recipient == _feeData.refundAddress) {
            // saves on gas in this case but more importantly does not confuse recipient getting 2 transfer logs for 1 "withdraw all" tx
            address[] memory recipients = new address[](2);
            recipients[0] = _signatureInputs.recipient;
            recipients[1] = relayerAddress;
            uint256[] memory amounts = new uint256[](2);
            amounts[0] = _feeData.amountForRecipient + _refundAmount;
            amounts[1] = _fee;
            _reMintBulk(recipients, amounts, _totalMintedLeafs);
        } else {
            address[] memory recipients = new address[](3);
            recipients[0] = _signatureInputs.recipient;
            recipients[1] = _feeData.refundAddress;
            recipients[2] = relayerAddress;
            uint256[] memory amounts = new uint256[](3);
            amounts[0] = _feeData.amountForRecipient;
            amounts[1] = _refundAmount;
            amounts[2] = _fee;
            _reMintBulk(recipients, amounts, _totalMintedLeafs);
        }

        _processCall(_signatureInputs);
    }

    function _processCall(SignatureInputs calldata _signatureInputs) private {
        if (_signatureInputs.callData.length != 0 || _signatureInputs.callValue > 0) {
            (bool success,) = _signatureInputs.recipient.call{value:_signatureInputs.callValue}(_signatureInputs.callData);
            require(_signatureInputs.callCanFail || success, "call failed and was not allowed to fail");
        }
    }

    function getAcceptedChainIds() public view returns (uint256[] memory) {
        uint256[] memory chainIds = new uint256[](AMOUNT_OF_CHAIN_IDS + 1);
        for (uint256 i = 0; i < AMOUNT_OF_CHAIN_IDS; i++) {
            chainIds[i] = ACCEPTED_CHAIN_IDS[i];
        }
        chainIds[AMOUNT_OF_CHAIN_IDS] = block.chainid;
        return chainIds;
    }
}