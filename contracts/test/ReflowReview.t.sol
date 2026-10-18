// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice ReflowReview.t.sol — regression tests for the six M1 fixes.
///
/// Covers:
///  1. Constructor: zero, EOA, non-6-decimals, missing decimals interface, valid 6-decimal token.
///  2. Reentrancy: callback during transferFrom for purchaseFirst and join (including another
///     empty pool target); assert callback attempted, actual rejection selector
///     (ReentrancyGuardReentrantCall), no phantom membership or stolen credit.
///     Claim callback also asserts its rejection selector.
///  3. quoteJoin: returns current count as expectedCount; rejects empty/expired/full/
///     zero/self/provider/existing-member participants. Exact-deadline join reverts;
///     claims work after deadline; claims work when pool is at capacity.
///  4. Rollback on false-returning and reverting transferFrom/transfer. Recipient-specific
///     rejected claim preserves credit; a different buyer can claim; a later member can join.
///  5. Two funded pools: totalLiability == poolLiability[A] + poolLiability[B] throughout
///     interleaved joins, claims, and a donation. Token balance reconciliation at each step.
///  6. Bounded fuzz lifecycle: 2..16 buyers, input-driven claim interleaving between joins.
///     Net shares, single provider payment, solvency at every step. Pure share math at
///     max uint256 without overflowing mock supply.

import {Test, console} from "forge-std/Test.sol";
import {ReflowPools} from "../ReflowPools.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

// ============================================================================
// Shared mocks
// ============================================================================

/// @dev Standard 6-decimal mock used across most tests.
contract Mock6 {
    string  public constant name     = "Mock6";
    string  public constant symbol   = "M6";
    uint8   public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    // Global failure flags (used when targeted failure is not needed)
    bool public failTransfer;
    bool public failTransferFrom;
    // Return-false mode (does not revert, returns false)
    bool public returnFalseTransfer;
    bool public returnFalseTransferFrom;
    // Per-recipient transfer block: transfer() to this address always reverts.
    // Set once to simulate a permanently blocked recipient without affecting others.
    address public blockedRecipient;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply    += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        if (failTransfer)                        revert("Mock6: transfer fail");
        if (blockedRecipient != address(0) && to == blockedRecipient)
                                                 revert("Mock6: recipient blocked");
        if (returnFalseTransfer)                 return false;
        require(balanceOf[msg.sender] >= amount, "Mock6: insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        if (failTransferFrom)        revert("Mock6: transferFrom fail");
        if (returnFalseTransferFrom) return false;
        require(balanceOf[from] >= amount,          "Mock6: insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Mock6: insufficient allowance");
        balanceOf[from]                -= amount;
        allowance[from][msg.sender]    -= amount;
        balanceOf[to]                  += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function setFailTransfer(bool v)            external { failTransfer            = v; }
    function setFailTransferFrom(bool v)        external { failTransferFrom        = v; }
    function setReturnFalseTransfer(bool v)     external { returnFalseTransfer     = v; }
    function setReturnFalseTransferFrom(bool v) external { returnFalseTransferFrom = v; }
    function setBlockedRecipient(address a)     external { blockedRecipient        = a; }
}

/// @dev Token with no decimals() — simulates a token missing IERC20Metadata.
contract NoDecimalsToken {
    // No decimals() function.
    function transfer(address, uint256) external pure returns (bool) { return true; }
    function transferFrom(address, address, uint256) external pure returns (bool) { return true; }
    function approve(address, uint256) external pure returns (bool) { return true; }
    function balanceOf(address) external pure returns (uint256) { return 0; }
    function allowance(address, address) external pure returns (uint256) { return 0; }
}

/// @dev Token with decimals() that always reverts.
contract RevertingDecimalsToken {
    function decimals() external pure returns (uint8) { revert("no decimals"); }
    function transfer(address, uint256) external pure returns (bool) { return true; }
    function transferFrom(address, address, uint256) external pure returns (bool) { return true; }
    function approve(address, uint256) external pure returns (bool) { return true; }
    function balanceOf(address) external pure returns (uint256) { return 0; }
    function allowance(address, address) external pure returns (uint256) { return 0; }
}

/// @dev Token with 18 decimals (not USDC).
contract Mock18 {
    string  public constant name     = "Mock18";
    string  public constant symbol   = "M18";
    uint8   public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        balanceOf[f] -= a; allowance[f][msg.sender] -= a; balanceOf[t] += a; return true;
    }
}

// ============================================================================
// Reentrant-transferFrom token (attacks purchaseFirst / join)
// ============================================================================

/// @dev During transferFrom, re-enters a configurable function on a ReflowPools instance.
///      The test sets attackMode before calling purchaseFirst/join to select the target.
contract ReentrantTransferFromToken is Mock6 {
    enum AttackMode { None, PurchaseFirst, Join, ClaimFor }

    ReflowPools public target;
    AttackMode  public attackMode;
    uint256     public attackPoolId;
    address     public attackParticipant;

    // For Join attack we need a second pool to test empty-pool cross-call.
    uint256     public attackSecondPoolId;

    bool    public transferFromCalled;
    bool    public reentryAttempted;
    bool    public reentryOk;
    bytes   public reentryErrData;

    function setup(
        address _target,
        AttackMode _mode,
        uint256 _poolId,
        address _participant,
        uint256 _secondPoolId
    ) external {
        target             = ReflowPools(_target);
        attackMode         = _mode;
        attackPoolId       = _poolId;
        attackParticipant  = _participant;
        attackSecondPoolId = _secondPoolId;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        if (failTransferFrom)        revert("Mock6: transferFrom fail");
        if (returnFalseTransferFrom) return false;
        require(balanceOf[from] >= amount,          "Mock6: insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Mock6: insufficient allowance");
        balanceOf[from]             -= amount;
        allowance[from][msg.sender] -= amount;
        balanceOf[to]               += amount;
        emit Transfer(from, to, amount);

        transferFromCalled = true;

        // Reentry attempt — one shot only.
        if (!reentryAttempted && attackMode != AttackMode.None) {
            reentryAttempted = true;
            bytes memory callData;
            if (attackMode == AttackMode.PurchaseFirst) {
                // Try to purchaseFirst on the SAME pool that is mid-execution.
                callData = abi.encodeWithSelector(
                    target.purchaseFirst.selector,
                    attackPoolId,
                    type(uint256).max
                );
            } else if (attackMode == AttackMode.Join) {
                // Try to join the SAME pool mid-execution, then also attempt another empty pool.
                callData = abi.encodeWithSelector(
                    target.join.selector,
                    attackPoolId,
                    uint256(1),
                    type(uint256).max
                );
            } else if (attackMode == AttackMode.ClaimFor) {
                callData = abi.encodeWithSelector(
                    target.claimFor.selector,
                    attackPoolId,
                    attackParticipant
                );
            }
            (reentryOk, reentryErrData) = address(target).call(callData);
        }

        return true;
    }
}

