// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TIMOv2} from "../src/TIMOv2.sol";

/// @notice Deploys TIMO v2 on Aevum testnet with the real tUSD8 and the TIMO fundwallet
///         as fee recipient. Run with the deployer key:
///         forge script script/DeployTIMOv2.s.sol --rpc-url aevum --broadcast --private-key $PK
contract DeployTIMOv2 is Script {
    address constant AEVUM_TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;
    address constant FUNDWALLET = 0x7580d1C234d70A8583D43c5e454B42ec78032D50;

    function run() external returns (TIMOv2 timo) {
        require(block.chainid == 44005, "Aevum testnet only");
        require(AEVUM_TUSD8.code.length > 0, "tUSD8 not found on this chain");
        vm.startBroadcast();
        timo = new TIMOv2(IERC20(AEVUM_TUSD8), FUNDWALLET);
        vm.stopBroadcast();
        console.log("TIMOv2 deployed:", address(timo));
        console.log("Owner:", timo.owner());
        console.log("Fee recipient:", timo.feeRecipient());
    }
}
