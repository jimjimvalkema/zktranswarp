// SPDX-License-Identifier: MIT

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

pragma solidity ^0.8.3;

contract Split {
    function split(address _tokenAddress, address[] calldata _recipients, uint256[] calldata _amounts) public  {
        IERC20 _token = IERC20(_tokenAddress);
        for (uint256 i = 0; i < _recipients.length; i++) {
            _token.transfer(_recipients[i], _amounts[i]);
        } 
    }
}