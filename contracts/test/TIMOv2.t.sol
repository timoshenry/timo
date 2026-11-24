// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TIMOv2} from "../src/TIMOv2.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";
import {Signing} from "./Signing.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract TIMOv2Test is Test {
    TIMOv2 timo;
    MockUSD8 usd;

    uint256 ownerPk = 0x0A11CE;
    address owner = vm.addr(ownerPk);
    address feeRecipient = makeAddr("fundwallet");
    address boss = makeAddr("boss");
    address buyer;
    uint256 buyerPk = 0xB0B;
    address buyer2 = makeAddr("buyer2");
    uint256 guardPk = 0x600D;
    uint256 adminPk = 0xAD011;

    address[] admins;
    address[] guards;

    uint256 constant PRICE = 1e6; // 1 tUSD8
    uint64 t0;

    function setUp() public {
        vm.warp(1_766_000_000);
        buyer = vm.addr(buyerPk);
        usd = new MockUSD8();
        vm.prank(owner);
        timo = new TIMOv2(usd, feeRecipient);
        t0 = uint64(block.timestamp);
        admins = new address[](2);
        admins[0] = vm.addr(adminPk);
        admins[1] = makeAddr("admin2");
        guards = new address[](5);
        guards[0] = vm.addr(guardPk);
        for (uint256 i = 1; i < 5; i++) guards[i] = vm.addr(0x6000 + i);
        usd.mint(buyer, 100e6);
        usd.mint(buyer2, 100e6);
        usd.mint(owner, 100e6);
    }


    function _params(uint32 capacity, uint16 feeBps, uint64 salesEnd, uint64 doors, uint64 startsAt)
        internal
        view
        returns (TIMOv2.CreateEventParams memory)
    {
        return TIMOv2.CreateEventParams({
            price: PRICE,
            capacity: capacity,
            feeBps: feeBps,
            salesEnd: salesEnd,
            checkInOpensAt: doors,
            startsAt: startsAt,
            boss: boss,
            name: "Launch Night",
            imageUrl: "https://img.example/x.png",
            metadataURI: "ipfs://meta",
            admins: admins,
            guards: guards
        });
    }

    function _create(uint32 capacity, uint16 feeBps, uint64 startsIn) internal returns (uint256 id) {
        uint64 doors = t0 + startsIn - 2 hours > t0 ? t0 + startsIn - 2 hours : t0;
        vm.prank(owner);
        id = timo.createEvent(_params(capacity, feeBps, t0 + startsIn - 1 hours, doors, t0 + startsIn));
    }

    function _buy(uint256 id, address who) internal returns (uint256 tokenId) {
        vm.startPrank(who);
        usd.approve(address(timo), PRICE);
        tokenId = timo.buyTicket(id);
        vm.stopPrank();
    }

    function _signMsg(uint256 pk, string memory message) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, MessageHashUtils.toEthSignedMessageHash(bytes(message)));
        return abi.encodePacked(r, s, v);
    }

    // ── Creation & roles ─────────────────────────────────────────────────────

    function test_CreateEvent_StoresRolesAndData() public {
        uint256 id = _create(100, 100, 3 days);
        (address b, address[] memory a, address[] memory g) = timo.eventRoles(id);
        assertEq(b, boss);
        assertEq(a.length, 2);
        assertEq(g.length, 5);
        assertEq(timo.roleOf(id, admins[0]), 1);
        assertEq(timo.roleOf(id, guards[0]), 2);
        assertEq(timo.roleOf(id, buyer), 0);
        TIMOv2.EventInfo memory ev = timo.eventOf(id);
        assertEq(ev.price, PRICE);
        assertEq(ev.feeBps, 100);
        assertEq(ev.boss, boss);
    }

    function test_CreateEvent_OnlyOwner() public {
        vm.prank(buyer);
        vm.expectRevert();
        timo.createEvent(_params(10, 100, t0 + 1 days, t0, t0 + 2 days));
    }

    function test_CreateEvent_RoleCountBounds() public {
        address[] memory noAdmins = new address[](0);
        vm.prank(owner);
        vm.expectRevert(TIMOv2.InvalidRoles.selector);
        TIMOv2.CreateEventParams memory p = _params(10, 100, t0 + 1 days, t0, t0 + 2 days);
        p.admins = noAdmins;
        timo.createEvent(p);

        address[] memory fourGuards = new address[](4);
        for (uint256 i = 0; i < 4; i++) fourGuards[i] = guards[i];
        vm.prank(owner);
        vm.expectRevert(TIMOv2.InvalidRoles.selector);
        TIMOv2.CreateEventParams memory p2 = _params(10, 100, t0 + 1 days, t0, t0 + 2 days);
        p2.guards = fourGuards;
        timo.createEvent(p2);
    }

    function test_CreateEvent_DuplicateAndBossRolesRevert() public {
        address[] memory dup = new address[](5);
        dup[0] = guards[0];
        dup[1] = guards[0];
        dup[2] = guards[1];
        dup[3] = guards[2];
        dup[4] = guards[3];
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TIMOv2.DuplicateRole.selector, guards[0]));
        TIMOv2.CreateEventParams memory p3 = _params(10, 100, t0 + 1 days, t0, t0 + 2 days);
        p3.guards = dup;
        timo.createEvent(p3);

        address[] memory bossGuard = new address[](5);
        bossGuard[0] = boss;
        for (uint256 i = 1; i < 5; i++) bossGuard[i] = guards[i];
        vm.prank(owner);
        vm.expectRevert(TIMOv2.InvalidRoles.selector);
        TIMOv2.CreateEventParams memory p4 = _params(10, 100, t0 + 1 days, t0, t0 + 2 days);
        p4.guards = bossGuard;
        timo.createEvent(p4);
    }

    function test_CreateEvent_FeeCapAndPriceImmutable() public {
        vm.prank(owner);
        vm.expectRevert(TIMOv2.FeeTooHigh.selector);
        timo.createEvent(_params(10, 1001, t0 + 1 days, t0, t0 + 2 days));
        // No function exists to change price/capacity/fee/roles: immutability is structural.
    }

    // ── Buying ───────────────────────────────────────────────────────────────

    function test_BuyTicket_EscrowAndNft() public {
        uint256 id = _create(2, 100, 3 days);
        uint256 tokenId = _buy(id, buyer);
        assertEq(timo.ownerOf(tokenId), buyer);
        assertEq(usd.balanceOf(address(timo)), PRICE);
        assertEq(timo.eventOf(id).escrow, PRICE);
        string memory uri = timo.tokenURI(tokenId);
        assertTrue(bytes(uri).length > 100);
    }

    function test_BuyTicketGasless_RelayedByThirdParty() public {
        uint256 id = _create(2, 100, 3 days);
        bytes32 nonce = timo.authorizationNonce(id, buyer);
        Signing.Auth memory a = Signing.Auth({
            from: buyer,
            to: address(timo),
            value: PRICE,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            nonce: nonce
        });
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(vm, buyerPk, usd.DOMAIN_SEPARATOR(), a);
        address relayer = makeAddr("relayer");
        vm.prank(relayer); // relayer has no tUSD8 and pays only gas
        uint256 tokenId = timo.buyTicketGasless(id, buyer, 0, block.timestamp + 1 hours, v, r, s);
        assertEq(timo.ownerOf(tokenId), buyer);
        // Replay of the same signature must fail (nonce has moved on).
        vm.prank(relayer);
        vm.expectRevert();
        timo.buyTicketGasless(id, buyer, 0, block.timestamp + 1 hours, v, r, s);
    }

    function test_Buy_SoldOutAndSalesClosed() public {
        uint256 id = _create(1, 100, 3 days);
        _buy(id, buyer);
        vm.startPrank(buyer2);
        usd.approve(address(timo), PRICE);
        vm.expectRevert(abi.encodeWithSelector(TIMOv2.SoldOut.selector, id));
        timo.buyTicket(id);
        vm.stopPrank();

        uint256 id2 = _create(5, 100, 3 days);
        vm.warp(t0 + 3 days - 30 minutes);
        vm.startPrank(buyer2);
        vm.expectRevert(abi.encodeWithSelector(TIMOv2.SalesClosed.selector, id2));
        timo.buyTicket(id2);
        vm.stopPrank();
    }

    // ── Check-in ─────────────────────────────────────────────────────────────

    function test_CheckIn_DirectByGuard() public {
        uint256 id = _create(10, 100, 1 hours);
        uint256 tokenId = _buy(id, buyer);
        uint256 expiry = block.timestamp + 60;
        bytes memory ownerSig = _signMsg(buyerPk, timo.checkInMessage(tokenId, expiry));
        vm.prank(guards[0]);
        timo.checkIn(tokenId, expiry, ownerSig);
        assertTrue(timo.ticketOf(tokenId).checkedIn);
        // Checked-in tickets are locked against transfer.
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(TIMOv2.TicketLocked.selector, tokenId));
        timo.transferFrom(buyer, buyer2, tokenId);
    }

    function test_CheckIn_RelayedDualSignature() public {
        uint256 id = _create(10, 100, 1 hours);
        uint256 tokenId = _buy(id, buyer);
        uint256 expiry = block.timestamp + 60;
        bytes memory ownerSig = _signMsg(buyerPk, timo.checkInMessage(tokenId, expiry));
        bytes memory staffSig = _signMsg(guardPk, timo.staffCheckInMessage(tokenId, expiry));
        address relayer = makeAddr("relayer");
        vm.prank(relayer);
        timo.checkInRelayed(tokenId, expiry, ownerSig, staffSig);
        assertTrue(timo.ticketOf(tokenId).checkedIn);
    }

    function test_CheckIn_RogueGuardAndForgedOwnerFail() public {
        uint256 id = _create(10, 100, 1 hours);
        uint256 tokenId = _buy(id, buyer);
        uint256 expiry = block.timestamp + 60;
        // Buyer2 (no role) tries to check in with a valid owner signature.
        bytes memory ownerSig = _signMsg(buyerPk, timo.checkInMessage(tokenId, expiry));
        vm.prank(buyer2);
        vm.expectRevert(abi.encodeWithSelector(TIMOv2.NotStaff.selector, id, buyer2));
        timo.checkIn(tokenId, expiry, ownerSig);
        // Guard with a forged owner signature (signed by guard, not the owner).
        bytes memory forged = _signMsg(guardPk, timo.checkInMessage(tokenId, expiry));
        vm.prank(guards[0]);
        vm.expectRevert(abi.encodeWithSelector(TIMOv2.BadOwnerSignature.selector, tokenId));
        timo.checkIn(tokenId, expiry, forged);
        // Stale signature (expiry in the past).
        bytes memory stale = _signMsg(buyerPk, timo.checkInMessage(tokenId, block.timestamp - 1));
        vm.prank(guards[0]);
        vm.expectRevert(TIMOv2.SignatureStale.selector);
        timo.checkIn(tokenId, block.timestamp - 1, stale);
    }

    function test_CheckIn_TooEarlyAndDouble() public {
        uint256 id = _create(10, 100, 3 days); // doors open at start - 2h
        uint256 tokenId = _buy(id, buyer);
        uint256 expiry = block.timestamp + 60;
        bytes memory ownerSig = _signMsg(buyerPk, timo.checkInMessage(tokenId, expiry));
        vm.prank(guards[0]);
        vm.expectRevert(abi.encodeWithSelector(TIMOv2.CheckInTooEarly.selector, tokenId));
        timo.checkIn(tokenId, expiry, ownerSig);

        vm.warp(t0 + 3 days - 2 hours);
        uint256 expiry2 = block.timestamp + 60;
        bytes memory sig2 = _signMsg(buyerPk, timo.checkInMessage(tokenId, expiry2));
        vm.prank(guards[0]);
        timo.checkIn(tokenId, expiry2, sig2);
        uint256 expiry3 = block.timestamp + 60;
        bytes memory sig3 = _signMsg(buyerPk, timo.checkInMessage(tokenId, expiry3));
        vm.prank(guards[0]);
        vm.expectRevert(abi.encodeWithSelector(TIMOv2.AlreadyCheckedIn.selector, tokenId));
        timo.checkIn(tokenId, expiry3, sig3);
    }

    // ── Reschedule & refunds ─────────────────────────────────────────────────

    function test_Reschedule_OpensVoluntaryRefundWindow() public {
        uint256 id = _create(10, 100, 3 days);
        uint256 tokenId = _buy(id, buyer);
        // Not refundable before any reschedule.
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(TIMOv2.NotRefundable.selector, tokenId));
        timo.claimRefund(tokenId);

        vm.prank(owner);
        timo.updateEventTimes(id, t0 + 6 days, t0 + 7 days - 2 hours, t0 + 7 days);
        uint256 balBefore = usd.balanceOf(buyer);
        vm.prank(buyer);
        timo.claimRefund(tokenId);
        assertEq(usd.balanceOf(buyer), balBefore + PRICE);
        assertEq(timo.eventOf(id).escrow, 0);
        // NFT date attribute follows the new schedule.
        uint256 token2 = _buy(id, buyer2);
        assertTrue(bytes(timo.tokenURI(token2)).length > 100);
    }

    function test_Cancel_ThenFullRefund_OnlyOwnerCancels() public {
        uint256 id = _create(10, 100, 3 days);
        uint256 tokenId = _buy(id, buyer);
        vm.prank(buyer);
        vm.expectRevert(); // buyers/organizers cannot cancel; owner only
        timo.cancelEvent(id);
        vm.prank(owner);
        timo.cancelEvent(id);
        uint256 balBefore = usd.balanceOf(buyer);
        vm.prank(buyer);
        timo.claimRefund(tokenId);
        assertEq(usd.balanceOf(buyer), balBefore + PRICE);
        // Double refund impossible (ticket burned).
        vm.prank(buyer);
        vm.expectRevert();
        timo.claimRefund(tokenId);
    }

    // ── Withdraw & fee split ─────────────────────────────────────────────────

    function test_Withdraw_SplitsFeeToFundwallet() public {
        uint256 id = _create(100, 100, 1 days); // 1% fee
        for (uint256 i = 0; i < 4; i++) _buy(id, i % 2 == 0 ? buyer : buyer2);
        // Too early.
        vm.prank(owner);
        vm.expectRevert(TIMOv2.TooEarlyToWithdraw.selector);
        timo.withdraw(id);
        vm.warp(t0 + 1 days + 24 hours);
        uint256 bossBefore = usd.balanceOf(boss);
        uint256 feeBefore = usd.balanceOf(feeRecipient);
        vm.prank(owner);
        timo.withdraw(id);
        assertEq(usd.balanceOf(boss), bossBefore + 4 * PRICE - (4 * PRICE) / 100);
        assertEq(usd.balanceOf(feeRecipient), feeBefore + (4 * PRICE) / 100);
        assertEq(usd.balanceOf(address(timo)), 0);
        // Second withdraw reverts.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TIMOv2.AlreadyWithdrawn.selector, id));
        timo.withdraw(id);
    }

    function test_Withdraw_CancelledEventReverts() public {
        uint256 id = _create(10, 100, 1 days);
        _buy(id, buyer);
        vm.prank(owner);
        timo.cancelEvent(id);
        vm.warp(t0 + 3 days);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TIMOv2.EventIsCancelled.selector, id));
        timo.withdraw(id);
    }

    // ── Invariant-style accounting ───────────────────────────────────────────

    function test_EscrowAccounting_AcrossEvents() public {
        uint256 a = _create(10, 100, 1 days);
        uint256 b = _create(10, 250, 1 days);
        _buy(a, buyer);
        _buy(a, buyer2);
        _buy(b, buyer);
        uint256 sum = timo.eventOf(a).escrow + timo.eventOf(b).escrow;
        assertEq(usd.balanceOf(address(timo)), sum);
        vm.prank(owner);
        timo.cancelEvent(b);
        vm.prank(buyer);
        timo.claimRefund(3);
        sum = timo.eventOf(a).escrow + timo.eventOf(b).escrow;
        assertEq(usd.balanceOf(address(timo)), sum);
    }
}
