// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TIMOv2} from "../src/TIMOv2.sol";
import {Signing} from "../test/Signing.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface ITUSD8 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice Live proof flow for TIMO v2 on Aevum. Keys come from env (OWNER_PK, BUYER_PK,
///         RELAYER_PK, GUARD_PK, TIMO_V2, META_JSON); role addresses from
///         script/demo-roles-addresses.json (public addresses only). Nothing secret is printed.
///         A: create -> relayed buy -> relayed dual-signature check-in
///         B: create -> relayed buy -> reschedule -> voluntary refund inside the window
///         C: create -> relayed buy -> cancel -> full refund
contract ProofV2 is Script {
    uint256 ownerPk;
    uint256 buyerPk;
    uint256 relayerPk;
    uint256 guardPk;
    address buyer;
    TIMOv2 timo;
    bytes32 domainSep;
    uint64 now64;
    string meta;

    function _params(uint64 salesEnd, uint64 doors, uint64 startsAt, string memory name, string memory rolesJson)
        internal
        view
        returns (TIMOv2.CreateEventParams memory)
    {
        return TIMOv2.CreateEventParams({
            price: 1e6,
            capacity: 10,
            feeBps: 100,
            salesEnd: salesEnd,
            checkInOpensAt: doors,
            startsAt: startsAt,
            boss: vm.parseJsonAddress(rolesJson, ".boss"),
            name: name,
            imageUrl: "https://timo-blush.vercel.app/logo.svg",
            metadataURI: meta,
            admins: vm.parseJsonAddressArray(rolesJson, ".admins"),
            guards: vm.parseJsonAddressArray(rolesJson, ".guards")
        });
    }

    function _createAll() internal returns (uint256, uint256, uint256) {
        string memory rolesJson = vm.readFile("script/demo-roles-addresses.json");
        vm.startBroadcast(ownerPk);
        uint256 evA = timo.createEvent(
            _params(now64 + 1 days, now64, now64 + 2 days, "TIMO v2 Launch Night", rolesJson)
        );
        uint256 evB = timo.createEvent(
            _params(now64 + 1 days, now64 + 1 days, now64 + 2 days, "TIMO v2 Reschedule Proof", rolesJson)
        );
        uint256 evC = timo.createEvent(
            _params(now64 + 1 days, now64 + 1 days, now64 + 2 days, "TIMO v2 Cancel Proof", rolesJson)
        );
        vm.stopBroadcast();
        return (evA, evB, evC);
    }

    function _gaslessBuy(uint256 eventId) internal returns (uint256 tokenId) {
        bytes32 nonce = timo.authorizationNonce(eventId, buyer);
        Signing.Auth memory a = Signing.Auth({
            from: buyer,
            to: address(timo),
            value: 1e6,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            nonce: nonce
        });
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(vm, buyerPk, domainSep, a);
        vm.startBroadcast(relayerPk);
        tokenId = timo.buyTicketGasless(eventId, buyer, 0, block.timestamp + 1 hours, v, r, s);
        vm.stopBroadcast();
    }

    function _sig(uint256 pk, string memory message) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, MessageHashUtils.toEthSignedMessageHash(bytes(message)));
        return abi.encodePacked(r, s, v);
    }

    function _flowA(uint256 evA) internal {
        uint256 tokA = _gaslessBuy(evA);
        console.log("A ticket:", tokA);
        uint256 expiry = block.timestamp + 60;
        bytes memory ownerSig = _sig(buyerPk, timo.checkInMessage(tokA, expiry));
        bytes memory staffSig = _sig(guardPk, timo.staffCheckInMessage(tokA, expiry));
        vm.startBroadcast(relayerPk);
        timo.checkInRelayed(tokA, expiry, ownerSig, staffSig);
        vm.stopBroadcast();
        console.log("A checked in via relayer");
    }

    function _flowB(uint256 evB) internal {
        uint256 tokB = _gaslessBuy(evB);
        vm.startBroadcast(ownerPk);
        timo.updateEventTimes(evB, now64 + 5 days, now64 + 6 days - 2 hours, now64 + 6 days);
        vm.stopBroadcast();
        vm.startBroadcast(buyerPk);
        timo.claimRefund(tokB);
        vm.stopBroadcast();
        console.log("B rescheduled + refunded:", tokB);
    }

    function _flowC(uint256 evC) internal {
        uint256 tokC = _gaslessBuy(evC);
        vm.startBroadcast(ownerPk);
        timo.cancelEvent(evC);
        vm.stopBroadcast();
        vm.startBroadcast(buyerPk);
        timo.claimRefund(tokC);
        vm.stopBroadcast();
        console.log("C cancelled + refunded:", tokC);
    }

    function run() external {
        ownerPk = vm.envUint("OWNER_PK");
        buyerPk = vm.envUint("BUYER_PK");
        relayerPk = vm.envUint("RELAYER_PK");
        guardPk = vm.envUint("GUARD_PK");
        buyer = vm.addr(buyerPk);
        timo = TIMOv2(vm.envAddress("TIMO_V2"));
        meta = vm.envString("META_JSON");
        domainSep = ITUSD8(address(timo.token())).DOMAIN_SEPARATOR();
        now64 = uint64(block.timestamp);

        (uint256 evA, uint256 evB, uint256 evC) = _createAll();
        console.log("Events A/B/C:", evA, evB, evC);
        _flowA(evA);
        _flowB(evB);
        _flowC(evC);
    }
}
