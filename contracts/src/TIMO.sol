// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice EIP-3009 (USDC-style) signed transfers. tUSD8 on Aevum implements this.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title TIMO — Ticket & Invoice Management Onchain
/// @notice Event tickets paid in tUSD8. Ticket payments are held in per-event escrow:
///         if the organizer cancels, every current ticket owner can claim a full refund;
///         if the event completes, the organizer withdraws the escrow after the event.
///         Each ticket is an ERC-721 and each `TicketPurchased` event is the payment receipt.
/// @dev Two ways to buy:
///      1. `buyTicket`: approve this contract, then call it (buyer pays gas).
///      2. `buyTicketGasless`: sign an EIP-3009 message off-chain; anyone (a relayer)
///         submits it and the buyer needs no native gas token.
contract TIMO is ERC721, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum EventStatus {
        Open,
        Cancelled,
        Completed
    }

    struct EventInfo {
        address organizer;
        uint256 price;
        uint256 escrow;
        uint32 capacity;
        uint32 sold;
        uint64 salesEnd;
        uint64 startsAt;
        EventStatus status;
        bool withdrawn;
        string metadataURI;
    }

    struct TicketInfo {
        uint256 eventId;
        bool checkedIn;
        bool refunded;
    }

    uint256 public constant WITHDRAW_DELAY = 24 hours;

    IERC20 public immutable token;

    uint256 public nextEventId = 1;
    uint256 public nextTokenId = 1;

    mapping(uint256 eventId => EventInfo) private _events;
    mapping(uint256 tokenId => TicketInfo) private _tickets;
    /// @dev Per-buyer purchase count per event; makes each gasless nonce unique per purchase.
    mapping(uint256 eventId => mapping(address buyer => uint256 count)) private _buyerBuys;

    event EventCreated(
        uint256 indexed eventId, address indexed organizer, uint256 price, uint32 capacity, uint64 startsAt
    );
    event TicketPurchased(uint256 indexed eventId, uint256 indexed tokenId, address indexed buyer, uint256 price);
    event EventCancelled(uint256 indexed eventId);
    event RefundClaimed(uint256 indexed tokenId, address indexed owner, uint256 amount);
    event CheckedIn(uint256 indexed tokenId);
    event Withdrawn(uint256 indexed eventId, address indexed organizer, uint256 amount);

    error ZeroAddress();
    error InvalidEventParams();
    error EventNotFound(uint256 eventId);
    error EventNotOpen(uint256 eventId);
    error SalesClosed(uint256 eventId);
    error SoldOut(uint256 eventId);
    error NotOrganizer(uint256 eventId);
    error TooEarlyToCancel();
    error TooEarlyToWithdraw();
    error AlreadyWithdrawn(uint256 eventId);
    error EventIsCancelled(uint256 eventId);
    error NotTicketOwner(uint256 tokenId);
    error AlreadyCheckedIn(uint256 tokenId);
    error AlreadyRefunded(uint256 tokenId);
    error TicketLocked(uint256 tokenId);
    error CheckInTooEarly(uint256 tokenId);

    constructor(IERC20 token_) ERC721("TIMO Ticket", "TIMO") {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    // ── Organizer ────────────────────────────────────────────────────────────

    function createEvent(
        uint256 price,
        uint32 capacity,
        uint64 salesEnd,
        uint64 startsAt,
        string calldata metadataURI
    ) external returns (uint256 eventId) {
        if (price == 0 || capacity == 0 || salesEnd >= startsAt || startsAt <= block.timestamp) {
            revert InvalidEventParams();
        }
        eventId = nextEventId++;
        _events[eventId] = EventInfo({
            organizer: msg.sender,
            price: price,
            escrow: 0,
            capacity: capacity,
            sold: 0,
            salesEnd: salesEnd,
            startsAt: startsAt,
            status: EventStatus.Open,
            withdrawn: false,
            metadataURI: metadataURI
        });
        emit EventCreated(eventId, msg.sender, price, capacity, startsAt);
    }

    function cancelEvent(uint256 eventId) external {
        EventInfo storage ev = _eventOrRevert(eventId);
        if (msg.sender != ev.organizer) revert NotOrganizer(eventId);
        if (ev.status == EventStatus.Cancelled) revert EventIsCancelled(eventId);
        if (ev.withdrawn) revert AlreadyWithdrawn(eventId);
        if (block.timestamp >= ev.startsAt) revert TooEarlyToCancel();
        ev.status = EventStatus.Cancelled;
        emit EventCancelled(eventId);
    }

    function withdraw(uint256 eventId) external nonReentrant {
        EventInfo storage ev = _eventOrRevert(eventId);
        if (msg.sender != ev.organizer) revert NotOrganizer(eventId);
        if (ev.status == EventStatus.Cancelled) revert EventIsCancelled(eventId);
        if (ev.withdrawn) revert AlreadyWithdrawn(eventId);
        if (block.timestamp < uint256(ev.startsAt) + WITHDRAW_DELAY) revert TooEarlyToWithdraw();
        uint256 amount = ev.escrow;
        ev.escrow = 0;
        ev.withdrawn = true;
        ev.status = EventStatus.Completed;
        emit Withdrawn(eventId, msg.sender, amount);
        token.safeTransfer(msg.sender, amount);
    }

    /// @notice Lock a ticket at the door. Only the event's organizer, at or after start time.
    function checkIn(uint256 tokenId) external {
        TicketInfo storage t = _tickets[tokenId];
        if (t.eventId == 0) revert EventNotFound(0);
        EventInfo storage ev = _events[t.eventId];
        if (msg.sender != ev.organizer) revert NotOrganizer(t.eventId);
        if (ev.status == EventStatus.Cancelled) revert EventIsCancelled(t.eventId);
        if (block.timestamp < ev.startsAt) revert CheckInTooEarly(tokenId);
        if (t.checkedIn) revert AlreadyCheckedIn(tokenId);
        t.checkedIn = true;
        emit CheckedIn(tokenId);
    }

    // ── Buyers ───────────────────────────────────────────────────────────────

    /// @notice Buy one ticket with an approved tUSD8 balance. Funds stay in escrow.
    function buyTicket(uint256 eventId) external nonReentrant returns (uint256 tokenId) {
        EventInfo storage ev = _eventOrRevert(eventId);
        _requireBuyable(ev, eventId);
        tokenId = _issueTicket(ev, eventId, msg.sender);
        token.safeTransferFrom(msg.sender, address(this), ev.price);
    }

    /// @notice Buy one ticket with an EIP-3009 `ReceiveWithAuthorization` signed by `from`.
    /// @dev The signed nonce must be `authorizationNonce(eventId, from)`, which binds the
    ///      signature to this event, this buyer, and this specific purchase — a relayer
    ///      cannot replay it for another event or a second ticket.
    function buyTicketGasless(
        uint256 eventId,
        address from,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 tokenId) {
        EventInfo storage ev = _eventOrRevert(eventId);
        _requireBuyable(ev, eventId);
        bytes32 nonce = authorizationNonce(eventId, from);
        _buyerBuys[eventId][from]++;
        tokenId = _issueTicket(ev, eventId, from);
        IERC3009(address(token)).receiveWithAuthorization(
            from, address(this), ev.price, validAfter, validBefore, nonce, v, r, s
        );
    }

    /// @notice Claim a full refund for a ticket of a cancelled event. Burns the ticket.
    /// @dev Always pays the *current* owner, so refunds follow resale automatically.
    function claimRefund(uint256 tokenId) external nonReentrant {
        TicketInfo storage t = _tickets[tokenId];
        if (t.eventId == 0) revert EventNotFound(0);
        address owner = ownerOf(tokenId);
        if (msg.sender != owner) revert NotTicketOwner(tokenId);
        EventInfo storage ev = _events[t.eventId];
        if (ev.status != EventStatus.Cancelled) revert EventNotOpen(t.eventId);
        if (t.refunded) revert AlreadyRefunded(tokenId);
        uint256 amount = ev.price;
        t.refunded = true;
        ev.escrow -= amount;
        _burn(tokenId);
        emit RefundClaimed(tokenId, owner, amount);
        token.safeTransfer(owner, amount);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// @notice The EIP-3009 nonce `buyer` must sign for their next gasless purchase on `eventId`.
    function authorizationNonce(uint256 eventId, address buyer) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), eventId, buyer, _buyerBuys[eventId][buyer]));
    }

    function eventOf(uint256 eventId) external view returns (EventInfo memory) {
        return _events[eventId];
    }

    function ticketOf(uint256 tokenId) external view returns (TicketInfo memory) {
        return _tickets[tokenId];
    }

    // ── Internals ────────────────────────────────────────────────────────────

    function _eventOrRevert(uint256 eventId) private view returns (EventInfo storage) {
        EventInfo storage ev = _events[eventId];
        if (ev.organizer == address(0)) revert EventNotFound(eventId);
        return ev;
    }

    function _requireBuyable(EventInfo storage ev, uint256 eventId) private view {
        if (ev.status != EventStatus.Open) revert EventNotOpen(eventId);
        if (block.timestamp > ev.salesEnd) revert SalesClosed(eventId);
        if (ev.sold >= ev.capacity) revert SoldOut(eventId);
    }

    function _issueTicket(EventInfo storage ev, uint256 eventId, address buyer) private returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        ev.sold++;
        ev.escrow += ev.price;
        _tickets[tokenId] = TicketInfo({eventId: eventId, checkedIn: false, refunded: false});
        _mint(buyer, tokenId);
        emit TicketPurchased(eventId, tokenId, buyer, ev.price);
    }

    /// @dev Checked-in tickets are locked: they cannot be transferred (mint/burn unaffected).
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0) && _tickets[tokenId].checkedIn) {
            revert TicketLocked(tokenId);
        }
        return super._update(to, tokenId, auth);
    }
}
