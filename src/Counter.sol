// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

contract Counter {
    uint256 public number;

    event NewNumber(uint256 newNumber);

    function setNumber(uint256 newNumber) public {
        number = newNumber;
        emit NewNumber(number);
    }

    function increment() public returns(uint256, uint256) {
        number++;
        emit NewNumber(number);
        return (number, block.number);
    }
}
