import { lookup as nodeLookup } from 'node:dns';
import type { LookupOptions } from 'node:dns';
import type { TcpNetConnectOpts } from 'node:net';
import { Agent, type Dispatcher } from 'undici';
import {
  OutboundUrlPolicy,
  providerHostname,
  type ResolvedAddress,
} from './outbound-url-policy.js';

type LookupFunction = NonNullable<TcpNetConnectOpts['lookup']>;

export interface SafeDispatcherOptions {
  readonly boundOrigin: string;
  readonly connectTimeoutMs?: number;
  readonly developmentLoopback: boolean;
  readonly policy: OutboundUrlPolicy;
  readonly targetUrl: string;
}

export interface SafeDispatcherHandle {
  readonly dispatcher: Dispatcher;
  close(): Promise<void>;
}

const normalizeLookupFamily = (family: number): 4 | 6 => {
  if (family === 4 || family === 6) {
    return family;
  }
  throw new Error('DNS returned an unknown address family');
};

const lookupAll = (
  hostname: string,
  options: LookupOptions,
): Promise<readonly ResolvedAddress[]> => new Promise((resolve, reject) => {
  nodeLookup(hostname, {
    all: true,
    family: options.family,
    hints: options.hints,
    order: 'verbatim',
  }, (error, addresses) => {
    if (error !== null) {
      reject(error);
      return;
    }
    try {
      resolve(addresses.map((address) => ({
        address: address.address,
        family: normalizeLookupFamily(address.family),
      })));
    } catch (mappingError) {
      reject(mappingError);
    }
  });
});

const createGuardedLookup = (
  expectedHostname: string,
  policy: OutboundUrlPolicy,
  developmentLoopback: boolean,
): LookupFunction => (hostname, options, callback) => {
  if (providerHostname(`https://${hostname}`) !== expectedHostname) {
    callback(new Error('Provider connection host changed'), '', 0);
    return;
  }

  void lookupAll(hostname, options).then((addresses) => {
    if (addresses.length === 0) {
      throw new Error('Provider host did not resolve');
    }
    for (const address of addresses) {
      policy.assertConnectionAddress(address, developmentLoopback);
    }

    if (options.all === true) {
      callback(null, [...addresses]);
      return;
    }
    const selected = addresses[0];
    if (selected === undefined) {
      callback(new Error('Provider host did not resolve'), '', 0);
      return;
    }
    callback(null, selected.address, selected.family);
  }).catch((error: unknown) => {
    callback(
      error instanceof Error
        ? new Error('Provider connection target was rejected', { cause: error })
        : new Error('Provider connection target was rejected'),
      '',
      0,
    );
  });
};

export const createSafeDispatcher = (
  options: SafeDispatcherOptions,
): SafeDispatcherHandle => {
  const target = new URL(options.targetUrl);
  if (target.origin !== options.boundOrigin) {
    throw new Error('Provider key is not bound to the request origin');
  }

  const agent = new Agent({
    connect: {
      lookup: createGuardedLookup(
        providerHostname(options.targetUrl),
        options.policy,
        options.developmentLoopback,
      ),
      timeout: options.connectTimeoutMs ?? 5_000,
    },
    connections: 1,
    pipelining: 1,
  });
  return {
    dispatcher: agent,
    close: async () => agent.close(),
  };
};
