/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arcTestnet } from 'viem/chains'
import { WAGMI_CHAINS, arcMainnet } from './usdcmeter-config'
import { injected } from 'wagmi/connectors'

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
