/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arcTestnet } from 'viem/chains'
import { ACTIVE_CHAIN, WAGMI_CHAINS, arcMainnet } from './usdcmeter-config'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'

// Pre-register active chain RPC URL so trace events show chain name immediately
registerChain(ACTIVE_CHAIN.id, ACTIVE_CHAIN.rpcUrls.default.http[0])

export const config = createConfig({
  chains: WAGMI_CHAINS,
  connectors: [injected()],
  transports: {
    // Provide transports for all possible Arc chain IDs so the type is satisfied
    // regardless of which ACTIVE_CHAIN is selected at build time.
    [arcTestnet.id]: http(),
    [arcMainnet.id]: http(),
    [mainnet.id]: http(), // ENS resolution uses mainnet
  },
})
