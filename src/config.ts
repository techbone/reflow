/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 *
 * The active Arc chain (testnet or mainnet) is determined by VITE_REFLOW_NETWORK.
 * Ethereum mainnet is always included for ENS resolution.
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arcTestnet, arc } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'
import { resolveNetwork } from './lib/network'

// Resolve at module load — reads the same env key as the rest of the app.
const _net = resolveNetwork(
  typeof import.meta !== 'undefined' && import.meta.env
    ? (import.meta.env)
    : {}
)
const activeArcChain = _net.isMainnet ? arc : arcTestnet

// Pre-register the active Arc chain RPC URL so trace events show the correct name
registerChain(activeArcChain.id, activeArcChain.rpcUrls.default.http[0])

export const config = createConfig({
  chains:     [activeArcChain, mainnet], // mainnet needed for ENS resolution
  connectors: [injected()],
  transports: {
    [arc.id]:        http(),           // Arc Mainnet (5042)
    [arcTestnet.id]: http(),           // Arc Testnet (5042002)
    [mainnet.id]:    http(),           // Ethereum mainnet for ENS
  },
})
