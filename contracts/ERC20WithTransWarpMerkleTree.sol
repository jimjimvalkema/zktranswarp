// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.2.0) (token/ERC20/ERC20.sol)

// from openzeppelin 5.2.0 but _updateMerkleTree is added inside _update. In order to make it track incoming balances of the recipient in a merkle tree
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SNARK_SCALAR_FIELD} from "zk-kit-lean-imt-custom-hash/Constants.sol";

/**
 * @dev Implementation of the {IERC20} interface.
 *
 * This implementation is agnostic to the way tokens are created. This means
 * that a supply mechanism has to be added in a derived contract using {_mint}.
 *
 * TIP: For a detailed writeup see our guide
 * https://forum.openzeppelin.com/t/how-to-implement-erc20-supply-mechanisms/226[How
 * to implement supply mechanisms].
 *
 * The default value of {decimals} is 18. To change this, you should override
 * this function so it returns a different value.
 *
 * We have followed general OpenZeppelin Contracts guidelines: functions revert
 * instead returning `false` on failure. This behavior is nonetheless
 * conventional and does not conflict with the expectations of ERC-20
 * applications.
 */
abstract contract ERC20WithTransWarpMerkleTree is
    Context,
    IERC20,
    IERC20Metadata,
    IERC20Errors
{
    mapping(address account => uint256) private _balances;

    mapping(address account => mapping(address spender => uint256))
        private _allowances;

    uint256 private _totalSupply;

    string private _name;
    string private _symbol;

    /**
     * @dev Sets the values for {name} and {symbol}.
     *
     * All two of these values are immutable: they can only be set once during
     * construction.
     */
    constructor(string memory name_, string memory symbol_) {
        _name = name_;
        _symbol = symbol_;
    }

    function _updateBalanceInMerkleTree(
        address _to,
        uint256 _newBalance
    ) internal virtual;

    function _updateBalanceInMerkleTree(
        address _to,
        uint256 _newBalance,
        uint256[] memory _totalMintedLeafs
    ) internal virtual;

    function _updateBalanceInMerkleTree(
        address[] memory _to,
        uint256[] memory _newBalance,
        uint256[] memory _totalMintedLeafs
    ) internal virtual;

    function _insertManyInMerkleTree(
        uint256[] memory _totalMintedLeafs
    ) internal virtual;

    /**
     * @dev Returns the name of the token.
     */
    function name() public view virtual returns (string memory) {
        return _name;
    }

    /**
     * @dev Returns the symbol of the token, usually a shorter version of the
     * name.
     */
    function symbol() public view virtual returns (string memory) {
        return _symbol;
    }

    /**
     * @dev Returns the number of decimals used to get its user representation.
     * For example, if `decimals` equals `2`, a balance of `505` tokens should
     * be displayed to a user as `5.05` (`505 / 10 ** 2`).
     *
     * Tokens usually opt for a value of 18, imitating the relationship between
     * Ether and Wei. This is the default value returned by this function, unless
     * it's overridden.
     *
     * NOTE: This information is only used for _display_ purposes: it in
     * no way affects any of the arithmetic of the contract, including
     * {IERC20-balanceOf} and {IERC20-transfer}.
     */
    function decimals() public view virtual returns (uint8) {
        return 18;
    }

    /**
     * @dev See {IERC20-totalSupply}.
     */
    function totalSupply() public view virtual returns (uint256) {
        return _totalSupply;
    }

    /**
     * @dev See {IERC20-balanceOf}.
     */
    function balanceOf(address account) public view virtual returns (uint256) {
        return _balances[account];
    }

    /**
     * @dev See {IERC20-transfer}.
     *
     * Requirements:
     *
     * - `to` cannot be the zero address.
     * - the caller must have a balance of at least `value`.
     */
    function transfer(address to, uint256 value) public virtual returns (bool) {
        address owner = _msgSender();
        _transfer(owner, to, value);
        return true;
    }

    /**
     * @dev See {IERC20-allowance}.
     */
    function allowance(
        address owner,
        address spender
    ) public view virtual returns (uint256) {
        return _allowances[owner][spender];
    }

    /**
     * @dev See {IERC20-approve}.
     *
     * NOTE: If `value` is the maximum `uint256`, the allowance is not updated on
     * `transferFrom`. This is semantically equivalent to an infinite approval.
     *
     * Requirements:
     *
     * - `spender` cannot be the zero address.
     */
    function approve(
        address spender,
        uint256 value
    ) public virtual returns (bool) {
        address owner = _msgSender();
        _approve(owner, spender, value);
        return true;
    }

    /**
     * @dev See {IERC20-transferFrom}.
     *
     * Skips emitting an {Approval} event indicating an allowance update. This is not
     * required by the ERC. See {xref-ERC20-_approve-address-address-uint256-bool-}[_approve].
     *
     * NOTE: Does not update the allowance if the current allowance
     * is the maximum `uint256`.
     *
     * Requirements:
     *
     * - `from` and `to` cannot be the zero address.
     * - `from` must have a balance of at least `value`.
     * - the caller must have allowance for ``from``'s tokens of at least
     * `value`.
     */
    function transferFrom(
        address from,
        address to,
        uint256 value
    ) public virtual returns (bool) {
        address spender = _msgSender();
        _spendAllowance(from, spender, value);
        _transfer(from, to, value);
        return true;
    }

    /**
     * @dev Moves a `value` amount of tokens from `from` to `to`.
     *
     * This internal function is equivalent to {transfer}, and can be used to
     * e.g. implement automatic token fees, slashing mechanisms, etc.
     *
     * Emits a {Transfer} event.
     *
     * NOTE: This function is not virtual, {_update} should be overridden instead.
     */
    function _transfer(address from, address to, uint256 value) internal {
        if (from == address(0)) {
            revert ERC20InvalidSender(address(0));
        }
        if (to == address(0)) {
            revert ERC20InvalidReceiver(address(0));
        }
        uint256 toNewBalance = _update(from, to, value);

        _updateBalanceInMerkleTree(to, toNewBalance);
    }

    /**
     * @dev Transfers a `value` amount of tokens from `from` to `to`, or alternatively mints (or burns) if `from`
     * (or `to`) is the zero address. All customizations to transfers, mints, and burns should be done by overriding
     * this function.
     *
     * Emits a {Transfer} event.
     */
    function _update(
        address from,
        address to,
        uint256 value
    ) internal virtual returns (uint256 toNewBalance) {
        if (from == address(0)) {
            // Overflow check required: The rest of the code assumes that totalSupply never overflows
            _totalSupply += value;
        } else {
            uint256 fromBalance = _balances[from];
            if (fromBalance < value) {
                revert ERC20InsufficientBalance(from, fromBalance, value);
            }
            unchecked {
                // Overflow not possible: value <= fromBalance <= totalSupply.
                _balances[from] = fromBalance - value;
            }
        }

        if (to == address(0)) {
            unchecked {
                // Overflow not possible: value <= totalSupply or value <= fromBalance <= totalSupply.
                _totalSupply -= value;
            }
            toNewBalance = _balances[to];
        } else {
            toNewBalance = _balances[to] + value;
            require(
                toNewBalance < SNARK_SCALAR_FIELD,
                "balance can't go over the FIELD LIMIT"
            );

            _balances[to] = toNewBalance;
        }
        emit Transfer(from, to, value);
        return toNewBalance;
    }

    /**
     * @dev Transfers a `value` amount of tokens from `from` to `to`, or alternatively mints (or burns) if `from`
     * (or `to`) is the zero address. All customizations to transfers, mints, and burns should be done by overriding
     * this function.
     *
     * Emits a {Transfer} event.
     *
     * Same as _update but added _accountNoteHash so it use insertMany to save on gas and _totalSupply doesn't increase
     */
    function _reMint(
        address to,
        uint256 value,
        uint256[] memory _totalMintedLeafs
    ) internal virtual {
        uint256[] memory _totalMintedLeafsTrimmed = trimTrailingZeros(
            _totalMintedLeafs
        );
        if (to == address(0)) {
            unchecked {
                // Overflow not possible: value <= totalSupply or value <= fromBalance <= totalSupply.
                _totalSupply -= value;
            }
            _insertManyInMerkleTree(_totalMintedLeafsTrimmed);
        } else {
            uint256 newBalance;
            newBalance = _balances[to] + value;
            require(
                newBalance < SNARK_SCALAR_FIELD,
                "balance can't go over the FIELD LIMIT"
            );

            _balances[to] = newBalance;

            // we only care about `to` since zktranswarp accounts can only receive from the public not spend
            // so the _balances[to] number goes up only :D
            // this inserts both _accountNoteHash and poseidon2(to, newBalance)
            _updateBalanceInMerkleTree(
                to,
                newBalance,
                _totalMintedLeafsTrimmed
            );
        }
        emit Transfer(address(0), to, value);
    }

    function trimTrailingZeros(
        uint256[] memory arr
    ) internal pure returns (uint256[] memory) {
        // you can trim the original without copies. But that can be unsafe.
        uint256[] memory trimmed = new uint256[](arr.length);
        uint256 lastNonZero = 0;

        for (uint256 i = 0; i < arr.length; i++) {
            trimmed[i] = arr[i];
            if (arr[i] != 0) {
                lastNonZero = i + 1;
            }
        }

        assembly {
            mstore(trimmed, lastNonZero)
        }

        return trimmed;
    }

    function _reMintBulk(
        address[] memory recipients,
        uint256[] memory amounts,
        uint256[] memory _totalMintedLeafs
    ) internal virtual {
        uint256[] memory _totalMintedLeafsTrimmed = trimTrailingZeros(
            _totalMintedLeafs
        );
        uint256[] memory newBalances = new uint256[](amounts.length);
        for (uint i = 0; i < recipients.length; i++) {
            address to = recipients[i];
            uint256 value = amounts[i];
            if (to == address(0)) {
                unchecked {
                    // Overflow not possible: value <= totalSupply or value <= fromBalance <= totalSupply.
                    _totalSupply -= value;
                }
            } else {
                uint256 newBalance;
                newBalance = _balances[to] + value;
                require(
                    newBalance < SNARK_SCALAR_FIELD,
                    "balance can't go over the FIELD LIMIT"
                );
                _balances[to] = newBalance;

                // we only care about `to` since zktranswarp accounts can only receive from the public not spend
                // so the _balances[to] number goes up only :D
                // this inserts both _accountNoteHash and poseidon2(to, newBalance)
                newBalances[i] = newBalance;
            }
            emit Transfer(address(0), to, value);
        }
        _updateBalanceInMerkleTree(
            recipients,
            newBalances,
            _totalMintedLeafsTrimmed
        );
    }

    /**
     *
     * Requirements:
     *
     * - `to` cannot contain zero addresses.
     * - the caller must have a balance of at least `value`.
     */
    function transferBulk(
        address[] calldata recipients,
        uint256[] calldata values
    ) public virtual returns (bool) {
        require(
            recipients.length == values.length,
            "recipients and values length did not match"
        );
        address from = _msgSender();
        if (from == address(0)) {
            revert ERC20InvalidSender(address(0));
        }

        uint256 amountRecipients = recipients.length;
        uint256[] memory newBalances = new uint256[](amountRecipients);
        // do transfers
        for (uint256 i = 0; i < amountRecipients; i++) {
            address to = recipients[i];
            uint256 value = values[i];
            if (to == address(0)) {
                revert ERC20InvalidReceiver(address(0));
            }
            newBalances[i] = _update(from, to, value);
        }

        _updateBalanceInMerkleTree(recipients, newBalances, new uint256[](0));
        return true;
    }

    /**
     * @dev Creates a `value` amount of tokens and assigns them to `account`, by transferring it from address(0).
     * Relies on the `_update` mechanism
     *
     * Emits a {Transfer} event with `from` set to the zero address.
     *
     * NOTE: This function is not virtual, {_update} should be overridden instead.
     */
    function _mint(address account, uint256 value) internal {
        if (account == address(0)) {
            revert ERC20InvalidReceiver(address(0));
        }

        uint256 toNewBalance = _update(address(0), account, value);
        _updateBalanceInMerkleTree(account, toNewBalance);
    }

    /**
     * @dev Destroys a `value` amount of tokens from `account`, lowering the total supply.
     * Relies on the `_update` mechanism.
     *
     * Emits a {Transfer} event with `to` set to the zero address.
     *
     * NOTE: This function is not virtual, {_update} should be overridden instead
     */
    function _burn(address account, uint256 value) internal {
        if (account == address(0)) {
            revert ERC20InvalidSender(address(0));
        }
        _update(account, address(0), value);
        // this is a real burn. No-one can remint from this account
        // we can skip merkle tree inserts
    }

    /**
     * @dev Sets `value` as the allowance of `spender` over the `owner` s tokens.
     *
     * This internal function is equivalent to `approve`, and can be used to
     * e.g. set automatic allowances for certain subsystems, etc.
     *
     * Emits an {Approval} event.
     *
     * Requirements:
     *
     * - `owner` cannot be the zero address.
     * - `spender` cannot be the zero address.
     *
     * Overrides to this logic should be done to the variant with an additional `bool emitEvent` argument.
     */
    function _approve(address owner, address spender, uint256 value) internal {
        _approve(owner, spender, value, true);
    }

    /**
     * @dev Variant of {_approve} with an optional flag to enable or disable the {Approval} event.
     *
     * By default (when calling {_approve}) the flag is set to true. On the other hand, approval changes made by
     * `_spendAllowance` during the `transferFrom` operation set the flag to false. This saves gas by not emitting any
     * `Approval` event during `transferFrom` operations.
     *
     * Anyone who wishes to continue emitting `Approval` events on the`transferFrom` operation can force the flag to
     * true using the following override:
     *
     * ```solidity
     * function _approve(address owner, address spender, uint256 value, bool) internal virtual override {
     *     super._approve(owner, spender, value, true);
     * }
     * ```
     *
     * Requirements are the same as {_approve}.
     */
    function _approve(
        address owner,
        address spender,
        uint256 value,
        bool emitEvent
    ) internal virtual {
        if (owner == address(0)) {
            revert ERC20InvalidApprover(address(0));
        }
        if (spender == address(0)) {
            revert ERC20InvalidSpender(address(0));
        }
        _allowances[owner][spender] = value;
        if (emitEvent) {
            emit Approval(owner, spender, value);
        }
    }

    /**
     * @dev Updates `owner` s allowance for `spender` based on spent `value`.
     *
     * Does not update the allowance value in case of infinite allowance.
     * Revert if not enough allowance is available.
     *
     * Does not emit an {Approval} event.
     */
    function _spendAllowance(
        address owner,
        address spender,
        uint256 value
    ) internal virtual {
        uint256 currentAllowance = allowance(owner, spender);
        if (currentAllowance < type(uint256).max) {
            if (currentAllowance < value) {
                revert ERC20InsufficientAllowance(
                    spender,
                    currentAllowance,
                    value
                );
            }
            unchecked {
                _approve(owner, spender, currentAllowance - value, false);
            }
        }
    }
}