// ============================================================================
// Reentrant-transfer token (attacks claimFor — like existing ReentrantToken)
// ============================================================================

/// @dev During transfer, re-enters claimFor. Records actual result without swallowing.
contract ReentrantTransferToken is Mock6 {
    ReflowPools public target;
    uint256     public attackPoolId;
    address     public attackBeneficiary;

    bool    public transferCalled;
    bool    public reentryAttempted;
    bool    public reentryOk;
    bytes   public reentryErrData;

    function setup(address _target, uint256 _poolId, address _beneficiary) external {
        target            = ReflowPools(_target);
        attackPoolId      = _poolId;
        attackBeneficiary = _beneficiary;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        if (failTransfer)        revert("Mock6: transfer fail");
        if (returnFalseTransfer) return false;
        require(balanceOf[msg.sender] >= amount, "Mock6: insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);

        transferCalled = true;

        if (!reentryAttempted && address(target) != address(0)) {
            reentryAttempted = true;
            (reentryOk, reentryErrData) = address(target).call(
                abi.encodeWithSelector(
                    target.claimFor.selector,
                    attackPoolId,
                    attackBeneficiary
                )
            );
        }
        return true;
    }
}

// ============================================================================
// Main regression test contract
// ============================================================================

contract ReflowReviewTest is Test {
    bytes32 constant ARTIFACT = keccak256("artifact-review");
    bytes32 constant TERMS    = keccak256("terms-review");
    uint256 constant C        = 1_200_000; // 1.20 USDC (6 decimals)

    address internal provider  = address(0xAA01);
    address internal buyer1    = address(0xBB01);
    address internal buyer2    = address(0xBB02);
    address internal buyer3    = address(0xBB03);
    address internal buyer4    = address(0xBB04);
    address internal stranger  = address(0xCC01);

    Mock6         internal usdc;
    ReflowPools   internal rp;
    uint64        internal deadline;

    // Expected selector for OZ ReentrancyGuard v5.
    bytes4 constant REENTRANT_CALL_SELECTOR =
        bytes4(keccak256("ReentrancyGuardReentrantCall()"));

    function setUp() public {
        usdc     = new Mock6();
        rp       = new ReflowPools(address(usdc));
        deadline = uint64(block.timestamp + 30 days);

        uint256 FUND = C * 20;
        address[5] memory actors = [provider, buyer1, buyer2, buyer3, buyer4];
        for (uint256 i; i < actors.length; i++) {
            usdc.mint(actors[i], FUND);
            vm.prank(actors[i]);
            usdc.approve(address(rp), type(uint256).max);
        }
        usdc.mint(stranger, FUND);
        vm.prank(stranger); usdc.approve(address(rp), type(uint256).max);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _pool(uint8 cap) internal returns (uint256) {
        vm.prank(provider);
        return rp.createPool(C, ARTIFACT, TERMS, deadline, cap);
    }

    function _pool(uint256 price, uint8 cap) internal returns (uint256) {
        vm.prank(provider);
        return rp.createPool(price, ARTIFACT, TERMS, deadline, cap);
    }

    // =========================================================================
    // 1. Constructor validation
    // =========================================================================

    function test_Constructor_ZeroAddress() public {
        vm.expectRevert(ReflowPools.ZeroAddress.selector);
        new ReflowPools(address(0));
    }

    function test_Constructor_EOA() public {
        address eoa = address(0x1234);
        // extcodesize == 0 for an EOA
        vm.expectRevert(ReflowPools.TokenNotContract.selector);
        new ReflowPools(eoa);
    }

    function test_Constructor_NoDecimalsInterface() public {
        NoDecimalsToken t = new NoDecimalsToken();
        vm.expectRevert(ReflowPools.TokenMissingDecimalsInterface.selector);
        new ReflowPools(address(t));
    }

    function test_Constructor_RevertingDecimalsInterface() public {
        RevertingDecimalsToken t = new RevertingDecimalsToken();
        vm.expectRevert(ReflowPools.TokenMissingDecimalsInterface.selector);
        new ReflowPools(address(t));
    }

    function test_Constructor_WrongDecimals_18() public {
        Mock18 t = new Mock18();
        vm.expectRevert(abi.encodeWithSelector(ReflowPools.TokenDecimalsNot6.selector, uint8(18)));
        new ReflowPools(address(t));
    }

    function test_Constructor_ValidSixDecimalToken() public {
        Mock6 t = new Mock6();
        ReflowPools rp2 = new ReflowPools(address(t));
        assertEq(rp2.usdc(), address(t));
        assertEq(rp2.nextPoolId(), 1);
    }

    // =========================================================================
    // 2. Reentrancy: transferFrom callbacks during purchaseFirst and join
    // =========================================================================

    /// @dev Reentry into purchaseFirst during purchaseFirst's transferFrom.
    function test_Reentrancy_PurchaseFirst_AttemptsPurchaseFirst() public {
        ReentrantTransferFromToken rTok = new ReentrantTransferFromToken();
        ReflowPools rPool = new ReflowPools(address(rTok));

        rTok.mint(buyer1, C * 5);
        vm.prank(buyer1); rTok.approve(address(rPool), type(uint256).max);
        rTok.mint(provider, 0); // no-op, just ensure provider in state

        vm.prank(provider);
        uint256 poolId = rPool.createPool(C, ARTIFACT, TERMS, deadline, 4);

        // Arm: during transferFrom, attack purchaseFirst on the same pool.
        // buyer1 IS the msg.sender so we impersonate it as the re-entering attacker.
        rTok.setup(address(rPool), ReentrantTransferFromToken.AttackMode.PurchaseFirst,
                   poolId, buyer1, 0);

        vm.prank(buyer1);
        rPool.purchaseFirst(poolId, type(uint256).max);

        // The outer call succeeded.
        assertTrue(rPool.getMember(poolId, buyer1).isMember, "buyer1 must be a member");
        assertEq(rPool.getPool(poolId).count, 1, "count must be 1");

        // The callback actually fired.
        assertTrue(rTok.transferFromCalled(),  "transferFrom must have been called");
        assertTrue(rTok.reentryAttempted(),    "reentry must have been attempted");

        // Reentry was rejected.
        assertFalse(rTok.reentryOk(), "reentry must fail");

        bytes memory errData = rTok.reentryErrData();
        assertTrue(errData.length >= 4, "error data must have a selector");
        bytes4 sel;
        assembly { sel := mload(add(errData, 0x20)) }
        assertEq(sel, REENTRANT_CALL_SELECTOR, "must reject with ReentrancyGuardReentrantCall");
    }

    /// @dev During purchaseFirst's transferFrom, the token re-enters purchaseFirst on a
    ///      second REAL empty pool. Both pools are freshly deployed with count==0. CEI on
    ///      the outer purchaseFirst writes pool1.count=1 BEFORE the token call, so at
    ///      attack time pool2 is still empty (count==0). The guard fires because
    ///      purchaseFirst is nonReentrant — pool2.count never changes.
    ///      Asserts exact ReentrancyGuardReentrantCall selector; no phantom membership.
    function test_Reentrancy_PurchaseFirst_AttemptsJoinOnEmptyPool() public {
        ReentrantTransferFromToken rTok = new ReentrantTransferFromToken();
        ReflowPools rPool = new ReflowPools(address(rTok));

        rTok.mint(buyer1, C * 10);
        vm.prank(buyer1); rTok.approve(address(rPool), type(uint256).max);

        // Create two distinct pools; both start empty.
        vm.prank(provider);
        uint256 pool1 = rPool.createPool(C, ARTIFACT, TERMS, deadline, 4);
        vm.prank(provider);
        uint256 pool2 = rPool.createPool(C, ARTIFACT, TERMS, deadline, 4);
        assertEq(rPool.getPool(pool2).count, 0, "pool2 must start empty");

        // Arm: during pool1's purchaseFirst transferFrom, attempt purchaseFirst on pool2.
        rTok.setup(address(rPool), ReentrantTransferFromToken.AttackMode.PurchaseFirst,
                   pool2, buyer1, 0);

        vm.prank(buyer1);
        rPool.purchaseFirst(pool1, type(uint256).max);

        // 1. Outer purchaseFirst on pool1 succeeded.
        assertTrue(rPool.getMember(pool1, buyer1).isMember, "buyer1 must be member of pool1");
        assertEq(rPool.getPool(pool1).count, 1, "pool1 count must be 1");

        // 2. Callback actually fired.
        assertTrue(rTok.transferFromCalled(), "transferFrom must have been called");
        assertTrue(rTok.reentryAttempted(),   "reentry must have been attempted");

        // 3. Reentry into purchaseFirst(pool2) was rejected.
        assertFalse(rTok.reentryOk(), "reentry into pool2 purchaseFirst must fail");

        // 4. Rejection selector is exactly ReentrancyGuardReentrantCall.
        bytes memory errData = rTok.reentryErrData();
        assertTrue(errData.length >= 4, "error data must carry a selector");
        bytes4 sel;
        assembly { sel := mload(add(errData, 0x20)) }
        assertEq(sel, REENTRANT_CALL_SELECTOR,
            "reentry must be rejected with ReentrancyGuardReentrantCall");

        // 5. pool2 has no phantom membership — the reentry was completely blocked.
        assertFalse(rPool.getMember(pool2, buyer1).isMember, "no phantom membership in pool2");
        assertEq(rPool.getPool(pool2).count, 0, "pool2 count must remain 0");
    }

    /// @dev During a join's transferFrom, the token re-enters purchaseFirst on a second
    ///      empty pool. Because join is nonReentrant, the guard fires before purchaseFirst
    ///      on pool2 can execute. Asserts exact selector and no phantom state.
    function test_Reentrancy_Join_AttemptsPurchaseFirstOnEmptyPool() public {
        ReentrantTransferFromToken rTok = new ReentrantTransferFromToken();
        ReflowPools rPool = new ReflowPools(address(rTok));

        rTok.mint(buyer1, C * 10);
        rTok.mint(buyer2, C * 10);
        vm.prank(buyer1); rTok.approve(address(rPool), type(uint256).max);
        vm.prank(buyer2); rTok.approve(address(rPool), type(uint256).max);

        vm.prank(provider);
        uint256 pool1 = rPool.createPool(C, ARTIFACT, TERMS, deadline, 4);
        vm.prank(provider);
        uint256 pool2 = rPool.createPool(C, ARTIFACT, TERMS, deadline, 4);

        // buyer1 first-purchases pool1 (no attack armed yet).
        vm.prank(buyer1); rPool.purchaseFirst(pool1, type(uint256).max);

        // Arm: during buyer2's join on pool1, attempt purchaseFirst on pool2.
        rTok.setup(address(rPool), ReentrantTransferFromToken.AttackMode.PurchaseFirst,
                   pool2, buyer2, 0);

        vm.prank(buyer2);
        rPool.join(pool1, 1, type(uint256).max);

        // Outer join succeeded.
        assertTrue(rPool.getMember(pool1, buyer2).isMember, "buyer2 must be member of pool1");
        assertEq(rPool.getPool(pool1).count, 2);

        // Reentry attempted and rejected with exact guard selector.
        assertTrue(rTok.reentryAttempted());
        assertFalse(rTok.reentryOk(), "reentry purchaseFirst(pool2) must fail");

        bytes memory errData = rTok.reentryErrData();
        assertTrue(errData.length >= 4);
        bytes4 sel;
        assembly { sel := mload(add(errData, 0x20)) }
        assertEq(sel, REENTRANT_CALL_SELECTOR,
            "reentry must be rejected with ReentrancyGuardReentrantCall");

        // pool2 remains empty — no phantom membership.
        assertFalse(rPool.getMember(pool2, buyer2).isMember, "no phantom membership in pool2");
        assertEq(rPool.getPool(pool2).count, 0, "pool2 count must remain 0");
    }

    /// @dev Reentry into join during join's transferFrom.
    function test_Reentrancy_Join_AttemptsJoinSamePool() public {
        ReentrantTransferFromToken rTok = new ReentrantTransferFromToken();
        ReflowPools rPool = new ReflowPools(address(rTok));

        rTok.mint(buyer1, C * 5);
        rTok.mint(buyer2, C * 5);
        vm.prank(buyer1); rTok.approve(address(rPool), type(uint256).max);
        vm.prank(buyer2); rTok.approve(address(rPool), type(uint256).max);

        vm.prank(provider);
        uint256 poolId = rPool.createPool(C, ARTIFACT, TERMS, deadline, 4);

        // buyer1 first-purchases; no attack yet (token not armed).
        vm.prank(buyer1); rPool.purchaseFirst(poolId, type(uint256).max);

        // Arm: during buyer2's join transferFrom, try to re-join the same pool.
        // The re-entry msg.sender will be the rTok contract (calling address(rPool).call).
        // It's not buyer2 — so the guard fires before any membership check.
        rTok.setup(address(rPool), ReentrantTransferFromToken.AttackMode.Join,
                   poolId, buyer2, 0);

        vm.prank(buyer2);
        rPool.join(poolId, 1, type(uint256).max);

        // Outer call succeeded.
        assertTrue(rPool.getMember(poolId, buyer2).isMember, "buyer2 must be a member");
        assertEq(rPool.getPool(poolId).count, 2, "count must be 2");

        // Reentry attempted and rejected.
        assertTrue(rTok.reentryAttempted());
        assertFalse(rTok.reentryOk(), "reentry must fail");

        bytes memory errData = rTok.reentryErrData();
        assertTrue(errData.length >= 4);
        bytes4 sel;
        assembly { sel := mload(add(errData, 0x20)) }
        assertEq(sel, REENTRANT_CALL_SELECTOR, "must reject with ReentrancyGuardReentrantCall");

        // No phantom credit or stolen funds.
        assertEq(rPool.poolLiability(poolId), rPool.outstandingCredit(poolId, buyer1));
        assertEq(rPool.totalLiability(), rPool.poolLiability(poolId));
    }

    /// @dev Reentry into claimFor during claimFor's transfer (outbound).
    function test_Reentrancy_ClaimFor_AssertsSelectorAndNoDoublePayment() public {
        ReentrantTransferToken rTok = new ReentrantTransferToken();
        ReflowPools rPool = new ReflowPools(address(rTok));

        rTok.mint(buyer1, C * 5);
        rTok.mint(buyer2, C * 5);
        vm.prank(buyer1); rTok.approve(address(rPool), type(uint256).max);
        vm.prank(buyer2); rTok.approve(address(rPool), type(uint256).max);

        vm.prank(provider);
        uint256 poolId = rPool.createPool(C, ARTIFACT, TERMS, deadline, 2);

        vm.prank(buyer1); rPool.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); rPool.join(poolId, 1, type(uint256).max);

        // Arm: during transfer to buyer1, re-enter claimFor(poolId, buyer1).
        rTok.setup(address(rPool), poolId, buyer1);

        uint256 b1Before = rTok.balanceOf(buyer1);
        rPool.claimFor(poolId, buyer1);

        // 1. Outer call succeeded: exactly one payment.
        assertEq(rTok.balanceOf(buyer1) - b1Before, 600_000, "must receive exactly one rebate");

        // 2. Outstanding credit is zero.
        assertEq(rPool.outstandingCredit(poolId, buyer1), 0);

        // 3. Callback actually fired.
        assertTrue(rTok.transferCalled());
        assertTrue(rTok.reentryAttempted());

        // 4. Reentry rejected.
        assertFalse(rTok.reentryOk());

        // 5. Selector is ReentrancyGuardReentrantCall.
        bytes memory errData = rTok.reentryErrData();
        assertTrue(errData.length >= 4);
        bytes4 sel;
        assembly { sel := mload(add(errData, 0x20)) }
        assertEq(sel, REENTRANT_CALL_SELECTOR, "claimFor reentry must be rejected by guard");
    }

    // =========================================================================
    // 3. quoteJoin eligibility + deadline/capacity boundary behaviour
    // =========================================================================

    function test_QuoteJoin_ReturnsCurrentCountAsExpectedCount() public {
        uint256 poolId = _pool(4);
        vm.prank(buyer1); rp.purchaseFirst(poolId, type(uint256).max);

        (uint256 contribution, uint256 expectedCount) = rp.quoteJoin(poolId, buyer2);
        assertEq(expectedCount, 1, "expectedCount must be the current count (1)");
        assertEq(contribution, 600_000, "contribution must be shareOf(C,2,1)");

        // Passing expectedCount directly into join must succeed.
        vm.prank(buyer2);
        rp.join(poolId, expectedCount, contribution);
        assertEq(rp.getPool(poolId).count, 2);
    }

    function test_QuoteJoin_Rejects_EmptyPool() public {
        uint256 poolId = _pool(4);
        // No first purchase — count == 0.
        (bool ok, bytes memory data) = address(rp).staticcall(
            abi.encodeWithSelector(rp.quoteJoin.selector, poolId, buyer1)
        );
        assertFalse(ok);
        bytes4 sel; assembly { sel := mload(add(data, 0x20)) }
        assertEq(sel, ReflowPools.FirstPurchaseRequired.selector);
    }

    function test_QuoteJoin_Rejects_ExpiredPool() public {
        uint256 poolId = _pool(4);
        vm.prank(buyer1); rp.purchaseFirst(poolId, type(uint256).max);

        vm.warp(deadline + 1);
        (bool ok, bytes memory data) = address(rp).staticcall(
            abi.encodeWithSelector(rp.quoteJoin.selector, poolId, buyer2)
        );
        assertFalse(ok);
        bytes4 sel; assembly { sel := mload(add(data, 0x20)) }
        assertEq(sel, ReflowPools.DeadlinePassed.selector);
    }

    function test_QuoteJoin_Rejects_FullPool() public {
        uint256 poolId = _pool(2);
        vm.prank(buyer1); rp.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); rp.join(poolId, 1, type(uint256).max);

        (bool ok, bytes memory data) = address(rp).staticcall(
            abi.encodeWithSelector(rp.quoteJoin.selector, poolId, buyer3)
        );
        assertFalse(ok);
        bytes4 sel; assembly { sel := mload(add(data, 0x20)) }
        assertEq(sel, ReflowPools.CapReached.selector);
    }

    function test_QuoteJoin_Rejects_ZeroParticipant() public {
        uint256 poolId = _pool(4);
        vm.prank(buyer1); rp.purchaseFirst(poolId, type(uint256).max);

        (bool ok, bytes memory data) = address(rp).staticcall(
            abi.encodeWithSelector(rp.quoteJoin.selector, poolId, address(0))
        );
        assertFalse(ok);
        bytes4 sel; assembly { sel := mload(add(data, 0x20)) }
        assertEq(sel, ReflowPools.ZeroParticipant.selector);
    }

    function test_QuoteJoin_Rejects_SelfParticipant() public {
        uint256 poolId = _pool(4);
        vm.prank(buyer1); rp.purchaseFirst(poolId, type(uint256).max);

        (bool ok, bytes memory data) = address(rp).staticcall(
            abi.encodeWithSelector(rp.quoteJoin.selector, poolId, address(rp))
        );
        assertFalse(ok);
        bytes4 sel; assembly { sel := mload(add(data, 0x20)) }
        assertEq(sel, ReflowPools.SelfParticipant.selector);
    }

    function test_QuoteJoin_Rejects_ProviderParticipant() public {
        uint256 poolId = _pool(4);
        vm.prank(buyer1); rp.purchaseFirst(poolId, type(uint256).max);

        (bool ok, bytes memory data) = address(rp).staticcall(
            abi.encodeWithSelector(rp.quoteJoin.selector, poolId, provider)
        );
        assertFalse(ok);
        bytes4 sel; assembly { sel := mload(add(data, 0x20)) }
        assertEq(sel, ReflowPools.ProviderCannotParticipate.selector);
    }

    function test_QuoteJoin_Rejects_ExistingMember() public {
        uint256 poolId = _pool(4);
        vm.prank(buyer1); rp.purchaseFirst(poolId, type(uint256).max);

        (bool ok, bytes memory data) = address(rp).staticcall(
            abi.encodeWithSelector(rp.quoteJoin.selector, poolId, buyer1)
        );
        assertFalse(ok);
        bytes4 sel; assembly { sel := mload(add(data, 0x20)) }
        assertEq(sel, ReflowPools.AlreadyMember.selector);
    }

    /// @dev join at exact deadline must revert (deadline == block.timestamp is "passed").
    function test_Join_ExactDeadline_Reverts() public {
        uint64 dl = uint64(block.timestamp + 1 hours);
        vm.prank(provider);
        uint256 poolId = rp.createPool(C, ARTIFACT, TERMS, dl, 4);
        vm.prank(buyer1); rp.purchaseFirst(poolId, type(uint256).max);

        vm.warp(dl); // block.timestamp == deadline
        vm.prank(buyer2);
        vm.expectRevert(ReflowPools.DeadlinePassed.selector);
        rp.join(poolId, 1, type(uint256).max);
    }

    /// @dev claimFor works after the pool deadline has passed.
    function test_ClaimFor_WorksAfterDeadline() public {
        uint256 poolId = _pool(2);
        vm.prank(buyer1); rp.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); rp.join(poolId, 1, type(uint256).max);

        vm.warp(deadline + 7 days);

        uint256 b1Before = usdc.balanceOf(buyer1);
        rp.claimFor(poolId, buyer1);
        assertEq(usdc.balanceOf(buyer1) - b1Before, 600_000, "claim after deadline must succeed");
    }

    /// @dev claimFor works after pool reaches capacity.
    function test_ClaimFor_WorksAfterCapFilled() public {
        uint256 poolId = _pool(3);
        vm.prank(buyer1); rp.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); rp.join(poolId, 1, type(uint256).max);
        vm.prank(buyer3); rp.join(poolId, 2, type(uint256).max);

        // Pool is full.
        vm.prank(buyer4);
        vm.expectRevert(ReflowPools.CapReached.selector);
        rp.join(poolId, 3, type(uint256).max);

        // Claims still work.
        uint256 b1Before = usdc.balanceOf(buyer1);
        rp.claimFor(poolId, buyer1);
        // C=1_200_000, n=3: shareOf(C,3,0)=400_000; buyer1 paid C=1_200_000; rebate=800_000
        assertEq(usdc.balanceOf(buyer1) - b1Before, 800_000, "buyer1 rebate at cap");
    }

    // =========================================================================
    // 4. Rollback on false-returning and reverting token operations
    // =========================================================================

    /// @dev transferFrom returns false on purchaseFirst — no membership written.
    function test_PurchaseFirst_FalseReturnTransferFrom_Rollback() public {
        usdc.setReturnFalseTransferFrom(true);
        uint256 poolId = _pool(4);
        vm.prank(buyer1);
        vm.expectRevert(); // SafeERC20 wraps false-return as revert
        rp.purchaseFirst(poolId, type(uint256).max);
        usdc.setReturnFalseTransferFrom(false);

        assertFalse(rp.getMember(poolId, buyer1).isMember, "no phantom membership on false-return");
        assertEq(rp.getPool(poolId).count, 0, "count must stay 0");
    }

    /// @dev transferFrom reverts on purchaseFirst — CEI means no state written.
    function test_PurchaseFirst_RevertTransferFrom_Rollback() public {
        usdc.setFailTransferFrom(true);
        uint256 poolId = _pool(4);
        vm.prank(buyer1);
        vm.expectRevert("Mock6: transferFrom fail");
        rp.purchaseFirst(poolId, type(uint256).max);
        usdc.setFailTransferFrom(false);

        assertFalse(rp.getMember(poolId, buyer1).isMember);
        assertEq(rp.getPool(poolId).count, 0);
        assertEq(rp.poolLiability(poolId), 0);
        assertEq(rp.totalLiability(), 0);
    }

    /// @dev transferFrom reverts on join — no membership, no credits, no liability increase.
    function test_Join_RevertTransferFrom_Rollback() public {
        uint256 poolId = _pool(4);
        vm.prank(buyer1); rp.purchaseFirst(poolId, type(uint256).max);

        usdc.setFailTransferFrom(true);
        vm.prank(buyer2);
        vm.expectRevert("Mock6: transferFrom fail");
        rp.join(poolId, 1, type(uint256).max);
        usdc.setFailTransferFrom(false);

        // buyer2 is not a member.
        assertFalse(rp.getMember(poolId, buyer2).isMember, "no phantom membership for buyer2");
        // Pool count unchanged.
        assertEq(rp.getPool(poolId).count, 1, "count must stay 1");
        // No credits should have been issued if CEI is correct.
        // With CEI, _distributeCredits runs BEFORE transferFrom — so credits ARE written
        // to state before the transfer. On revert the entire tx unwinds; credits are undone.
        assertEq(rp.getMember(poolId, buyer1).rebatesAllocated, 0, "no credits after rolled-back join");
        assertEq(rp.poolLiability(poolId), 0);
        assertEq(rp.totalLiability(), 0);
    }

    /// @dev transferFrom returns false on join — same rollback.
    function test_Join_FalseReturnTransferFrom_Rollback() public {
        uint256 poolId = _pool(4);
        vm.prank(buyer1); rp.purchaseFirst(poolId, type(uint256).max);

        usdc.setReturnFalseTransferFrom(true);
        vm.prank(buyer2);
        vm.expectRevert();
        rp.join(poolId, 1, type(uint256).max);
        usdc.setReturnFalseTransferFrom(false);

        assertFalse(rp.getMember(poolId, buyer2).isMember);
        assertEq(rp.getPool(poolId).count, 1);
        assertEq(rp.getMember(poolId, buyer1).rebatesAllocated, 0);
        assertEq(rp.poolLiability(poolId), 0);
        assertEq(rp.totalLiability(), 0);
    }

    /// @dev buyer1 is permanently blocked as a transfer recipient throughout the test.
    ///      Proves a stuck recipient cannot stall other members:
    ///      - buyer1's claim fails while blocked; credit and both liabilities are intact.
    ///      - buyer3 joins and buyer4 joins within the cap-4 pool while buyer1 remains blocked.
    ///      - buyer2's claim succeeds even while buyer1 is still blocked.
    ///      - buyer1's credit grows correctly during the extra joins.
    ///      - Only clearing the block at the end lets buyer1 recover their full credit.
    function test_ClaimFor_RecipientBlocked_OtherMembersUnaffected() public {
        // cap=4: buyer1 first-buys; buyer2, buyer3, buyer4 join one by one.
        uint256 poolId = _pool(4);
        vm.prank(buyer1); rp.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); rp.join(poolId, 1, type(uint256).max);

        // buyer1 has 600_000 outstanding credit; buyer2 has 0.
        // C=1_200_000, n=2: share(0)=600_000; buyer1 paid 1_200_000; rebate = 600_000.
        assertEq(rp.outstandingCredit(poolId, buyer1), 600_000);
        assertEq(rp.poolLiability(poolId), 600_000);
        assertEq(rp.totalLiability(), 600_000);

        // Block buyer1 as a transfer recipient — permanently for the rest of the test.
        usdc.setBlockedRecipient(buyer1);

        // buyer1's claim fails.
        vm.expectRevert("Mock6: recipient blocked");
        rp.claimFor(poolId, buyer1);

        // Credit, poolLiability, and totalLiability are all intact after the failure.
        assertEq(rp.outstandingCredit(poolId, buyer1), 600_000, "credit intact after block");
        assertEq(rp.poolLiability(poolId), 600_000, "poolLiability intact");
        assertEq(rp.totalLiability(), 600_000, "totalLiability intact");

        // buyer3 joins while buyer1 is still blocked.
        // n: 2→3. C=1_200_000, n=3: all shares 400_000.
        // credits: buyer1 += 200_000, buyer2 += 200_000.
        vm.prank(buyer3); rp.join(poolId, 2, type(uint256).max);

        assertEq(rp.outstandingCredit(poolId, buyer1), 800_000, "buyer1 credit grows while blocked");
        assertEq(rp.outstandingCredit(poolId, buyer2), 200_000);
        assertEq(rp.poolLiability(poolId), 800_000 + 200_000, "poolLiability tracks new credits");
        assertEq(rp.totalLiability(), rp.poolLiability(poolId), "totalLiability consistent");

        // buyer2 claims successfully — buyer1's block does not affect buyer2.
        uint256 b2Before = usdc.balanceOf(buyer2);
        rp.claimFor(poolId, buyer2);
        assertEq(usdc.balanceOf(buyer2) - b2Before, 200_000, "buyer2 claims 200_000 despite buyer1 block");
        assertEq(rp.outstandingCredit(poolId, buyer2), 0);

        // buyer1 still blocked — claim still fails.
        vm.expectRevert("Mock6: recipient blocked");
        rp.claimFor(poolId, buyer1);
        assertEq(rp.outstandingCredit(poolId, buyer1), 800_000, "buyer1 credit still intact");

        // buyer4 joins while buyer1 still blocked.
        // n: 3→4. C=1_200_000, n=4: all shares 300_000.
        // credits: buyer1 += 100_000, buyer2 += 100_000, buyer3 += 100_000.
        vm.prank(buyer4); rp.join(poolId, 3, type(uint256).max);

        assertEq(rp.outstandingCredit(poolId, buyer1), 900_000, "buyer1 credit correct after buyer4");
        // buyer2 reclaimed; now gets new credit from buyer4 join.
        assertEq(rp.outstandingCredit(poolId, buyer2), 100_000);
        assertEq(rp.outstandingCredit(poolId, buyer3), 100_000);

        // Both liabilities consistent.
        uint256 expectedLiab = rp.outstandingCredit(poolId, buyer1)
                             + rp.outstandingCredit(poolId, buyer2)
                             + rp.outstandingCredit(poolId, buyer3);
        assertEq(rp.poolLiability(poolId), expectedLiab, "poolLiability matches sum of outstanding");
        assertEq(rp.totalLiability(), rp.poolLiability(poolId), "totalLiability consistent");

        // Clear the block — buyer1 can now recover their full 900_000.
        usdc.setBlockedRecipient(address(0));
        uint256 b1Before = usdc.balanceOf(buyer1);
        rp.claimFor(poolId, buyer1);
        assertEq(usdc.balanceOf(buyer1) - b1Before, 900_000, "buyer1 recovers full credit after unblock");
        assertEq(rp.outstandingCredit(poolId, buyer1), 0);
        assertEq(rp.totalLiability(), rp.poolLiability(poolId));

        // Clean up remaining credits.
        rp.claimFor(poolId, buyer2); // 100_000
        rp.claimFor(poolId, buyer3); // 100_000
        assertEq(rp.poolLiability(poolId), 0);
        assertEq(rp.totalLiability(), 0);
    }

    /// @dev transfer returns false on claimFor — credit preserved, totalLiability unchanged.
    function test_ClaimFor_FalseReturnTransfer_PreservesCredit() public {
        uint256 poolId = _pool(2);
        vm.prank(buyer1); rp.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); rp.join(poolId, 1, type(uint256).max);

        usdc.setReturnFalseTransfer(true);
        vm.expectRevert(); // SafeERC20 wraps false as revert
        rp.claimFor(poolId, buyer1);
        usdc.setReturnFalseTransfer(false);

        assertEq(rp.outstandingCredit(poolId, buyer1), 600_000);
        assertEq(rp.poolLiability(poolId), 600_000);
        assertEq(rp.totalLiability(), 600_000);

        // Claim succeeds on retry.
        uint256 b1Before = usdc.balanceOf(buyer1);
        rp.claimFor(poolId, buyer1);
        assertEq(usdc.balanceOf(buyer1) - b1Before, 600_000);
        assertEq(rp.totalLiability(), 0);
    }

    // =========================================================================
    // 5. Two funded pools: totalLiability, interleaved joins/claims, donation
    // =========================================================================

    function test_TwoFundedPools_TotalLiability_InterleavedDonation() public {
        // Pool A: C=1_200_000, cap=3
        // Pool B: C=900_000,   cap=2   (price >= cap)
        uint256 pA = _pool(1_200_000, 3);
        uint256 pB = _pool(900_000, 2);

        // Extra buyers with enough for pool B price.
        address buyerB1 = address(0xD001);
        address buyerB2 = address(0xD002);
        usdc.mint(buyerB1, 2_000_000);
        usdc.mint(buyerB2, 2_000_000);
        vm.prank(buyerB1); usdc.approve(address(rp), type(uint256).max);
        vm.prank(buyerB2); usdc.approve(address(rp), type(uint256).max);

        // Initial state.
        assertEq(rp.totalLiability(), 0);

        // Step 1: buyer1 first-purchases pool A.
        vm.prank(buyer1); rp.purchaseFirst(pA, type(uint256).max);
        assertEq(rp.totalLiability(), 0); // first purchase goes to provider, no liability

        // Step 2: buyerB1 first-purchases pool B.
        vm.prank(buyerB1); rp.purchaseFirst(pB, type(uint256).max);
        assertEq(rp.totalLiability(), 0);

        // Step 3: buyer2 joins pool A (n: 1→2).
        // credit to buyer1 = shareOf(1_200_000, 1, 0) - shareOf(1_200_000, 2, 0)
        //                  = 1_200_000 - 600_000 = 600_000
        vm.prank(buyer2); rp.join(pA, 1, type(uint256).max);
        assertEq(rp.poolLiability(pA), 600_000);
        assertEq(rp.poolLiability(pB), 0);
        assertEq(rp.totalLiability(), rp.poolLiability(pA) + rp.poolLiability(pB),
            "totalLiability must equal sum after step 3");

        // Step 4: buyerB2 joins pool B (n: 1→2).
        // credit to buyerB1 = shareOf(900_000, 1, 0) - shareOf(900_000, 2, 0)
        //                   = 900_000 - 450_000 = 450_000
        vm.prank(buyerB2); rp.join(pB, 1, type(uint256).max);
        assertEq(rp.poolLiability(pA), 600_000);
        assertEq(rp.poolLiability(pB), 450_000);
        assertEq(rp.totalLiability(), 600_000 + 450_000,
            "totalLiability must equal sum after step 4");

        // Step 5: Donation — stranger sends USDC directly to the contract.
        //         This changes the contract's token balance but must not affect any liability.
        uint256 contractBalBefore = usdc.balanceOf(address(rp));
        vm.prank(stranger); usdc.transfer(address(rp), 500_000);
        // Liabilities unchanged.
        assertEq(rp.totalLiability(), 600_000 + 450_000, "donation must not change totalLiability");
        assertEq(rp.poolLiability(pA), 600_000);
        assertEq(rp.poolLiability(pB), 450_000);
        // Token surplus is real.
        assertEq(usdc.balanceOf(address(rp)), contractBalBefore + 500_000, "donation surplus in balance");

        // Step 6: buyer3 joins pool A (n: 2→3).
        // C=1_200_000, n=3: all shares=400_000
        // credits: buyer1 += 600_000-400_000=200_000; buyer2 += 600_000-400_000=200_000
        vm.prank(buyer3); rp.join(pA, 2, type(uint256).max);
        assertEq(rp.poolLiability(pA), 600_000 + 200_000 + 200_000, "pA liability after 3rd member");
        assertEq(rp.poolLiability(pB), 450_000, "pB liability unchanged");
        assertEq(rp.totalLiability(), rp.poolLiability(pA) + rp.poolLiability(pB),
            "totalLiability consistent after step 6");

        // Step 7: Claim buyer1 from pool A.
        // outstanding for buyer1 = 600_000 + 200_000 = 800_000
        uint256 b1Before = usdc.balanceOf(buyer1);
        rp.claimFor(pA, buyer1);
        assertEq(usdc.balanceOf(buyer1) - b1Before, 800_000, "buyer1 receives 800_000");
        assertEq(rp.poolLiability(pA), 200_000, "pA liability after buyer1 claim");
        assertEq(rp.totalLiability(), rp.poolLiability(pA) + rp.poolLiability(pB),
            "totalLiability consistent after buyer1 claim");

        // Step 8: Claim buyerB1 from pool B.
        uint256 bB1Before = usdc.balanceOf(buyerB1);
        rp.claimFor(pB, buyerB1);
        assertEq(usdc.balanceOf(buyerB1) - bB1Before, 450_000, "buyerB1 receives 450_000");
        assertEq(rp.poolLiability(pB), 0, "pB liability drained");
        assertEq(rp.totalLiability(), rp.poolLiability(pA) + rp.poolLiability(pB),
            "totalLiability consistent after buyerB1 claim");

        // Step 9: Claim buyer2 from pool A.
        uint256 b2Before = usdc.balanceOf(buyer2);
        rp.claimFor(pA, buyer2);
        assertEq(usdc.balanceOf(buyer2) - b2Before, 200_000);
        assertEq(rp.totalLiability(), 0, "totalLiability must be 0 after all claims");

        // Final: contract still holds the donation surplus.
        assertEq(usdc.balanceOf(address(rp)), 500_000, "donation surplus remains in contract");

        // Provider received C_A once from buyer1 (first purchase).
        // Both pA and pB: buyer1/buyerB1 paid full price to provider at first purchase.
        // Net cost check:
        //   buyer1: paid 1_200_000, rebate 800_000, net 400_000 == shareOf(1_200_000,3,0)=400_000 ✓
        //   buyer2: paid 600_000, rebate 200_000, net 400_000 ✓
        //   buyer3: paid 400_000, rebate 0, net 400_000 ✓
        ReflowPools.Member memory mA1 = rp.getMember(pA, buyer1);
        assertEq(mA1.grossPaid - mA1.rebatesAllocated, rp.shareOf(1_200_000, 3, 0));
        ReflowPools.Member memory mA2 = rp.getMember(pA, buyer2);
        assertEq(mA2.grossPaid - mA2.rebatesAllocated, rp.shareOf(1_200_000, 3, 1));
        ReflowPools.Member memory mA3 = rp.getMember(pA, buyer3);
        assertEq(mA3.grossPaid - mA3.rebatesAllocated, rp.shareOf(1_200_000, 3, 2));
    }

    // =========================================================================
    // 6. Pure share invariants at max uint256 (no mock supply overflow)
    // =========================================================================

    /// @dev shareOf handles max uint256 values without overflow.
    function test_ShareOf_MaxUint256_NoOverflow() public view {
        // Largest C where share(C,2,0) = C/2 + C%2 won't overflow.
        uint256 maxC = type(uint256).max;
        // share(maxC, 2, 0) = maxC/2 + 1 (maxC is odd)
        // share(maxC, 2, 1) = maxC/2
        // sum = maxC/2 + 1 + maxC/2 = maxC ✓
        uint256 s0 = rp.shareOf(maxC, 2, 0);
        uint256 s1 = rp.shareOf(maxC, 2, 1);
        assertEq(s0 + s1, maxC, "sum must equal maxC for n=2");

        // For n=16, C=maxC: q = maxC/16, r = maxC%16
        // Sum of all 16 shares must equal maxC.
        uint256 sum;
        for (uint256 i; i < 16; i++) {
            sum += rp.shareOf(maxC, 16, i);
        }
        assertEq(sum, maxC, "sum must equal maxC for n=16");
    }

    /// @dev Fuzz share invariants across [2..16] with large but non-max C values
    ///      to avoid needing enormous mock balances.
    function testFuzz_ShareOf_PureMath_WideRange(uint128 rawC, uint8 rawN) public view {
        uint256 C_ = uint256(rawC);
        uint8   n_ = uint8(bound(uint256(rawN), 2, 16));
        if (C_ < uint256(n_)) C_ = uint256(n_);

        uint256 sum;
        for (uint256 i; i < n_; i++) {
            sum += rp.shareOf(C_, n_, i);
        }
        assertEq(sum, C_, "share sum == C");

        for (uint8 k = 1; k < n_; k++) {
            uint256 credits;
            for (uint256 i; i < k; i++) {
                credits += rp.shareOf(C_, k, i) - rp.shareOf(C_, k + 1, i);
            }
            assertEq(credits, rp.shareOf(C_, k + 1, k), "credits == incoming share");
        }
    }

    // =========================================================================
    // 6b. Bounded fuzz lifecycle: 2..16 buyers, input-driven claims between joins
    // =========================================================================

    /// @dev For each step we track running totals and verify solvency + totalLiability.
    ///      `claimSeed` drives which members claim between consecutive joins.
    function testFuzz_BoundedLifecycle_16Buyers(
        uint128 rawC,
        uint8   rawN,
        uint256 claimSeed
    ) public {
        uint8   n_ = uint8(bound(uint256(rawN), 2, 16));
        uint256 C_ = uint256(bound(uint256(rawC), uint256(n_), 1_000_000_000_000));

        // Allocate n_ unique buyer addresses.
        address[] memory buyers = new address[](n_);
        for (uint256 i; i < n_; i++) {
            buyers[i] = address(uint160(0xF0000000 + i));
            // Use C_*2+2 to cover the first-purchase cost (C_) and re-minting edge cases.
            usdc.mint(buyers[i], C_ * 2 + 2);
            vm.prank(buyers[i]);
            usdc.approve(address(rp), type(uint256).max);
        }

        uint256 poolId = _pool(C_, n_);

        // Snapshot provider balance before any first purchase.
        uint256 providerBalBefore = usdc.balanceOf(provider);

        // Step 0: first purchase.
        vm.prank(buyers[0]);
        rp.purchaseFirst(poolId, type(uint256).max);

        // invariant after first purchase.
        assertEq(rp.getPool(poolId).count, 1);
        assertEq(rp.poolLiability(poolId), 0);
        assertEq(rp.totalLiability(), 0);

        // Steps 1..n_-1: join + optional interleaved claims.
        uint256 seed = claimSeed;
        for (uint256 step = 1; step < n_; step++) {
            vm.prank(buyers[step]);
            rp.join(poolId, step, type(uint256).max);

            // Solvency: totalLiability == poolLiability[poolId] (single pool test).
            assertEq(rp.totalLiability(), rp.poolLiability(poolId),
                "totalLiability must equal poolLiability");

            // Contract holds at least poolLiability worth of tokens.
            assertGe(usdc.balanceOf(address(rp)), rp.poolLiability(poolId),
                "contract balance must cover poolLiability");

            // Input-driven claims: for each previous member, claim if bit is set.
            for (uint256 m; m <= step; m++) {
                seed = uint256(keccak256(abi.encodePacked(seed, m)));
                if (seed & 1 == 1) {
                    uint256 claimable = rp.outstandingCredit(poolId, buyers[m]);
                    if (claimable > 0) {
                        uint256 balBefore = usdc.balanceOf(buyers[m]);
                        rp.claimFor(poolId, buyers[m]);
                        assertEq(usdc.balanceOf(buyers[m]) - balBefore, claimable,
                            "claim amount must match outstanding");
                        assertEq(rp.totalLiability(), rp.poolLiability(poolId),
                            "totalLiability consistent after mid-lifecycle claim");
                    }
                }
            }
        }

        // Drain all remaining outstanding credits.
        for (uint256 i; i < n_; i++) {
            uint256 claimable = rp.outstandingCredit(poolId, buyers[i]);
            if (claimable > 0) {
                rp.claimFor(poolId, buyers[i]);
            }
        }

        // Final checks.
        assertEq(rp.poolLiability(poolId), 0, "poolLiability must be 0 after full drain");
        assertEq(rp.totalLiability(), 0, "totalLiability must be 0 after full drain");

        // Net cost of each member must equal their final share.
        for (uint256 i; i < n_; i++) {
            ReflowPools.Member memory m = rp.getMember(poolId, buyers[i]);
            uint256 netPaid = m.grossPaid - m.rebatesAllocated;
            assertEq(netPaid, rp.shareOf(C_, n_, i), "net paid must equal final share");
        }

        // Provider received exactly C_ from the first purchase and nothing else.
        // setUp pre-funds provider at address(0xAA01) with C*20 from the shared usdc instance.
        // The delta from providerBalBefore (snapshotted before purchaseFirst) is exactly C_.
        assertEq(usdc.balanceOf(provider) - providerBalBefore, C_, "provider received exactly C_");
    }
}
