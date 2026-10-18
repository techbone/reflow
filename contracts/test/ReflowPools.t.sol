// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// NOTE: MockERC20 is a test-only mock USDC. It is NOT a real token.
// Real deployments MUST use Arc's USDC at 0x3600000000000000000000000000000000000000.

import {Test, console} from "forge-std/Test.sol";
import {ReflowPools} from "../ReflowPools.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// ---------------------------------------------------------------------------
// MOCK ERC-20 (test-only, clearly labelled)
// ---------------------------------------------------------------------------
contract MockUSDC {
    string public constant name = "Mock USDC (TEST ONLY)";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    // Configurable failure flags for revert-testing
    bool public failTransfer;
    bool public failTransferFrom;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        require(!failTransfer, "MockUSDC: transfer forced fail");
        require(balanceOf[msg.sender] >= amount, "MockUSDC: insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(!failTransferFrom, "MockUSDC: transferFrom forced fail");
        require(balanceOf[from] >= amount, "MockUSDC: insufficient balance");
        require(allowance[from][msg.sender] >= amount, "MockUSDC: insufficient allowance");
        balanceOf[from] -= amount;
        allowance[from][msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function setFailTransfer(bool v) external { failTransfer = v; }
    function setFailTransferFrom(bool v) external { failTransferFrom = v; }
}

// ReentrantClaimer removed — it had no body and was unused scaffolding.

// ---------------------------------------------------------------------------
// Malicious token that re-enters during claimFor transfer
// ---------------------------------------------------------------------------
contract ReentrantToken is MockUSDC {
    ReflowPools public target;
    uint256 public attackPoolId;
    address public attackBeneficiary;
    bool public reentered;

    function setAttack(address _target, uint256 _poolId, address _beneficiary) external {
        target = ReflowPools(_target);
        attackPoolId = _poolId;
        attackBeneficiary = _beneficiary;
    }

    // Override transfer to re-enter claimFor
    function transfer(address to, uint256 amount) external override returns (bool) {
        require(!failTransfer, "MockUSDC: transfer forced fail");
        require(balanceOf[msg.sender] >= amount, "MockUSDC: insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);

        // Attempt reentry and record the actual result — do NOT swallow.
        if (address(target) != address(0) && !reentered) {
            reentered = true;
            (bool ok, bytes memory errData) = address(target).call(
                abi.encodeWithSelector(target.claimFor.selector, attackPoolId, attackBeneficiary)
            );
            // Store result so the test can assert on it.
            reentryOk      = ok;
            reentryErrData = errData;
        }
        return true;
    }

    // Result of the reentry attempt — readable by the test.
    bool    public reentryOk;
    bytes   public reentryErrData;
}

// ---------------------------------------------------------------------------
// Main test contract
// ---------------------------------------------------------------------------
contract ReflowPoolsTest is Test {
    MockUSDC internal usdc;
    ReflowPools internal pool;

    address internal provider = address(0xA001);
    address internal buyer1  = address(0xB001);
    address internal buyer2  = address(0xB002);
    address internal buyer3  = address(0xB003);
    address internal buyer4  = address(0xB004);
    address internal stranger = address(0xC001);

    bytes32 constant ARTIFACT = keccak256("artifact");
    bytes32 constant TERMS    = keccak256("terms");

    // 1.20 USDC in 6-decimal units
    uint256 constant C = 1_200_000;

    uint64 internal deadline;

    function setUp() public {
        usdc = new MockUSDC();
        pool = new ReflowPools(address(usdc));
        deadline = uint64(block.timestamp + 30 days);

        // Fund buyers
        usdc.mint(buyer1, 10_000_000);
        usdc.mint(buyer2, 10_000_000);
        usdc.mint(buyer3, 10_000_000);
        usdc.mint(buyer4, 10_000_000);
        usdc.mint(stranger, 10_000_000);

        // Approve pool contract (all buyers)
        vm.prank(buyer1);  usdc.approve(address(pool), type(uint256).max);
        vm.prank(buyer2);  usdc.approve(address(pool), type(uint256).max);
        vm.prank(buyer3);  usdc.approve(address(pool), type(uint256).max);
        vm.prank(buyer4);  usdc.approve(address(pool), type(uint256).max);
        vm.prank(stranger); usdc.approve(address(pool), type(uint256).max);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function _createStandardPool(uint8 cap) internal returns (uint256 poolId) {
        vm.prank(provider);
        poolId = pool.createPool(C, ARTIFACT, TERMS, deadline, cap);
    }

    function _createPoolWithPrice(uint256 price, uint8 cap) internal returns (uint256 poolId) {
        vm.prank(provider);
        poolId = pool.createPool(price, ARTIFACT, TERMS, deadline, cap);
    }

    // -----------------------------------------------------------------------
    // TEST 1: Four-buyer canonical scenario for 1.20 USDC (cap=4)
    // -----------------------------------------------------------------------

    function test_FourBuyer_CanonicalScenario() public {
        // Create pool: C=1_200_000, cap=4
        uint256 poolId = _createStandardPool(4);

        // -------------------------------------------------------------------
        // Buyer1: purchaseFirst — pays C=1_200_000 to provider
        // -------------------------------------------------------------------
        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 b1Before = usdc.balanceOf(buyer1);

        vm.prank(buyer1);
        pool.purchaseFirst(poolId, C);

        assertEq(usdc.balanceOf(provider) - providerBefore, C, "provider receives C on first purchase");
        assertEq(b1Before - usdc.balanceOf(buyer1), C, "buyer1 pays C");

        // Buyer1 state
        ReflowPools.Member memory m1 = pool.getMember(poolId, buyer1);
        assertEq(m1.joinOrder, 0);
        assertEq(m1.grossPaid, C);
        assertEq(m1.rebatesAllocated, 0);
        assertEq(m1.rebatesClaimed, 0);
        assertTrue(m1.isMember);

        // -------------------------------------------------------------------
        // Buyer2: join — n goes from 1→2
        // shareOf(1_200_000, 2, 0) = 600_000 (buyer1 new share)
        // shareOf(1_200_000, 2, 1) = 600_000 (buyer2 pays)
        // credit for buyer1 = 1_200_000 - 600_000 = 600_000
        // -------------------------------------------------------------------
        (uint256 q2, ) = pool.quoteJoin(poolId, buyer2);
        assertEq(q2, 600_000, "buyer2 contribution quote");

        uint256 contractBefore = usdc.balanceOf(address(pool));
        vm.prank(buyer2);
        pool.join(poolId, 1, type(uint256).max);

        // Contract received buyer2's share
        assertEq(usdc.balanceOf(address(pool)) - contractBefore, 600_000);

        // Buyer1 now has rebatesAllocated=600_000
        m1 = pool.getMember(poolId, buyer1);
        assertEq(m1.rebatesAllocated, 600_000);

        // Pool liability = 600_000
        assertEq(pool.poolLiability(poolId), 600_000);

        // -------------------------------------------------------------------
        // Buyer3: join — n goes from 2→3
        // shareOf(1_200_000, 3, 0) = floor(1_200_000/3) + (0<0?1:0) = 400_000
        // shareOf(1_200_000, 3, 1) = 400_000
        // shareOf(1_200_000, 3, 2) = 400_000 (buyer3 pays)
        // credit b1 = 600_000 - 400_000 = 200_000
        // credit b2 = 600_000 - 400_000 = 200_000
        // total credits = 400_000 = buyer3 payment ✓
        // -------------------------------------------------------------------
        (uint256 q3, ) = pool.quoteJoin(poolId, buyer3);
        assertEq(q3, 400_000, "buyer3 contribution quote");

        vm.prank(buyer3);
        pool.join(poolId, 2, type(uint256).max);

        m1 = pool.getMember(poolId, buyer1);
        assertEq(m1.rebatesAllocated, 600_000 + 200_000, "buyer1 rebates after buyer3");

        ReflowPools.Member memory m2 = pool.getMember(poolId, buyer2);
        assertEq(m2.rebatesAllocated, 200_000, "buyer2 rebates after buyer3");

        assertEq(pool.poolLiability(poolId), 600_000 + 200_000 + 200_000, "liability after buyer3");

        // -------------------------------------------------------------------
        // Buyer4: join — n goes from 3→4
        // C=1_200_000, n=4: q=300_000, r=0 → all shares = 300_000
        // credit b1 = 400_000 - 300_000 = 100_000
        // credit b2 = 400_000 - 300_000 = 100_000
        // credit b3 = 400_000 - 300_000 = 100_000
        // total credits = 300_000 = buyer4 payment ✓
        // -------------------------------------------------------------------
        (uint256 q4, ) = pool.quoteJoin(poolId, buyer4);
        assertEq(q4, 300_000, "buyer4 contribution quote");

        vm.prank(buyer4);
        pool.join(poolId, 3, type(uint256).max);

        m1 = pool.getMember(poolId, buyer1);
        assertEq(m1.rebatesAllocated, 600_000 + 200_000 + 100_000, "buyer1 total rebates = 900_000");

        m2 = pool.getMember(poolId, buyer2);
        assertEq(m2.rebatesAllocated, 200_000 + 100_000, "buyer2 total rebates = 300_000");

        ReflowPools.Member memory m3 = pool.getMember(poolId, buyer3);
        assertEq(m3.rebatesAllocated, 100_000, "buyer3 total rebates = 100_000");

        // Final pool liability = 900_000 + 300_000 + 100_000 = 1_300_000
        assertEq(pool.poolLiability(poolId), 1_300_000, "total liability = 1_300_000");

        // -------------------------------------------------------------------
        // Claims — verify actual mock-token balances
        // -------------------------------------------------------------------
        uint256 b1BalBefore = usdc.balanceOf(buyer1);
        uint256 b2BalBefore = usdc.balanceOf(buyer2);
        uint256 b3BalBefore = usdc.balanceOf(buyer3);

        // Anyone can trigger a claim
        pool.claimFor(poolId, buyer1);
        pool.claimFor(poolId, buyer2);
        pool.claimFor(poolId, buyer3);

        assertEq(usdc.balanceOf(buyer1) - b1BalBefore, 900_000, "buyer1 receives 900_000 rebate");
        assertEq(usdc.balanceOf(buyer2) - b2BalBefore, 300_000, "buyer2 receives 300_000 rebate");
        assertEq(usdc.balanceOf(buyer3) - b3BalBefore, 100_000, "buyer3 receives 100_000 rebate");

        // Final net costs
        // buyer1: paid 1_200_000, received 900_000 → net 300_000
        // buyer2: paid 600_000, received 300_000 → net 300_000
        // buyer3: paid 400_000, received 100_000 → net 300_000
        // buyer4: paid 300_000, received 0 → net 300_000
        // buyer1 started at 10_000_000, paid 1_200_000, received 900_000 → 10_000_000 - 300_000
        assertEq(usdc.balanceOf(buyer1), 10_000_000 - 300_000, "buyer1 net cost 300_000");
        assertEq(usdc.balanceOf(buyer2), 10_000_000 - 300_000, "buyer2 net cost 300_000");
        assertEq(usdc.balanceOf(buyer3), 10_000_000 - 300_000, "buyer3 net cost 300_000");
        assertEq(usdc.balanceOf(buyer4), 10_000_000 - 300_000, "buyer4 net cost 300_000");

        // Provider received exactly C once
        assertEq(usdc.balanceOf(provider) - providerBefore, C, "provider received C exactly once");

        // Total rebates distributed = 900_000 + 300_000 + 100_000 = 1_300_000
        // = sum(paid) - n*net = (1_200_000+600_000+400_000+300_000) - 4*300_000
        // = 2_500_000 - 1_200_000 = 1_300_000 ✓
        assertEq(pool.poolLiability(poolId), 0, "liability fully settled");

        // Pool count = 4
        ReflowPools.Pool memory p = pool.getPool(poolId);
        assertEq(p.count, 4);

        // Buyer4 has no rebates, so claim should revert
        vm.expectRevert(ReflowPools.NothingToClaim.selector);
        pool.claimFor(poolId, buyer4);

        console.log("=== Four-buyer canonical scenario PASSED ===");
        console.log("  buyer1 net cost: 300000");
        console.log("  buyer2 net cost: 300000");
        console.log("  buyer3 net cost: 300000");
        console.log("  buyer4 net cost: 300000");
        console.log("  provider received: 1200000");
        console.log("  total rebates:    1300000");

    }

    // -----------------------------------------------------------------------
    // TEST 2a: shareOf invariants (static)
    // -----------------------------------------------------------------------
    function test_ShareOf_Invariants() public view {
        // For various (C, n): sum of shares must equal C
        uint256[5] memory prices    = [uint256(1_200_000), 1_000_000, 7, 100, 999_999];
        uint8[5]   memory caps      = [uint8(4),           3,         3, 7,   8      ];

        for (uint256 p = 0; p < prices.length; p++) {
            uint256 C_ = prices[p];
            uint8   n_ = caps[p];
            uint256 sum;
            uint256 prevShare = type(uint256).max;
            for (uint256 i = 0; i < n_; i++) {
                uint256 s = pool.shareOf(C_, n_, i);
                sum += s;
                // Shares never increase with join order (earlier = higher or equal share)
                if (i > 0) {
                    assertTrue(s <= prevShare, "shares must be non-increasing by join order");
                }
                prevShare = s;
            }
            assertEq(sum, C_, "sum of shares must equal C");
        }

        // Adjacent shares differ by at most 1
        for (uint256 n_ = 2; n_ <= 16; n_++) {
            uint256 C_ = 1_200_000;
            uint256 s0 = pool.shareOf(C_, n_, 0);
            uint256 sLast = pool.shareOf(C_, n_, n_ - 1);
            assertTrue(s0 - sLast <= 1, "max share difference is 1");
        }
    }

    // -----------------------------------------------------------------------
    // TEST 2b: Fuzz — uneven totals, varied n, join/claim interleavings
    // -----------------------------------------------------------------------

    /// @dev Fuzz C and n; verify share-sum invariants and credit conservation.
    function testFuzz_ShareSumAndCreditConservation(uint128 rawC, uint8 rawN) public view {
        // Clamp: n in [2..16], C >= n (per contract rule)
        uint256 C_ = uint256(rawC);
        uint8   n_ = uint8(bound(uint256(rawN), 2, 16));
        if (C_ < uint256(n_)) C_ = uint256(n_); // floor to valid

        // Sum of all shares at exactly n participants = C
        uint256 sumN;
        for (uint256 i = 0; i < n_; i++) {
            sumN += pool.shareOf(C_, n_, i);
        }
        assertEq(sumN, C_, "share sum must equal C");

        // For each step k from 1 to n-1: sum of credits equals the new share at step k+1
        // i.e., sum_{i=0}^{k-1}(share(C,k,i) - share(C,k+1,i)) == share(C,k+1,k)
        for (uint8 k = 1; k < n_; k++) {
            uint256 nextShare = pool.shareOf(C_, k + 1, k);
            uint256 totalCredits;
            for (uint256 i = 0; i < k; i++) {
                uint256 oldS = pool.shareOf(C_, k, i);
                uint256 newS = pool.shareOf(C_, k + 1, i);
                assertGe(oldS, newS, "existing member share must not increase");
                totalCredits += oldS - newS;
            }
            assertEq(totalCredits, nextShare, "credits must equal incoming payment");
        }

        // Shares differ by at most 1
        for (uint8 k = 2; k <= n_; k++) {
            uint256 s0 = pool.shareOf(C_, k, 0);
            uint256 sLast = pool.shareOf(C_, k, k - 1);
            assertLe(s0 - sLast, 1, "max share difference is 1");
        }
    }

    /// @dev Fuzz the full lifecycle: create, first purchase, n-1 joins, all claims.
    ///      Verify pool isolation and liability is zero after all claims.
    function testFuzz_FullLifecycle(uint128 rawC, uint8 rawN) public {
        uint8  n_ = uint8(bound(uint256(rawN), 2, 6)); // keep gas sane: max 6
        uint256 C_ = uint256(bound(uint256(rawC), uint256(n_), 1_000_000_000));

        // Create a second pool to verify isolation
        uint256 poolA = _createPoolWithPrice(C_, n_);
        uint256 poolB = _createPoolWithPrice(C_ + 1, n_); // slightly different price

        // Set up n_ addresses, fund them
        address[] memory buyers = new address[](n_);
        for (uint256 i = 0; i < n_; i++) {
            buyers[i] = address(uint160(0xDEAD0000 + i));
            usdc.mint(buyers[i], C_ * 2 + 1);
            vm.prank(buyers[i]);
            usdc.approve(address(pool), type(uint256).max);
        }

        // First purchase on poolA
        vm.prank(buyers[0]);
        pool.purchaseFirst(poolA, type(uint256).max);

        // Joins on poolA
        for (uint256 i = 1; i < n_; i++) {
            (uint256 quote, ) = pool.quoteJoin(poolA, buyers[i]);
            vm.prank(buyers[i]);
            pool.join(poolA, i, quote); // use exact expected count and contribution
        }

        // poolB is never touched — its liability stays 0
        assertEq(pool.poolLiability(poolB), 0, "pool isolation: poolB liability untouched");

        // Claims on poolA — verify liability drains to 0
        uint256 totalRebatesClaimed;
        for (uint256 i = 0; i < n_; i++) {
            ReflowPools.Member memory m = pool.getMember(poolA, buyers[i]);
            uint256 claimable = m.rebatesAllocated - m.rebatesClaimed;
            if (claimable > 0) {
                uint256 balBefore = usdc.balanceOf(buyers[i]);
                pool.claimFor(poolA, buyers[i]);
                assertEq(usdc.balanceOf(buyers[i]) - balBefore, claimable, "claim amount matches allocated");
                totalRebatesClaimed += claimable;
            }
        }

        assertEq(pool.poolLiability(poolA), 0, "liability drains to 0 after all claims");

        // All buyers' net cost should equal shareOf(C_, n_, i)
        // net = grossPaid - rebatesAllocated
        for (uint256 i = 0; i < n_; i++) {
            ReflowPools.Member memory m = pool.getMember(poolA, buyers[i]);
            uint256 netPaid = m.grossPaid - m.rebatesAllocated;
            uint256 expectedShare = pool.shareOf(C_, n_, i);
            assertEq(netPaid, expectedShare, "net paid must equal final share");
        }
    }

    // -----------------------------------------------------------------------
    // TEST 2c: Interleaved join/claim
    // -----------------------------------------------------------------------
    function test_InterleavedJoinClaim() public {
        // 4-buyer pool; claim after each join
        uint256 poolId = _createStandardPool(4);

        vm.prank(buyer1);
        pool.purchaseFirst(poolId, type(uint256).max);

        vm.prank(buyer2);
        pool.join(poolId, 1, type(uint256).max);

        // buyer1 claims early (600_000)
        uint256 b1Bal = usdc.balanceOf(buyer1);
        pool.claimFor(poolId, buyer1);
        assertEq(usdc.balanceOf(buyer1) - b1Bal, 600_000);

        vm.prank(buyer3);
        pool.join(poolId, 2, type(uint256).max);

        // buyer1 gets another 200_000
        b1Bal = usdc.balanceOf(buyer1);
        pool.claimFor(poolId, buyer1);
        assertEq(usdc.balanceOf(buyer1) - b1Bal, 200_000);

        vm.prank(buyer4);
        pool.join(poolId, 3, type(uint256).max);

        // Claim everyone
        pool.claimFor(poolId, buyer1); // 100_000
        pool.claimFor(poolId, buyer2); // 300_000
        pool.claimFor(poolId, buyer3); // 100_000

        assertEq(pool.poolLiability(poolId), 0);
    }

    // -----------------------------------------------------------------------
    // TEST 3: Error paths
    // -----------------------------------------------------------------------

    // --- createPool errors ---

    function test_Revert_CreatePool_ZeroPrice() public {
        vm.prank(provider);
        vm.expectRevert(ReflowPools.InvalidPrice.selector);
        pool.createPool(0, ARTIFACT, TERMS, deadline, 4);
    }

    function test_Revert_CreatePool_ZeroArtifactHash() public {
        vm.prank(provider);
        vm.expectRevert(ReflowPools.InvalidHash.selector);
        pool.createPool(C, bytes32(0), TERMS, deadline, 4);
    }

    function test_Revert_CreatePool_ZeroTermsHash() public {
        vm.prank(provider);
        vm.expectRevert(ReflowPools.InvalidHash.selector);
        pool.createPool(C, ARTIFACT, bytes32(0), deadline, 4);
    }

    function test_Revert_CreatePool_DeadlineInPast() public {
        vm.prank(provider);
        vm.expectRevert(ReflowPools.InvalidDeadline.selector);
        pool.createPool(C, ARTIFACT, TERMS, uint64(block.timestamp - 1), 4);
    }

    function test_Revert_CreatePool_DeadlineEqualNow() public {
        vm.prank(provider);
        vm.expectRevert(ReflowPools.InvalidDeadline.selector);
        pool.createPool(C, ARTIFACT, TERMS, uint64(block.timestamp), 4);
    }

    function test_Revert_CreatePool_CapOne() public {
        vm.prank(provider);
        vm.expectRevert(ReflowPools.InvalidCap.selector);
        pool.createPool(C, ARTIFACT, TERMS, deadline, 1);
    }

    function test_Revert_CreatePool_CapZero() public {
        vm.prank(provider);
        vm.expectRevert(ReflowPools.InvalidCap.selector);
        pool.createPool(C, ARTIFACT, TERMS, deadline, 0);
    }

    function test_Revert_CreatePool_Cap17() public {
        vm.prank(provider);
        vm.expectRevert(ReflowPools.InvalidCap.selector);
        pool.createPool(C, ARTIFACT, TERMS, deadline, 17);
    }

    function test_Revert_CreatePool_PriceLowerThanCap() public {
        vm.prank(provider);
        vm.expectRevert(ReflowPools.PriceTooLow.selector);
        pool.createPool(3, ARTIFACT, TERMS, deadline, 4); // price=3 < cap=4
    }

    // --- purchaseFirst errors ---

    function test_Revert_PurchaseFirst_PoolNotExist() public {
        vm.prank(buyer1);
        vm.expectRevert(ReflowPools.PoolDoesNotExist.selector);
        pool.purchaseFirst(999, type(uint256).max);
    }

    function test_Revert_PurchaseFirst_DeadlinePassed() public {
        uint256 poolId = _createStandardPool(4);
        vm.warp(block.timestamp + 31 days);
        vm.prank(buyer1);
        vm.expectRevert(ReflowPools.DeadlinePassed.selector);
        pool.purchaseFirst(poolId, type(uint256).max);
    }

    function test_Revert_PurchaseFirst_DeadlineAtExact() public {
        uint64 dl = uint64(block.timestamp + 1 hours);
        vm.prank(provider);
        uint256 poolId = pool.createPool(C, ARTIFACT, TERMS, dl, 4);
        vm.warp(dl); // at deadline is "passed"
        vm.prank(buyer1);
        vm.expectRevert(ReflowPools.DeadlinePassed.selector);
        pool.purchaseFirst(poolId, type(uint256).max);
    }

    function test_Revert_PurchaseFirst_ProviderCannotBuy() public {
        uint256 poolId = _createStandardPool(4);
        usdc.mint(provider, C);
        vm.prank(provider);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(provider);
        vm.expectRevert(ReflowPools.ProviderCannotParticipate.selector);
        pool.purchaseFirst(poolId, type(uint256).max);
    }

    function test_Revert_PurchaseFirst_MembersAlreadyExist() public {
        uint256 poolId = _createStandardPool(4);
        vm.prank(buyer1);
        pool.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2);
        vm.expectRevert(ReflowPools.MembersAlreadyExist.selector);
        pool.purchaseFirst(poolId, type(uint256).max);
    }

    function test_Revert_PurchaseFirst_MaxAmountTooLow() public {
        uint256 poolId = _createStandardPool(4);
        vm.prank(buyer1);
        vm.expectRevert(abi.encodeWithSelector(ReflowPools.ContributionTooHigh.selector, C, C - 1));
        pool.purchaseFirst(poolId, C - 1);
    }

    function test_Revert_PurchaseFirst_InsufficientBalance() public {
        // poorBuyer has no USDC — transferFrom should revert
        address poorBuyer = address(0xE001);
        uint256 poolId = _createStandardPool(4);
        vm.startPrank(poorBuyer);
        usdc.approve(address(pool), type(uint256).max);
        vm.expectRevert(); // MockUSDC: insufficient balance
        pool.purchaseFirst(poolId, type(uint256).max);
        vm.stopPrank();
    }

    function test_Revert_PurchaseFirst_InsufficientAllowance() public {
        uint256 poolId = _createStandardPool(4);
        // Reset buyer1 allowance to 0
        vm.prank(buyer1);
        usdc.approve(address(pool), 0);
        vm.prank(buyer1);
        vm.expectRevert(); // MockUSDC: insufficient allowance
        pool.purchaseFirst(poolId, type(uint256).max);
    }

    function test_Revert_PurchaseFirst_FailedPaymentRollback() public {
        // If token transferFrom fails, all state changes must revert
        uint256 poolId = _createStandardPool(4);

        usdc.setFailTransferFrom(true);
        vm.prank(buyer1);
        vm.expectRevert("MockUSDC: transferFrom forced fail");
        pool.purchaseFirst(poolId, type(uint256).max);
        usdc.setFailTransferFrom(false);

        // State should be unchanged: pool.count still 0
        ReflowPools.Pool memory p = pool.getPool(poolId);
        assertEq(p.count, 0, "count unchanged after failed first purchase");
        assertFalse(pool.getMember(poolId, buyer1).isMember, "buyer1 not a member after failed purchase");
    }

    // --- join errors ---

    function test_Revert_Join_PoolNotExist() public {
        vm.prank(buyer2);
        vm.expectRevert(ReflowPools.PoolDoesNotExist.selector);
        pool.join(999, 1, type(uint256).max);
    }

    function test_Revert_Join_DeadlinePassed() public {
        uint256 poolId = _createStandardPool(4);
        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);
        vm.warp(block.timestamp + 31 days);
        vm.prank(buyer2);
        vm.expectRevert(ReflowPools.DeadlinePassed.selector);
        pool.join(poolId, 1, type(uint256).max);
    }

    function test_Revert_Join_NoFirstPurchase() public {
        uint256 poolId = _createStandardPool(4);
        vm.prank(buyer2);
        vm.expectRevert(ReflowPools.FirstPurchaseRequired.selector);
        pool.join(poolId, 0, type(uint256).max);
    }

    function test_Revert_Join_CapReached() public {
        uint256 poolId = _createStandardPool(2); // cap=2
        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); pool.join(poolId, 1, type(uint256).max);
        vm.prank(buyer3);
        vm.expectRevert(ReflowPools.CapReached.selector);
        pool.join(poolId, 2, type(uint256).max);
    }

    function test_Revert_Join_ProviderCannotJoin() public {
        uint256 poolId = _createStandardPool(4);
        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);
        vm.prank(provider);
        vm.expectRevert(ReflowPools.ProviderCannotParticipate.selector);
        pool.join(poolId, 1, type(uint256).max);
    }

    function test_Revert_Join_DuplicateParticipant() public {
        uint256 poolId = _createStandardPool(4);
        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); pool.join(poolId, 1, type(uint256).max);
        vm.prank(buyer2); // buyer2 tries again
        vm.expectRevert(ReflowPools.AlreadyMember.selector);
        pool.join(poolId, 2, type(uint256).max);
    }

    function test_Revert_Join_StaleQuote_CountMismatch() public {
        uint256 poolId = _createStandardPool(4);
        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); pool.join(poolId, 1, type(uint256).max);
        // buyer3 expects count=1 but it's 2
        vm.prank(buyer3);
        vm.expectRevert(abi.encodeWithSelector(ReflowPools.CountMismatch.selector, 1, 2));
        pool.join(poolId, 1, type(uint256).max);
    }

    function test_Revert_Join_MaxContributionTooLow() public {
        uint256 poolId = _createStandardPool(4);
        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);
        // buyer2 contributes 600_000 but maxContribution = 1
        vm.prank(buyer2);
        vm.expectRevert(abi.encodeWithSelector(ReflowPools.ContributionTooHigh.selector, 600_000, 1));
        pool.join(poolId, 1, 1);
    }

    // --- claimFor errors ---

    function test_Revert_ClaimFor_PoolNotExist() public {
        vm.expectRevert(ReflowPools.PoolDoesNotExist.selector);
        pool.claimFor(999, buyer1);
    }

    function test_Revert_ClaimFor_NotAMember() public {
        uint256 poolId = _createStandardPool(4);
        vm.expectRevert(ReflowPools.NotAMember.selector);
        pool.claimFor(poolId, stranger);
    }

    function test_Revert_ClaimFor_NothingToClaim() public {
        uint256 poolId = _createStandardPool(4);
        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);
        // buyer1 has no rebates yet (only one member)
        vm.expectRevert(ReflowPools.NothingToClaim.selector);
        pool.claimFor(poolId, buyer1);
    }

    function test_Revert_ClaimFor_DoubleClaim() public {
        uint256 poolId = _createStandardPool(2);
        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); pool.join(poolId, 1, type(uint256).max);
        pool.claimFor(poolId, buyer1);
        vm.expectRevert(ReflowPools.NothingToClaim.selector);
        pool.claimFor(poolId, buyer1);
    }

    function test_ClaimFor_FailedTransferPreservesCredit() public {
        uint256 poolId = _createStandardPool(2);
        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); pool.join(poolId, 1, type(uint256).max);

        // Force transfer to fail
        usdc.setFailTransfer(true);
        vm.expectRevert("MockUSDC: transfer forced fail");
        pool.claimFor(poolId, buyer1);
        usdc.setFailTransfer(false);

        // Credit still available
        assertEq(pool.outstandingCredit(poolId, buyer1), 600_000, "credit preserved after failed claim");
        // Liability still intact
        assertEq(pool.poolLiability(poolId), 600_000);

        // Now succeeds
        pool.claimFor(poolId, buyer1);
        assertEq(pool.outstandingCredit(poolId, buyer1), 0);
    }

    // --- quoteJoin errors ---

    function test_Revert_QuoteJoin_PoolNotExist() public view {
        // quoteJoin is view so we just check PoolDoesNotExist
        // In Forge we use try/catch in view context via low-level call
        (bool ok, bytes memory data) = address(pool).staticcall(
            abi.encodeWithSelector(pool.quoteJoin.selector, uint256(999), buyer1)
        );
        assertFalse(ok);
        // Decode selector
        bytes4 sel;
        assembly { sel := mload(add(data, 0x20)) }
        assertEq(sel, ReflowPools.PoolDoesNotExist.selector);
    }

    // test_Revert_QuoteJoin_CapReached was previously empty.
    // The actual behavior is covered by test_Revert_QuoteJoin_CapReached_Dynamic below.

    function test_Revert_QuoteJoin_CapReached_Dynamic() public {
        uint256 poolId = _createStandardPool(2);
        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); pool.join(poolId, 1, type(uint256).max);
        // quoteJoin on full pool
        (bool ok, bytes memory data) = address(pool).staticcall(
            abi.encodeWithSelector(pool.quoteJoin.selector, poolId, buyer3)
        );
        assertFalse(ok);
        bytes4 sel;
        assembly { sel := mload(add(data, 0x20)) }
        assertEq(sel, ReflowPools.CapReached.selector);
    }

    // --- Constructor ---

    function test_Revert_Constructor_ZeroAddress() public {
        vm.expectRevert(ReflowPools.ZeroAddress.selector);
        new ReflowPools(address(0));
    }

    // --- Donations (unsolicited transfers create no membership) ---

    function test_Donation_CreatesNoMembership() public {
        uint256 poolId = _createStandardPool(4);
        // stranger sends USDC directly to contract
        vm.prank(stranger);
        usdc.transfer(address(pool), 500_000);

        // stranger is not a member
        assertFalse(pool.getMember(poolId, stranger).isMember);
        // poolLiability unchanged
        assertEq(pool.poolLiability(poolId), 0);
    }

    function test_Donation_DoesNotAffectLiabilityAccounting() public {
        uint256 poolId = _createStandardPool(4);
        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); pool.join(poolId, 1, type(uint256).max);

        // donate
        vm.prank(stranger);
        usdc.transfer(address(pool), 999_999);

        // Claims still exact
        uint256 b1Before = usdc.balanceOf(buyer1);
        pool.claimFor(poolId, buyer1);
        assertEq(usdc.balanceOf(buyer1) - b1Before, 600_000);
    }

    // --- No native value ---

    function test_Revert_NativeValue_PurchaseFirst() public {
        // Contract has no receive() / fallback(), so any ETH send reverts.
        vm.deal(buyer1, 1 ether);
        (bool success,) = address(pool).call{value: 1 ether}("");
        assertFalse(success, "plain ETH send should revert");

        // Encoding purchaseFirst with ETH value also reverts
        uint256 poolId = _createStandardPool(4);
        (bool success2,) = address(pool).call{value: 1 ether}(
            abi.encodeWithSelector(pool.purchaseFirst.selector, poolId, type(uint256).max)
        );
        assertFalse(success2, "purchaseFirst with ETH value should revert");
    }

    // --- Reentrancy ---

    /// @dev A malicious token re-enters claimFor during the transfer callback.
    ///      The outer claimFor must succeed; the reentry attempt must be rejected
    ///      with ReentrancyGuardReentrantCall, and buyer1 must receive exactly one
    ///      payment — not zero, not two.
    function test_Reentrancy_ClaimFor() public {
        ReentrantToken rToken = new ReentrantToken();
        ReflowPools rPool = new ReflowPools(address(rToken));

        rToken.mint(buyer1, C * 10);
        rToken.mint(buyer2, C * 10);
        vm.prank(buyer1); rToken.approve(address(rPool), type(uint256).max);
        vm.prank(buyer2); rToken.approve(address(rPool), type(uint256).max);

        vm.prank(provider);
        uint256 poolId = rPool.createPool(C, ARTIFACT, TERMS, deadline, 2);

        vm.prank(buyer1); rPool.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); rPool.join(poolId, 1, type(uint256).max);

        // Arm the token to re-enter claimFor(poolId, buyer1) during the outbound transfer.
        rToken.setAttack(address(rPool), poolId, buyer1);

        uint256 b1Before = rToken.balanceOf(buyer1);
        rPool.claimFor(poolId, buyer1);

        // 1. Outer call succeeded: buyer1 received exactly one rebate payment.
        assertEq(rToken.balanceOf(buyer1) - b1Before, 600_000, "buyer1 must receive exactly one rebate");

        // 2. Outstanding credit is fully zero — no double-count.
        assertEq(rPool.outstandingCredit(poolId, buyer1), 0, "outstanding credit must be zero");

        // 3. The callback actually attempted reentry (reentered flag flipped).
        assertTrue(rToken.reentered(), "callback must have attempted reentry");

        // 4. Reentry was rejected — not silently swallowed.
        assertFalse(rToken.reentryOk(), "reentry call must have been rejected");

        // 5. Rejection was specifically ReentrancyGuardReentrantCall.
        bytes memory errData = rToken.reentryErrData();
        assertTrue(errData.length >= 4, "reentry error data must contain a selector");
        bytes4 sel;
        assembly { sel := mload(add(errData, 0x20)) }
        // ReentrancyGuard.ReentrancyGuardReentrantCall selector
        assertEq(sel, bytes4(keccak256("ReentrancyGuardReentrantCall()")),
            "reentry must be rejected with ReentrancyGuardReentrantCall");
    }

    // --- Pool isolation between two pools ---

    function test_PoolIsolation() public {
        uint256 poolA = _createStandardPool(2);
        uint256 poolB = _createStandardPool(3);

        address buyerA1 = address(0xA101);
        address buyerA2 = address(0xA102);
        address buyerB1 = address(0xB101);
        address buyerB2 = address(0xB102);
        address buyerB3 = address(0xB103);

        address[5] memory _isoAddrs = [buyerA1, buyerA2, buyerB1, buyerB2, buyerB3];
        for (uint256 _ia = 0; _ia < _isoAddrs.length; _ia++) {
            usdc.mint(_isoAddrs[_ia], C * 3);
            vm.prank(_isoAddrs[_ia]);
            usdc.approve(address(pool), type(uint256).max);
        }

        vm.prank(buyerA1); pool.purchaseFirst(poolA, type(uint256).max);
        vm.prank(buyerA2); pool.join(poolA, 1, type(uint256).max);

        vm.prank(buyerB1); pool.purchaseFirst(poolB, type(uint256).max);
        vm.prank(buyerB2); pool.join(poolB, 1, type(uint256).max);
        vm.prank(buyerB3); pool.join(poolB, 2, type(uint256).max);

        // Liabilities are isolated
        assertEq(pool.poolLiability(poolA), 600_000);
        // poolB: n=3, C=1_200_000
        // b1 share at n=3: 400_000; at n=2: 600_000 → credit = 200_000
        // b2 share at n=3: 400_000; b2 joined at n=2 so grossPaid=600_000 → credit = 200_000
        // buyer3 pays 400_000; total credits = 400_000 ✓
        // After buyer2 joins poolB: buyer1 gets 600_000 credit
        // After buyer3 joins poolB: buyer1 gets 200_000 more, buyer2 gets 200_000
        // total liability poolB = 600_000 + 200_000 + 200_000 = 1_000_000
        assertEq(pool.poolLiability(poolB), 1_000_000);

        // poolA member not in poolB
        assertFalse(pool.getMember(poolB, buyerA1).isMember);
        assertFalse(pool.getMember(poolA, buyerB1).isMember);
    }

    // --- Events ---

    function test_Events_PoolCreated() public {
        vm.expectEmit(true, true, false, true);
        emit ReflowPools.PoolCreated(1, provider, C, ARTIFACT, TERMS, deadline, 4);
        vm.prank(provider);
        pool.createPool(C, ARTIFACT, TERMS, deadline, 4);
    }

    function test_Events_FirstPurchased() public {
        uint256 poolId = _createStandardPool(4);
        vm.expectEmit(true, true, false, true);
        emit ReflowPools.FirstPurchased(poolId, buyer1, C);
        vm.prank(buyer1);
        pool.purchaseFirst(poolId, type(uint256).max);
    }

    function test_Events_Joined_And_RebateCredited() public {
        uint256 poolId = _createStandardPool(4);
        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);

        vm.expectEmit(true, true, false, true);
        emit ReflowPools.RebateCredited(poolId, buyer1, 600_000);
        vm.expectEmit(true, true, false, true);
        emit ReflowPools.Joined(poolId, buyer2, 1, 600_000);
        vm.prank(buyer2);
        pool.join(poolId, 1, type(uint256).max);
    }

    function test_Events_RebateClaimed() public {
        uint256 poolId = _createStandardPool(2);
        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); pool.join(poolId, 1, type(uint256).max);

        vm.expectEmit(true, true, false, true);
        emit ReflowPools.RebateClaimed(poolId, buyer1, 600_000);
        pool.claimFor(poolId, buyer1);
    }

    // --- nextPoolId increments correctly ---

    function test_NextPoolId_Increments() public {
        assertEq(pool.nextPoolId(), 1);
        _createStandardPool(2);
        assertEq(pool.nextPoolId(), 2);
        _createStandardPool(2);
        assertEq(pool.nextPoolId(), 3);
    }

    // --- Membership persists after claiming ---

    function test_MembershipPersistsAfterClaim() public {
        uint256 poolId = _createStandardPool(2);
        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); pool.join(poolId, 1, type(uint256).max);
        pool.claimFor(poolId, buyer1);
        assertTrue(pool.getMember(poolId, buyer1).isMember, "membership persists after claim");
    }

    // --- Anyone can trigger claimFor ---

    function test_AnyoneCanTriggerClaim() public {
        uint256 poolId = _createStandardPool(2);
        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);
        vm.prank(buyer2); pool.join(poolId, 1, type(uint256).max);

        uint256 b1Before = usdc.balanceOf(buyer1);
        // stranger triggers claim for buyer1
        vm.prank(stranger);
        pool.claimFor(poolId, buyer1);
        // buyer1 receives the rebate, not stranger
        assertEq(usdc.balanceOf(buyer1) - b1Before, 600_000);
        assertEq(usdc.balanceOf(stranger), 10_000_000, "stranger balance unchanged");
    }

    // --- outstandingCredit view ---

    function test_OutstandingCredit_BeforeAndAfterClaim() public {
        uint256 poolId = _createStandardPool(2);
        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);
        assertEq(pool.outstandingCredit(poolId, buyer1), 0);
        vm.prank(buyer2); pool.join(poolId, 1, type(uint256).max);
        assertEq(pool.outstandingCredit(poolId, buyer1), 600_000);
        pool.claimFor(poolId, buyer1);
        assertEq(pool.outstandingCredit(poolId, buyer1), 0);
    }

    // --- Two-buyer pool exact arithmetic ---

    function test_TwoBuyer_Exact() public {
        // C=1_000_000 (1.00 USDC), cap=2
        // buyer1 pays 1_000_000 to provider
        // buyer2 pays 500_000 to contract; buyer1 gets 500_000 rebate
        uint256 price = 1_000_000;
        vm.prank(provider);
        uint256 poolId = pool.createPool(price, ARTIFACT, TERMS, deadline, 2);

        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);

        uint256 provBefore = usdc.balanceOf(provider);
        vm.prank(buyer2); pool.join(poolId, 1, type(uint256).max);

        // buyer2 paid 500_000 to contract
        // buyer1 has 500_000 rebate
        assertEq(pool.poolLiability(poolId), 500_000);
        assertEq(pool.outstandingCredit(poolId, buyer1), 500_000);

        pool.claimFor(poolId, buyer1);
        assertEq(usdc.balanceOf(buyer1), 10_000_000 - 500_000, "buyer1 net cost 500_000");
        assertEq(usdc.balanceOf(buyer2), 10_000_000 - 500_000, "buyer2 net cost 500_000");
        assertEq(usdc.balanceOf(provider) - provBefore, 0, "provider received nothing on join");
        assertEq(usdc.balanceOf(provider), price, "provider total = price from first purchase");
    }

    // --- Uneven division (remainder) ---

    function test_UnevenDivision_7units_3cap() public {
        // C=7 (7 atomic units), cap=3
        // n=1: buyer1 pays 7
        // n=2: q=3, r=1; share(0)=4, share(1)=3 → buyer2 pays 3, buyer1 gets 7-4=3 rebate
        // n=3: q=2, r=1; share(0)=3, share(1)=2, share(2)=2 → buyer3 pays 2
        //   credits: buyer1: 4-3=1, buyer2: 3-2=1 → total=2 ✓

        vm.prank(provider);
        uint256 poolId = pool.createPool(7, ARTIFACT, TERMS, deadline, 3);

        usdc.mint(buyer1, 100); vm.prank(buyer1); usdc.approve(address(pool), type(uint256).max);
        usdc.mint(buyer2, 100); vm.prank(buyer2); usdc.approve(address(pool), type(uint256).max);
        usdc.mint(buyer3, 100); vm.prank(buyer3); usdc.approve(address(pool), type(uint256).max);

        vm.prank(buyer1); pool.purchaseFirst(poolId, type(uint256).max);
        // buyer1 paid 7, grossPaid=7

        vm.prank(buyer2); pool.join(poolId, 1, type(uint256).max);
        // buyer2: share(7,2,1)=3; buyer1 credit = 7-4=3
        assertEq(pool.getMember(poolId, buyer2).grossPaid, 3);
        assertEq(pool.getMember(poolId, buyer1).rebatesAllocated, 3);

        vm.prank(buyer3); pool.join(poolId, 2, type(uint256).max);
        // buyer3: share(7,3,2)=2; credits: buyer1 gets 4-3=1; buyer2 gets 3-2=1
        assertEq(pool.getMember(poolId, buyer3).grossPaid, 2);
        assertEq(pool.getMember(poolId, buyer1).rebatesAllocated, 3 + 1); // =4
        assertEq(pool.getMember(poolId, buyer2).rebatesAllocated, 1);

        // Net costs: buyer1: 7-4=3, buyer2: 3-1=2, buyer3: 2
        // Final shares: share(7,3,0)=3, share(7,3,1)=2, share(7,3,2)=2
        pool.claimFor(poolId, buyer1);
        pool.claimFor(poolId, buyer2);
        // buyer3 has no rebates
        vm.expectRevert(ReflowPools.NothingToClaim.selector);
        pool.claimFor(poolId, buyer3);

        assertEq(pool.poolLiability(poolId), 0);
    }
}
