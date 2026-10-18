// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// NOTE: Real deployments MUST use Arc's USDC at 0x3600000000000000000000000000000000000000.
// The constructor verifies the token is a contract with decimals()==6. That check is a
// correctness guard, NOT an authentication of USDC identity. Deployment-time verification
// that the address is the canonical USDC contract is a separate integration responsibility.

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ReflowPools M1
/// @notice Settlement contract for shared purchases. Later buyers reimburse earlier ones
///         via a rebate credit system so that all members converge to the same net cost.
///
/// Equal-share formula (unchanged): floor(C/n) + (i < C%n ? 1 : 0)
/// Invariant: sum_{i=0}^{n-1} share(C,n,i) == C  for all valid C, n.
/// Conservation: sum of credits issued to existing members on each join == new member payment.
///
/// Scope: V1 trusts a configured standard six-decimal USDC token.
///        No fees, no upgrades, no admin sweep.
contract ReflowPools is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Data structures
    // -------------------------------------------------------------------------

    struct Pool {
        address provider;
        uint256 price;
        bytes32 artifactHash;
        bytes32 termsHash;
        uint64  deadline;
        uint8   cap;
        uint8   count;
        bool    exists;
    }

    struct Member {
        uint256 joinOrder;
        uint256 grossPaid;
        uint256 rebatesAllocated;
        uint256 rebatesClaimed;
        bool    isMember;
    }

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error PoolDoesNotExist();
    error DeadlinePassed();
    error CapReached();
    error AlreadyMember();
    error ProviderCannotParticipate();
    error ZeroParticipant();
    error SelfParticipant();
    error CountMismatch(uint256 expected, uint256 actual);
    error ContributionTooHigh(uint256 required, uint256 max);
    error NotAMember();
    error NothingToClaim();
    error FirstPurchaseRequired();
    error MembersAlreadyExist();
    error InvalidPrice();
    error InvalidHash();
    error InvalidDeadline();
    error InvalidCap();
    error PriceTooLow();
    error ZeroAddress();
    /// @notice Constructor: token address is not a deployed contract.
    error TokenNotContract();
    /// @notice Constructor: token does not implement IERC20Metadata.decimals().
    error TokenMissingDecimalsInterface();
    /// @notice Constructor: token decimals() != 6.
    error TokenDecimalsNot6(uint8 actual);

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event PoolCreated(
        uint256 indexed poolId,
        address indexed provider,
        uint256 price,
        bytes32 artifactHash,
        bytes32 termsHash,
        uint64  deadline,
        uint8   cap
    );
    event FirstPurchased(uint256 indexed poolId, address indexed buyer,       uint256 amount);
    event Joined(        uint256 indexed poolId, address indexed participant,  uint256 joinOrder,  uint256 contribution);
    event RebateCredited(uint256 indexed poolId, address indexed participant,  uint256 amount);
    event RebateClaimed( uint256 indexed poolId, address indexed beneficiary, uint256 amount);

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    address public immutable usdc;

    mapping(uint256 => Pool)                            public pools;
    mapping(uint256 => mapping(address => Member))      public members;
    /// @notice Unclaimed rebates owed within a pool.
    mapping(uint256 => uint256)                         public poolLiability;
    /// @notice Global sum of all unclaimed rebates across every pool.
    uint256                                             public totalLiability;

    mapping(uint256 => mapping(uint256 => address)) internal _memberByOrder;

    uint256 public nextPoolId;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param usdcToken Address of the six-decimal ERC-20 token used as currency.
    ///        Must be a deployed contract implementing IERC20Metadata with decimals()==6.
    constructor(address usdcToken) {
        if (usdcToken == address(0)) revert ZeroAddress();

        // Reject EOAs and non-contract addresses.
        uint256 codeSize;
        assembly { codeSize := extcodesize(usdcToken) }
        if (codeSize == 0) revert TokenNotContract();

        // Require IERC20Metadata.decimals() to exist and return 6.
        // An explicit try/catch surfaces a missing/reverting interface as a distinct error.
        uint8 dec;
        try IERC20Metadata(usdcToken).decimals() returns (uint8 d) {
            dec = d;
        } catch {
            revert TokenMissingDecimalsInterface();
        }
        if (dec != 6) revert TokenDecimalsNot6(dec);

        usdc      = usdcToken;
        nextPoolId = 1;
    }

    // -------------------------------------------------------------------------
    // Pool lifecycle
    // -------------------------------------------------------------------------

    function createPool(
        uint256 price,
        bytes32 artifactHash,
        bytes32 termsHash,
        uint64  deadline,
        uint8   cap
    ) external returns (uint256 poolId) {
        if (price == 0)                                          revert InvalidPrice();
        if (artifactHash == bytes32(0) || termsHash == bytes32(0)) revert InvalidHash();
        if (deadline <= block.timestamp)                         revert InvalidDeadline();
        if (cap < 2 || cap > 16)                                 revert InvalidCap();
        if (price < uint256(cap))                                revert PriceTooLow();

        poolId = nextPoolId;
        nextPoolId = poolId + 1;

        pools[poolId] = Pool({
            provider:     msg.sender,
            price:        price,
            artifactHash: artifactHash,
            termsHash:    termsHash,
            deadline:     deadline,
            cap:          cap,
            count:        0,
            exists:       true
        });

        emit PoolCreated(poolId, msg.sender, price, artifactHash, termsHash, deadline, cap);
    }

    // -------------------------------------------------------------------------
    // purchaseFirst — CEI + nonReentrant (fix #1)
    // -------------------------------------------------------------------------

    /// @notice First participant pays the full price C directly to the provider.
    ///         Uses checks-effects-interactions: membership is recorded before the
    ///         external token call so a reentrant callback cannot bypass the guard.
    function purchaseFirst(uint256 poolId, uint256 maxAmount) external nonReentrant {
        Pool storage pool_ = pools[poolId];

        // --- Checks ---
        if (!pool_.exists)                     revert PoolDoesNotExist();
        if (block.timestamp >= pool_.deadline) revert DeadlinePassed();
        if (pool_.count != 0)                  revert MembersAlreadyExist();
        if (msg.sender == pool_.provider)      revert ProviderCannotParticipate();
        if (members[poolId][msg.sender].isMember) revert AlreadyMember();

        uint256 payment = pool_.price;
        if (payment > maxAmount) revert ContributionTooHigh(payment, maxAmount);

        // --- Effects (before external call) ---
        members[poolId][msg.sender] = Member({
            joinOrder:         0,
            grossPaid:         payment,
            rebatesAllocated:  0,
            rebatesClaimed:    0,
            isMember:          true
        });
        _memberByOrder[poolId][0] = msg.sender;
        pool_.count = 1;

        // --- Interaction ---
        // Reverts on failure; EVM unwinds all effects above automatically.
        IERC20(usdc).safeTransferFrom(msg.sender, pool_.provider, payment);

        emit FirstPurchased(poolId, msg.sender, payment);
    }

    // -------------------------------------------------------------------------
    // quoteJoin — full eligibility enforcement (fix #3)
    // -------------------------------------------------------------------------

    /// @notice Returns the contribution required for `participant` to join `poolId`
    ///         at the current membership count, and the resulting expectedCount to
    ///         pass to join(). Returns values that join() will accept without rejection.
    ///
    /// @param poolId      Pool to query.
    /// @param participant Address that would call join().
    /// @return contribution  Amount the participant must pay.
    /// @return expectedCount The count value to supply as join()'s expectedCount arg
    ///                       (equal to the current count; join increments to count+1).
    function quoteJoin(uint256 poolId, address participant)
        external
        view
        returns (uint256 contribution, uint256 expectedCount)
    {
        Pool storage pool_ = pools[poolId];

        // Enforce the same eligibility checks as join() so the quote is actionable.
        if (!pool_.exists)                                   revert PoolDoesNotExist();
        if (block.timestamp >= pool_.deadline)               revert DeadlinePassed();
        if (participant == address(0))                       revert ZeroParticipant();
        if (participant == address(this))                    revert SelfParticipant();
        if (participant == pool_.provider)                   revert ProviderCannotParticipate();
        if (members[poolId][participant].isMember)           revert AlreadyMember();

        uint256 currentCount = uint256(pool_.count);
        if (currentCount == 0)                               revert FirstPurchaseRequired();
        if (currentCount >= uint256(pool_.cap))              revert CapReached();

        // expectedCount is the current count; join() checks currentCount == expectedCount.
        expectedCount = currentCount;
        contribution  = shareOf(pool_.price, currentCount + 1, currentCount);
    }

    // -------------------------------------------------------------------------
    // join — CEI (fix #1, existing nonReentrant retained)
    // -------------------------------------------------------------------------

    function join(uint256 poolId, uint256 expectedCount, uint256 maxContribution) external nonReentrant {
        Pool storage pool_ = pools[poolId];

        // --- Checks ---
        if (!pool_.exists)                     revert PoolDoesNotExist();
        if (block.timestamp >= pool_.deadline) revert DeadlinePassed();

        uint256 currentCount = uint256(pool_.count);
        if (currentCount == 0)                 revert FirstPurchaseRequired();
        if (currentCount >= uint256(pool_.cap)) revert CapReached();
        if (msg.sender == pool_.provider)      revert ProviderCannotParticipate();
        if (members[poolId][msg.sender].isMember) revert AlreadyMember();
        if (currentCount != expectedCount)     revert CountMismatch(expectedCount, currentCount);

        uint256 newCount = currentCount + 1;
        uint256 newShare = shareOf(pool_.price, newCount, currentCount);
        if (newShare > maxContribution)        revert ContributionTooHigh(newShare, maxContribution);

        // --- Effects (before external call) ---
        // Record membership and distribute rebate credits before pulling tokens.
        // This ensures any reentrant call sees the updated state and is rejected.
        _distributeCredits(poolId, pool_.price, currentCount, newCount, newShare);

        members[poolId][msg.sender] = Member({
            joinOrder:        currentCount,
            grossPaid:        newShare,
            rebatesAllocated: 0,
            rebatesClaimed:   0,
            isMember:         true
        });
        _memberByOrder[poolId][currentCount] = msg.sender;
        pool_.count = uint8(newCount);

        // --- Interaction ---
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), newShare);

        emit Joined(poolId, msg.sender, currentCount, newShare);
    }

    // -------------------------------------------------------------------------
    // Internal: credit distribution with global liability tracking (fix #4)
    // -------------------------------------------------------------------------

    /// @dev Credits existing members their rebate share when participant count grows
    ///      from `oldCount` to `newCount`. Maintains both poolLiability and totalLiability.
    ///      Conservation invariant: totalCredits == newShare (asserted).
    function _distributeCredits(
        uint256 poolId,
        uint256 price,
        uint256 oldCount,
        uint256 newCount,
        uint256 newShare
    ) internal {
        uint256 totalCredits;
        for (uint256 i = 0; i < oldCount; i++) {
            address memberAddr = _memberByOrder[poolId][i];
            assert(memberAddr != address(0));
            uint256 credit = shareOf(price, oldCount, i) - shareOf(price, newCount, i);
            members[poolId][memberAddr].rebatesAllocated += credit;
            poolLiability[poolId] += credit;
            totalLiability        += credit;          // global tracking
            totalCredits          += credit;
            emit RebateCredited(poolId, memberAddr, credit);
        }
        assert(totalCredits == newShare);
    }

    // -------------------------------------------------------------------------
    // claimFor — CEI (existing nonReentrant + global liability update, fix #4)
    // -------------------------------------------------------------------------

    function claimFor(uint256 poolId, address beneficiary) external nonReentrant {
        Pool storage pool_ = pools[poolId];
        if (!pool_.exists) revert PoolDoesNotExist();

        Member storage member = members[poolId][beneficiary];
        if (!member.isMember) revert NotAMember();

        uint256 claimable = member.rebatesAllocated - member.rebatesClaimed;
        if (claimable == 0) revert NothingToClaim();

        // Effects before interaction.
        member.rebatesClaimed    += claimable;
        poolLiability[poolId]    -= claimable;
        totalLiability           -= claimable;         // global tracking

        // Interaction.
        IERC20(usdc).safeTransfer(beneficiary, claimable);

        emit RebateClaimed(poolId, beneficiary, claimable);
    }

    // -------------------------------------------------------------------------
    // View helpers
    // -------------------------------------------------------------------------

    function getPool(uint256 poolId) external view returns (Pool memory) {
        return pools[poolId];
    }

    function getMember(uint256 poolId, address participant) external view returns (Member memory) {
        return members[poolId][participant];
    }

    function outstandingCredit(uint256 poolId, address participant) external view returns (uint256) {
        Member storage member = members[poolId][participant];
        return member.rebatesAllocated - member.rebatesClaimed;
    }

    // -------------------------------------------------------------------------
    // Pure math — equal-share formula (unchanged)
    // -------------------------------------------------------------------------

    /// @notice Share of participant i when there are n members and the total price is C.
    ///         Formula: floor(C/n) + (i < C%n ? 1 : 0)
    ///         Invariant: sum_{i=0}^{n-1} shareOf(C,n,i) == C
    function shareOf(uint256 C, uint256 n, uint256 i) public pure returns (uint256) {
        uint256 q = C / n;
        uint256 r = C % n;
        return i < r ? q + 1 : q;
    }
}
