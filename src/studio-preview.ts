/**
 * Arc Studio preview detection.
 * Studio's tracing + console-capture hooks forward wallet/RPC traffic to the parent frame for Studio's Tracing and
 * Console panels. They must only ever run inside the Studio preview, never on the public site, and never when some
 * other page frames this app.
 */
export const STUDIO_ORIGIN = 'https://studio.arc.io'

function parentOrigin(): string | undefined {
  try {
    const anc = window.location.ancestorOrigins
    if (anc && anc.length > 0) return anc[0]
  } catch { /* sandboxed */ }
  return undefined
}

const framed = (() => { try { return window.self !== window.top } catch { return true } })()

/** Framed directly by https://studio.arc.io (the Studio preview). */
export const IN_STUDIO_PREVIEW: boolean = framed && parentOrigin() === STUDIO_ORIGIN

/** Framed by any other page: we refuse to render the app (clickjacking guard for hosts that can't send headers). */
export const FRAMED_ELSEWHERE: boolean = framed && !IN_STUDIO_PREVIEW
