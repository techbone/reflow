# Arc Mainnet release evidence (chain id 5042)

All values read from the chain; reproduce with the commands in the README.

| Item | Value |
|---|---|
| Contract `ReflowPools` | 0x8EB21094f6cEF274a2e4E31C86CA9027f3b5F3F8 |
| Deployment | tx 0xb3c26593931e5a1dc37ae5a4de0c874bb5e244f64108508decbae4dfea4a6eab, block 28,894,881, 1,304,142 gas |
| Pool 1 creation | tx 0xc2fd768536a52647b53ae5feb17b5e3c58714d771295d4a9fa12004e1957abd7, block 28,996,167, 142,446 gas |
| First purchase | tx 0xcccfa726b24fdefd09439a91fdf89539a514aa6e29e721426a5cc7529cbfd320, block 28,997,472, 143,365 gas, fee 0.00369164875 USDC |
| Purchase effect | 1.20 USDC from buyer 0xE3E7…959A to provider 0xAaa2…0c58 via the contract; USDC `Transfer` and the contract's membership event in the same transaction |
| Pool 1 | price 1,200,000 (1.20 USDC), cap 4, deadline 1796132524 (1 Dec 2026), 1 member |
| Report | blocks 28,200,000 to 28,219,999 (2026-10-27T21:34:58Z to 2026-10-28T00:23:57Z), 46,200 transactions, 12,585 USDC transfers totalling 22,599,646.531613 USDC |
| artifactHash | 0x202799799200624d68ece590b67f68a62e4739382f8f72965ee577937d201b10 |
| termsHash | 0x2e30e6919339d57066255eb75123d45ede7d1651536e4dcdce848366896dd073 (keccak256 of `public/report-mainnet-v1/terms.md`) |

## Verifier output (tools/verify_deployment.py, after the purchase)

```
PASS  chain id - rpc 5042, expected 5042
PASS  contract has code - 5501 bytes
PASS  runtime code identical to local build (immutables = canonical USDC, metadata included) - local 5501 bytes, deployed 5501 bytes
PASS  usdc() is the canonical USDC - 0x3600000000000000000000000000000000000000
PASS  USDC decimals() == 6 - 6
PASS  nextPoolId() readable - 2
INFO  nextPoolId() = 2
PASS  pool exists
INFO  provider 0xaaa25b61814f4aaaae0993770b1df86b70076c58, price 1200000, deadline 1796132524, cap 4, members 1
PASS  price - 1200000
PASS  cap - 4
PASS  artifactHash - 0x202799799200624d68ece590b67f68a62e4739382f8f72965ee577937d201b10
PASS  termsHash - 0x2e30e6919339d57066255eb75123d45ede7d1651536e4dcdce848366896dd073
RESULT: ALL CHECKS PASSED
```

## What was not run on mainnet
Join, rebate claim and report unlock were exercised end to end on Arc Testnet (contract 0x07abad5ee15b1f6973bc4942e7c21ec78fd06ba9, pools 1 and 2), not on mainnet.
