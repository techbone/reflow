# Demo script

Shot list and narration for the 2-minute walkthrough (https://youtu.be/asWOEPYAo2Y). Real captures of the live app, the Arc explorer and the verification script; nothing sped up. The wallet signing is not on screen; the explorer transaction is the proof.

Before recording: contract deployed and verified, pool 1 created, one purchase confirmed, app hosted on Arc Mainnet.

```
REFLOW DEMO VOICEOVER  (about 1:45, read at a calm pace; the timings are where each screen starts)

0:00  TITLE
"This is Reflow, a shared-purchase settlement app on Arc. One report, a fairer share."

0:07  HOW IT WORKS PAGE
"The first buyer pays the provider the full price. Later buyers pay an equal share, and the difference flows back to earlier buyers as rebates. Everyone converges to the same net cost, enforced by the contract."

0:17  BUILT IN ARC STUDIO
"I built it in Arc Studio: the Solidity contract with eighty-six tests, the React app, the delivery server and the transaction-safety layer. Every export was independently re-tested before I used it."

0:29  APP HOME (mainnet)
"This is the live app on Arc Mainnet. It says plainly that transactions spend real USDC. Pool one sells an Arc activity report for one dollar twenty, capped at four members, and the terms are verified against the chain before anyone pays."

0:42  TERMINAL
"Here is the deployed contract checked from outside the app. The code on chain is byte-for-byte the reviewed build, it uses the canonical Arc USDC, and the pool's price, cap and both hashes match."

0:53  EXPLORER: CONTRACT
"On the Arc explorer, this is the contract, deployed on mainnet."

1:01  EXPLORER: PURCHASE TRANSACTION
"And this is the mainnet transaction. A second wallet bought into pool one through the app and the contract, moving one dollar twenty USDC directly to the provider. Status: success."

1:15  EXPLORER: LOGS
"The logs show the USDC transfer and the contract's membership event, in the same transaction."

1:24  APP RECEIPTS
"Back in the app, the receipts page reads that same event from the chain. One member of four, first purchase, one dollar twenty. If more people join, rebates flow back to this buyer."

1:36  END
"That's Reflow: contract, app and delivery built with Arc Studio, running on Arc Mainnet. Code and contract address are on screen. Thank you."

```
