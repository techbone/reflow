# Build log: dead ends, the path chosen, and the test that guards it

Each entry is something that surprised us while building Reflow with Arc Studio. Studio wrote the code; each export was pulled and re-checked independently (typecheck, build, tests, real processes, real chain reads, browser renders) before it was accepted.

| What happened | What we did | Guard |
|---|---|---|
| First transaction-controller export had tests that never imported the real controller | Rejected; four correction rounds until the tests drove the real orchestrator | `src/tests/txController.test.ts`, `txLifecycle.test.ts` |
| Server read `getMember` by position and treated `joinOrder` as `isMember` | Decode by field name from the ABI | `server/tests/chainAdapter.test.ts` |
| "Create pool" button was invisible (`var(--cta)` was undefined) | Defined the token; audit every CSS variable used | `src/tests/cssVarAudit.test.ts` |
| Stat tiles overflowed with large claimable values | Reflowed the tiles | `src/tests/statTiles.test.ts` |
| Unlock said "not a member" right after a purchase (stale React closure) | Read membership from the chain at click time | `src/tests/deliveryClient.test.ts` |
| Dev delivery server collided with another local project on port 8787 | `DELIVERY_PORT` shared by the server and the Vite proxy | `server/serverPort.ts` |
| Network guards were unit-tested but not wired into the real server (testnet contract accepted on mainnet, typo'd network silently testnet) | Wired `validateServerConfig` and strict parsing; checked with seven real-server cases | `server/tests/validateConfig.test.ts`, `assertBuildEnv.test.ts` |
| Static server answered `/.env` and similar paths with the SPA page and 200 | 404s for non-assets plus path-traversal protection, attacked for real | `server/tests/staticServing.test.ts` |
| Mainnet mode still said "Switch to Arc Testnet" and "no real funds" | Network-aware copy everywhere, plus a whole-source scan | `src/tests/networkCopy.test.ts` |
| Admin pool creation on mainnet refused: it fetched the testnet manifest | The refusal was the guard working; fixed the manifest path | `src/tests/adminPool.test.ts` |
| The hosted production build showed Arc Testnet against the mainnet contract | `'env' in import.meta` is only true in the dev server; read `import.meta.env` directly | `server/tests/viteBuild.test.ts` runs a real `vite build` |
| Mainnet deploy was rejected: needed 0.0658 USDC available, cost about 0.03 | The node reserves max gas times price; topped up the deployer | n/a |
| A local Anvil fork of Arc cannot do USDC transfers | Verified contract behaviour on the real testnet instead | n/a |

Unit tests passing was never treated as acceptance: the bugs above that mattered (wrong field, wrong network, wrong manifest) only appeared when running the real server, the real chain or a real production build.
