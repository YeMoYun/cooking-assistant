/// <reference lib="webworker" />

import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { NetworkOnly } from 'workbox-strategies'

declare const self: ServiceWorkerGlobalScope & {
  readonly __WB_MANIFEST: Array<string | { readonly revision: string | null; readonly url: string }>
}

const NETWORK_METHODS = ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT'] as const
const networkOnly = new NetworkOnly()

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

for (const method of NETWORK_METHODS) {
  registerRoute(
    ({ url }) => url.origin !== self.location.origin,
    networkOnly,
    method,
  )
  registerRoute(
    ({ url }) => (
      url.origin === self.location.origin
      && (url.pathname === '/api' || url.pathname.startsWith('/api/'))
    ),
    networkOnly,
    method,
  )
}

registerRoute(new NavigationRoute(
  createHandlerBoundToURL('index.html'),
  {
    allowlist: [/^\/(?!api(?:\/|$))/u],
    denylist: [/^\/api(?:\/|$)/u],
  },
))
