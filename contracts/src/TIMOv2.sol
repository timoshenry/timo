// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

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

/// @title TIMO v2 — Ticket & Invoice Management Onchain (official ticket agent model)
/// @notice TIMO is an official ticket agent: only the platform owner creates events, on behalf of
///         organizers who were vetted off-chain. Each event records a BossOrganizer (owner of the
///         event and sole payout recipient), 1-3 AdminOrganizer wallets and 5-25 GuardOrganizer
///         wallets. Roles are per event and immutable once set.
/// @dev Money rules (escrow safety):
///      - Ticket payments accumulate in per-event escrow held by this contract.
///      - Funds leave escrow through exactly two doors: `claimRefund` (to the ticket's current
///        owner, exact price, once per ticket, cancelled events or the 7-day post-reschedule
///        window) and `withdraw` (once per event, after start + 24h, split between the boss and
///        the platform fee recipient by the event's feeBps). There is deliberately NO admin
///        sweep or emergency drain of escrow.
///      - Price and capacity are immutable: they are the allocation agreed in the deal.
///      - Purchases are relay-friendly (EIP-3009) and check-in is relayed with two signatures:
///        the ticket owner's fresh (<= 60s) signature, verified on-chain against `ownerOf`,
///        plus a signature from a wallet holding a staff role for that event.
contract TIMOv2 is ERC721, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    enum EventStatus {
        Open,
        Cancelled,
        Completed
    }

    uint8 public constant ROLE_ADMIN = 1;
    uint8 public constant ROLE_GUARD = 2;

    uint256 public constant WITHDRAW_DELAY = 24 hours;
    uint256 public constant RESCHEDULE_REFUND_WINDOW = 7 days;
    uint256 public constant MAX_FEE_BPS = 1000; // 10% sanity cap
    uint256 public constant SIG_TTL = 60; // seconds; check-in signatures must be fresh

    struct EventInfo {
        address boss;
        uint256 price;
        uint256 escrow;
        uint32 capacity;
        uint32 sold;
        uint16 feeBps;
        uint64 salesEnd;
        uint64 checkInOpensAt;
        uint64 startsAt;
        uint64 refundWindowUntil;
        EventStatus status;
        bool withdrawn;
        string name;
        string imageUrl;
        string metadataURI;
    }

    struct TicketInfo {
        uint256 eventId;
        bool checkedIn;
        bool refunded;
    }

    IERC20 public immutable token;
    address public immutable feeRecipient;

    uint256 public nextEventId = 1;
    uint256 public nextTokenId = 1;

    mapping(uint256 eventId => EventInfo) private _events;
    mapping(uint256 tokenId => TicketInfo) private _tickets;
    mapping(uint256 eventId => mapping(address => uint8)) private _roles;
    mapping(uint256 eventId => address[]) private _admins;
    mapping(uint256 eventId => address[]) private _guards;
    /// @dev Per-buyer purchase count per event; makes each gasless nonce unique per purchase.
    mapping(uint256 eventId => mapping(address buyer => uint256 count)) private _buyerBuys;

    event EventCreated(
        uint256 indexed eventId, address indexed boss, uint256 price, uint32 capacity, uint64 startsAt, uint16 feeBps
    );
    event EventRescheduled(uint256 indexed eventId, uint64 salesEnd, uint64 checkInOpensAt, uint64 startsAt);
    event EventMetadataUpdated(uint256 indexed eventId);
    event EventCancelled(uint256 indexed eventId);
    event TicketPurchased(uint256 indexed eventId, uint256 indexed tokenId, address indexed buyer, uint256 price);
    event CheckedIn(uint256 indexed tokenId, address indexed staff);
    event RefundClaimed(uint256 indexed tokenId, address indexed owner, uint256 amount);
    event Withdrawn(uint256 indexed eventId, address indexed boss, uint256 amount, uint256 fee);

    error ZeroAddress();
    error InvalidEventParams();
    error InvalidRoles();
    error DuplicateRole(address account);
    error FeeTooHigh();
    error EventNotFound(uint256 eventId);
    error EventNotOpen(uint256 eventId);
    error SalesClosed(uint256 eventId);
    error SoldOut(uint256 eventId);
    error EventIsCancelled(uint256 eventId);
    error AlreadyWithdrawn(uint256 eventId);
    error TooEarlyToCancel();
    error TooEarlyToWithdraw();
    error TooLateToEdit(uint256 eventId);
    error NotTicketOwner(uint256 tokenId);
    error AlreadyCheckedIn(uint256 tokenId);
    error AlreadyRefunded(uint256 tokenId);
    error TicketLocked(uint256 tokenId);
    error CheckInTooEarly(uint256 tokenId);
    error NotStaff(uint256 eventId, address account);
    error BadOwnerSignature(uint256 tokenId);
    error BadStaffSignature(uint256 eventId);
    error SignatureStale();
    error NotRefundable(uint256 tokenId);

    constructor(IERC20 token_, address feeRecipient_) ERC721("TIMO Ticket", "TIMO") Ownable(msg.sender) {
        if (address(token_) == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        token = token_;
        feeRecipient = feeRecipient_;
    }

    // ── Platform (owner only): event administration ─────────────────────────

    struct CreateEventParams {
        uint256 price;
        uint32 capacity;
        uint16 feeBps;
        uint64 salesEnd;
        uint64 checkInOpensAt;
        uint64 startsAt;
        address boss;
        string name;
        string imageUrl;
        string metadataURI;
        address[] admins;
        address[] guards;
    }

    /// @notice Create an event on behalf of a vetted organizer. Roles are set here and can
    ///         never be changed afterwards (there is no role-changing function).
    function createEvent(CreateEventParams calldata p) external onlyOwner returns (uint256 eventId) {
        if (p.price == 0 || p.capacity == 0 || p.boss == address(0)) revert InvalidEventParams();
        if (p.feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (p.salesEnd >= p.startsAt || p.checkInOpensAt > p.startsAt || p.startsAt <= block.timestamp) {
            revert InvalidEventParams();
        }
        if (p.admins.length < 1 || p.admins.length > 3 || p.guards.length < 5 || p.guards.length > 25) {
            revert InvalidRoles();
        }
        eventId = nextEventId++;
        _events[eventId] = EventInfo({
            boss: p.boss,
            price: p.price,
            escrow: 0,
            capacity: p.capacity,
            sold: 0,
            feeBps: p.feeBps,
            salesEnd: p.salesEnd,
            checkInOpensAt: p.checkInOpensAt,
            startsAt: p.startsAt,
            refundWindowUntil: 0,
            status: EventStatus.Open,
            withdrawn: false,
            name: p.name,
            imageUrl: p.imageUrl,
            metadataURI: p.metadataURI
        });
        for (uint256 i = 0; i < p.admins.length; i++) {
            _assignRole(eventId, p.admins[i], ROLE_ADMIN, p.boss);
            _admins[eventId].push(p.admins[i]);
        }
        for (uint256 i = 0; i < p.guards.length; i++) {
            _assignRole(eventId, p.guards[i], ROLE_GUARD, p.boss);
            _guards[eventId].push(p.guards[i]);
        }
        emit EventCreated(eventId, p.boss, p.price, p.capacity, p.startsAt, p.feeBps);
    }

    function _assignRole(uint256 eventId, address account, uint8 role, address boss) private {
        if (account == address(0) || account == boss) revert InvalidRoles();
        if (_roles[eventId][account] != 0) revert DuplicateRole(account);
        _roles[eventId][account] = role;
    }

    /// @notice Shift an event's schedule (postponement). Same event, same tickets. Opens a
    ///         7-day voluntary refund window for buyers when tickets have been sold.
    function updateEventTimes(uint256 eventId, uint64 salesEnd, uint64 checkInOpensAt, uint64 startsAt)
        external
        onlyOwner
    {
        EventInfo storage ev = _eventOrRevert(eventId);
        if (ev.status != EventStatus.Open) revert EventNotOpen(eventId);
        if (block.timestamp >= ev.startsAt) revert TooLateToEdit(eventId);
        if (salesEnd >= startsAt || checkInOpensAt > startsAt || startsAt <= block.timestamp) {
            revert InvalidEventParams();
        }
        ev.salesEnd = salesEnd;
        ev.checkInOpensAt = checkInOpensAt;
        ev.startsAt = startsAt;
        if (ev.sold > 0) {
            ev.refundWindowUntil = uint64(block.timestamp) + uint64(RESCHEDULE_REFUND_WINDOW);
        }
        emit EventRescheduled(eventId, salesEnd, checkInOpensAt, startsAt);
    }

    /// @notice Update display metadata only (name, image, off-chain metadata document).
    function updateEventMetadata(
        uint256 eventId,
        string calldata name,
        string calldata imageUrl,
        string calldata metadataURI
    ) external onlyOwner {
        EventInfo storage ev = _eventOrRevert(eventId);
        if (ev.status == EventStatus.Completed) revert TooLateToEdit(eventId);
        ev.name = name;
        ev.imageUrl = imageUrl;
        ev.metadataURI = metadataURI;
        emit EventMetadataUpdated(eventId);
    }

    /// @notice Cancel an event (organizer's off-chain decision, relayed by the platform owner).
    function cancelEvent(uint256 eventId) external onlyOwner {
        EventInfo storage ev = _eventOrRevert(eventId);
        if (ev.status == EventStatus.Cancelled) revert EventIsCancelled(eventId);
        if (ev.withdrawn) revert AlreadyWithdrawn(eventId);
        if (block.timestamp >= ev.startsAt) revert TooEarlyToCancel();
        ev.status = EventStatus.Cancelled;
        emit EventCancelled(eventId);
    }

    /// @notice Settle a completed event: escrow splits between the boss and the fee recipient.
    function withdraw(uint256 eventId) external onlyOwner nonReentrant {
        EventInfo storage ev = _eventOrRevert(eventId);
        if (ev.status == EventStatus.Cancelled) revert EventIsCancelled(eventId);
        if (ev.withdrawn) revert AlreadyWithdrawn(eventId);
        if (block.timestamp < uint256(ev.startsAt) + WITHDRAW_DELAY) revert TooEarlyToWithdraw();
        uint256 amount = ev.escrow;
        uint256 fee = (amount * ev.feeBps) / 10_000;
        uint256 toBoss = amount - fee;
        ev.escrow = 0;
        ev.withdrawn = true;
        ev.status = EventStatus.Completed;
        emit Withdrawn(eventId, ev.boss, toBoss, fee);
        if (toBoss > 0) token.safeTransfer(ev.boss, toBoss);
        if (fee > 0) token.safeTransfer(feeRecipient, fee);
    }

    // ── Buyers ────────────────────────────────────────────────────────────────

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
    ///      cannot replay it for another event or a second ticket, nor alter the amount
    ///      (always the event's immutable price) or the recipient (always this contract).
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

    /// @notice Claim a full refund: cancelled event, or inside the post-reschedule window.
    /// @dev Always pays the *current* owner, so refunds follow resale automatically. Burns the ticket.
    function claimRefund(uint256 tokenId) external nonReentrant {
        TicketInfo storage t = _tickets[tokenId];
        if (t.eventId == 0) revert EventNotFound(0);
        address owner = ownerOf(tokenId);
        if (msg.sender != owner) revert NotTicketOwner(tokenId);
        EventInfo storage ev = _events[t.eventId];
        if (ev.withdrawn) revert AlreadyWithdrawn(t.eventId);
        bool refundable = ev.status == EventStatus.Cancelled
            || (ev.refundWindowUntil != 0 && block.timestamp <= ev.refundWindowUntil);
        if (!refundable) revert NotRefundable(tokenId);
        if (t.refunded) revert AlreadyRefunded(tokenId);
        if (t.checkedIn) revert TicketLocked(tokenId);
        uint256 amount = ev.price;
        t.refunded = true;
        ev.escrow -= amount;
        _burn(tokenId);
        emit RefundClaimed(tokenId, owner, amount);
        token.safeTransfer(owner, amount);
    }

    // ── Check-in (staff, relayable) ──────────────────────────────────────────

    /// @notice The canonical message a ticket owner signs for check-in.
    function checkInMessage(uint256 tokenId, uint256 expiry) public pure returns (string memory) {
        return string(
            abi.encodePacked("TIMO check-in\nToken: ", Strings.toString(tokenId), "\nExpires: ", Strings.toString(expiry))
        );
    }

    /// @notice The canonical message a staff member signs to authorize a relayed check-in.
    function staffCheckInMessage(uint256 tokenId, uint256 expiry) public pure returns (string memory) {
        return string(
            abi.encodePacked(
                "TIMO staff check-in\nToken: ", Strings.toString(tokenId), "\nExpires: ", Strings.toString(expiry)
            )
        );
    }

    /// @notice Check in a ticket. Caller must be staff (admin/guard) of the ticket's event and
    ///         must present the ticket owner's fresh signature.
    function checkIn(uint256 tokenId, uint256 expiry, bytes calldata ownerSignature) external {
        _checkIn(tokenId, expiry, ownerSignature, msg.sender);
    }

    /// @notice Relayed check-in: anyone (the platform relayer) submits; both the ticket owner's
    ///         and the staff member's fresh signatures are verified on-chain.
    function checkInRelayed(
        uint256 tokenId,
        uint256 expiry,
        bytes calldata ownerSignature,
        bytes calldata staffSignature
    ) external {
        address staff = ECDSA.recover(
            MessageHashUtils.toEthSignedMessageHash(bytes(staffCheckInMessage(tokenId, expiry))), staffSignature
        );
        _checkIn(tokenId, expiry, ownerSignature, staff);
    }

    function _checkIn(uint256 tokenId, uint256 expiry, bytes calldata ownerSignature, address staff) private {
        TicketInfo storage t = _tickets[tokenId];
        if (t.eventId == 0) revert EventNotFound(0);
        EventInfo storage ev = _events[t.eventId];
        if (expiry <= block.timestamp || expiry > block.timestamp + SIG_TTL) revert SignatureStale();
        if (_roles[t.eventId][staff] == 0) revert NotStaff(t.eventId, staff);
        address owner = ownerOf(tokenId);
        address signer = ECDSA.recover(
            MessageHashUtils.toEthSignedMessageHash(bytes(checkInMessage(tokenId, expiry))), ownerSignature
        );
        if (signer != owner) revert BadOwnerSignature(tokenId);
        if (ev.status == EventStatus.Cancelled) revert EventIsCancelled(t.eventId);
        if (block.timestamp < ev.checkInOpensAt) revert CheckInTooEarly(tokenId);
        if (t.checkedIn) revert AlreadyCheckedIn(tokenId);
        t.checkedIn = true;
        emit CheckedIn(tokenId, staff);
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

    /// @notice 0 = no role, 1 = admin, 2 = guard, for `account` at `eventId`.
    function roleOf(uint256 eventId, address account) external view returns (uint8) {
        return _roles[eventId][account];
    }

    function eventRoles(uint256 eventId)
        external
        view
        returns (address boss, address[] memory admins, address[] memory guards)
    {
        return (_events[eventId].boss, _admins[eventId], _guards[eventId]);
    }

    /// @notice ERC-721 metadata, generated on-chain: the ticket always reflects the event's
    ///         current data (including a rescheduled date) and the ticket's live status.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        TicketInfo storage t = _tickets[tokenId];
        EventInfo storage ev = _events[t.eventId];
        string memory status;
        if (t.refunded) status = "Refunded";
        else if (t.checkedIn) status = "Checked In";
        else if (ev.status == EventStatus.Cancelled) status = "Event Cancelled";
        else status = "Active";
        string memory json = string(
            abi.encodePacked(
                '{"name":"TIMO Ticket - ',
                ev.name,
                '","description":"Official TIMO event ticket (ERC-721). Present the dynamic QR in My Tickets for check-in.",',
                '"image":"',
                ev.imageUrl,
                '","attributes":[',
                '{"trait_type":"Event","value":"',
                ev.name,
                '"},',
                '{"trait_type":"Event ID","value":',
                Strings.toString(t.eventId),
                "},",
                '{"trait_type":"Starts At (unix)","value":',
                Strings.toString(ev.startsAt),
                "},",
                '{"trait_type":"Status","value":"',
                status,
                '"}]}'
            )
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    // ── Internals ────────────────────────────────────────────────────────────

    function _eventOrRevert(uint256 eventId) private view returns (EventInfo storage) {
        EventInfo storage ev = _events[eventId];
        if (ev.boss == address(0)) revert EventNotFound(eventId);
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
