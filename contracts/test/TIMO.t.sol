// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TIMO} from "../src/TIMO.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";
import {Signing} from "./Signing.sol";

contract TIMOTest is Test {
    uint256 internal constant PRICE = 25e6; // 25 tUSD8

    MockUSD8 internal token;
    TIMO internal timo;

    address internal organizer = makeAddr("organizer");
    address internal buyer = makeAddr("buyer");
    address internal buyer2 = makeAddr("buyer2");
    address internal stranger = makeAddr("stranger");

    uint256 internal buyerPk = 0xB0B;
    address internal gaslessBuyer;

    uint64 internal startsAt;
    uint64 internal salesEnd;
    uint256 internal eventId;

    function setUp() public {
        token = new MockUSD8();
        timo = new TIMO(token);
        gaslessBuyer = vm.addr(buyerPk);

        startsAt = uint64(block.timestamp + 2 days);
        salesEnd = uint64(block.timestamp + 1 days);

        token.mint(buyer, 1_000e6);
        token.mint(buyer2, 1_000e6);
        token.mint(gaslessBuyer, 1_000e6);

        vm.prank(organizer);
        eventId = timo.createEvent(PRICE, 2, salesEnd, startsAt, "ipfs://event-1");
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _buy(address who) internal returns (uint256 tokenId) {
        vm.startPrank(who);
        token.approve(address(timo), PRICE);
        tokenId = timo.buyTicket(eventId);
        vm.stopPrank();
    }

    function _gaslessBuy(address relayer) internal returns (uint256 tokenId) {
        bytes32 nonce = timo.authorizationNonce(eventId, gaslessBuyer);
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(
            vm,
            buyerPk,
            token.DOMAIN_SEPARATOR(),
            Signing.Auth({
                from: gaslessBuyer,
                to: address(timo),
                value: PRICE,
                validAfter: 0,
                validBefore: block.timestamp + 1 hours,
                nonce: nonce
            })
        );
        vm.prank(relayer);
        tokenId = timo.buyTicketGasless(eventId, gaslessBuyer, 0, block.timestamp + 1 hours, v, r, s);
    }

    // ── createEvent ──────────────────────────────────────────────────────────

    function test_CreateEvent_StoresFields() public view {
        TIMO.EventInfo memory ev = timo.eventOf(eventId);
        assertEq(ev.organizer, organizer);
        assertEq(ev.price, PRICE);
        assertEq(ev.capacity, 2);
        assertEq(uint8(ev.status), uint8(TIMO.EventStatus.Open));
    }

    function test_CreateEvent_InvalidParamsRevert() public {
        vm.expectRevert(TIMO.InvalidEventParams.selector);
        timo.createEvent(0, 10, salesEnd, startsAt, "x");
        vm.expectRevert(TIMO.InvalidEventParams.selector);
        timo.createEvent(PRICE, 10, startsAt, startsAt, "x"); // salesEnd !< startsAt
    }

    // ── buyTicket ────────────────────────────────────────────────────────────

    function test_BuyTicket_MintsAndEscrows() public {
        uint256 tokenId = _buy(buyer);
        assertEq(timo.ownerOf(tokenId), buyer);
        assertEq(token.balanceOf(address(timo)), PRICE);
        assertEq(timo.eventOf(eventId).escrow, PRICE);
        assertEq(timo.eventOf(eventId).sold, 1);
    }

    function test_BuyTicket_SoldOutReverts() public {
        _buy(buyer);
        _buy(buyer2);
        vm.startPrank(buyer);
        token.approve(address(timo), PRICE);
        vm.expectRevert(abi.encodeWithSelector(TIMO.SoldOut.selector, eventId));
        timo.buyTicket(eventId);
        vm.stopPrank();
    }

    function test_BuyTicket_AfterSalesEndReverts() public {
        vm.warp(salesEnd + 1);
        vm.startPrank(buyer);
        token.approve(address(timo), PRICE);
        vm.expectRevert(abi.encodeWithSelector(TIMO.SalesClosed.selector, eventId));
        timo.buyTicket(eventId);
        vm.stopPrank();
    }

    function test_BuyTicket_WithoutFundsReverts() public {
        vm.startPrank(stranger);
        token.approve(address(timo), PRICE);
        vm.expectRevert();
        timo.buyTicket(eventId);
        vm.stopPrank();
    }

    // ── buyTicketGasless ─────────────────────────────────────────────────────

    function test_BuyGasless_WorksViaRelayer() public {
        uint256 tokenId = _gaslessBuy(stranger); // relayer needs no balance/allowance
        assertEq(timo.ownerOf(tokenId), gaslessBuyer);
        assertEq(token.balanceOf(address(timo)), PRICE);
    }

    function test_BuyGasless_ReplayedNonceReverts() public {
        _gaslessBuy(stranger);
        // Nonce for a *second* purchase differs, so replaying the first signature
        // against the fresh expected nonce must fail inside the token.
        bytes32 staleNonce = keccak256(abi.encode(address(timo), eventId, gaslessBuyer, uint256(0)));
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(
            vm,
            buyerPk,
            token.DOMAIN_SEPARATOR(),
            Signing.Auth({
                from: gaslessBuyer,
                to: address(timo),
                value: PRICE,
                validAfter: 0,
                validBefore: block.timestamp + 1 hours,
                nonce: staleNonce
            })
        );
        vm.expectRevert();
        timo.buyTicketGasless(eventId, gaslessBuyer, 0, block.timestamp + 1 hours, v, r, s);
    }

    // ── cancel & refund ──────────────────────────────────────────────────────

    function test_Cancel_ByNonOrganizerReverts() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(TIMO.NotOrganizer.selector, eventId));
        timo.cancelEvent(eventId);
    }

    function test_Refund_FullAmountToCurrentOwner() public {
        uint256 tokenId = _buy(buyer);
        // resale: buyer -> buyer2, refund must follow the current owner
        vm.prank(buyer);
        timo.transferFrom(buyer, buyer2, tokenId);

        vm.prank(organizer);
        timo.cancelEvent(eventId);

        uint256 before = token.balanceOf(buyer2);
        vm.prank(buyer2);
        timo.claimRefund(tokenId);
        assertEq(token.balanceOf(buyer2), before + PRICE);
        assertEq(timo.eventOf(eventId).escrow, 0);
    }

    function test_Refund_DoubleClaimReverts() public {
        uint256 tokenId = _buy(buyer);
        vm.prank(organizer);
        timo.cancelEvent(eventId);
        vm.prank(buyer);
        timo.claimRefund(tokenId);
        vm.prank(buyer);
        vm.expectRevert(); // ticket burned; no longer exists
        timo.claimRefund(tokenId);
    }

    function test_Refund_OnOpenEventReverts() public {
        uint256 tokenId = _buy(buyer);
        vm.prank(buyer);
        vm.expectRevert();
        timo.claimRefund(tokenId);
    }

    function test_Buy_AfterCancelReverts() public {
        vm.prank(organizer);
        timo.cancelEvent(eventId);
        vm.startPrank(buyer);
        token.approve(address(timo), PRICE);
        vm.expectRevert(abi.encodeWithSelector(TIMO.EventNotOpen.selector, eventId));
        timo.buyTicket(eventId);
        vm.stopPrank();
    }

    // ── withdraw ─────────────────────────────────────────────────────────────

    function test_Withdraw_AfterEventPaysOrganizer() public {
        _buy(buyer);
        _buy(buyer2);
        vm.warp(uint256(startsAt) + 24 hours);
        uint256 before = token.balanceOf(organizer);
        vm.prank(organizer);
        timo.withdraw(eventId);
        assertEq(token.balanceOf(organizer), before + 2 * PRICE);
        assertEq(uint8(timo.eventOf(eventId).status), uint8(TIMO.EventStatus.Completed));
    }

    function test_Withdraw_TooEarlyReverts() public {
        _buy(buyer);
        vm.prank(organizer);
        vm.expectRevert(TIMO.TooEarlyToWithdraw.selector);
        timo.withdraw(eventId);
    }

    function test_Withdraw_OnCancelledReverts() public {
        _buy(buyer);
        vm.prank(organizer);
        timo.cancelEvent(eventId);
        vm.warp(uint256(startsAt) + 24 hours);
        vm.prank(organizer);
        vm.expectRevert(abi.encodeWithSelector(TIMO.EventIsCancelled.selector, eventId));
        timo.withdraw(eventId);
    }

    function test_Withdraw_DoubleReverts() public {
        _buy(buyer);
        vm.warp(uint256(startsAt) + 24 hours);
        vm.startPrank(organizer);
        timo.withdraw(eventId);
        vm.expectRevert(abi.encodeWithSelector(TIMO.AlreadyWithdrawn.selector, eventId));
        timo.withdraw(eventId);
        vm.stopPrank();
    }

    // ── check-in ─────────────────────────────────────────────────────────────

    function test_CheckIn_LocksTicket() public {
        uint256 tokenId = _buy(buyer);
        vm.warp(startsAt);
        vm.prank(organizer);
        timo.checkIn(tokenId);
        assertTrue(timo.ticketOf(tokenId).checkedIn);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(TIMO.TicketLocked.selector, tokenId));
        timo.transferFrom(buyer, buyer2, tokenId);
    }

    function test_CheckIn_DoubleReverts() public {
        uint256 tokenId = _buy(buyer);
        vm.warp(startsAt);
        vm.startPrank(organizer);
        timo.checkIn(tokenId);
        vm.expectRevert(abi.encodeWithSelector(TIMO.AlreadyCheckedIn.selector, tokenId));
        timo.checkIn(tokenId);
        vm.stopPrank();
    }

    function test_CheckIn_TooEarlyReverts() public {
        uint256 tokenId = _buy(buyer);
        vm.prank(organizer);
        vm.expectRevert(abi.encodeWithSelector(TIMO.CheckInTooEarly.selector, tokenId));
        timo.checkIn(tokenId);
    }
}
