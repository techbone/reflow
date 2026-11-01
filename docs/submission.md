# Submission text (Arc Microgrants: Built with Arc Studio)

**Project name:** Reflow

**One-line description:** Shared-purchase settlement on Arc: the first buyer pays the provider in full, later buyers pay an equal share, and the difference flows back to earlier buyers as claimable rebates, so everyone converges to the same net cost.

**Description:**
Reflow lets a group split the cost of a digital good fairly without a middleman. A provider opens a pool with a fixed price, a cap and a deadline. The first buyer pays the full price straight to the provider. Each later buyer pays an equal share of the total, and the difference is credited to earlier buyers as rebates they can claim at any time. The contract has no owner, no upgrade path and no admin sweep, and USDC moves only between the buyer, the provider and the claimant.

Built entirely in Arc Studio: the Solidity contract (86 tests), the React app, the transaction-safety layer and the delivery server that releases the purchased report to pool members after a wallet signature checked against the chain. Every export was independently re-tested before use.

Live on Arc Mainnet with real USDC: pool 1 sells a public-data Arc activity report for 1.20 USDC (cap 4). A second wallet bought into it through the app and the contract, and the receipts page reads that purchase back from the chain.

**Links**
- Public app: https://reflow-zeta.vercel.app
- Arc Studio project: https://studio.arc.io/app/29b3248b-8871-4fa5-81ec-96da70644dff
- Public repo: https://github.com/techbone/reflow
- Builder profile: https://github.com/techbone

**Arc Mainnet (chain id 5042)**
- Contract ReflowPools: 0x8EB21094f6cEF274a2e4E31C86CA9027f3b5F3F8 (https://explorer.arc.io/address/0x8EB21094f6cEF274a2e4E31C86CA9027f3b5F3F8)
- Deployment tx: https://explorer.arc.io/tx/0xb3c26593931e5a1dc37ae5a4de0c874bb5e244f64108508decbae4dfea4a6eab
- Pool 1 creation tx: https://explorer.arc.io/tx/0xc2fd768536a52647b53ae5feb17b5e3c58714d771295d4a9fa12004e1957abd7
- **Example USDC transaction through the contract and app (1.20 USDC, buyer to provider):** https://explorer.arc.io/tx/0xcccfa726b24fdefd09439a91fdf89539a514aa6e29e721426a5cc7529cbfd320

**Honest notes**
- Unaudited code that handles real USDC; use small amounts.
- The hosted link shows the pool and supports buy, join and claim; the private report download needs the delivery server, which runs locally in the demo video.
- The README and open report generator in the repo were written outside Studio; the app, contract and server were written in Studio.
