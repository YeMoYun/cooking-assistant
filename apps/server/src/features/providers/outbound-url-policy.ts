import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { ProviderUrlValidation } from '@xiaochu/shared';

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type ResolveProviderHost = (
  hostname: string,
) => Promise<readonly ResolvedAddress[]>;

export interface OutboundUrlPolicyOptions {
  readonly allowLoopbackHttp?: boolean;
  readonly resolveHost?: ResolveProviderHost;
}

export interface ResourceUrlValidation {
  readonly normalizedUrl: string;
  readonly origin: string;
  readonly developmentLoopback: false;
}

export class OutboundUrlPolicyError extends Error {
  constructor(
    public readonly code:
      | 'invalid_provider_url'
      | 'provider_dns_failed'
      | 'unsafe_provider_url',
    message: string,
  ) {
    super(message);
    this.name = 'OutboundUrlPolicyError';
  }
}

const ipv4DenyList = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  ipv4DenyList.addSubnet(network, prefix, 'ipv4');
}

const ipv6DenyList = new BlockList();
for (const [network, prefix] of [
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  ipv6DenyList.addSubnet(network, prefix, 'ipv6');
}

const METADATA_HOSTS = new Set([
  'instance-data',
  'instance-data.ec2.internal',
  'metadata',
  'metadata.azure.internal',
  'metadata.google.internal',
]);

const normalizeHostname = (hostname: string): string => {
  const normalized = hostname
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\.$/u, '');
  return normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;
};

const defaultResolver: ResolveProviderHost = async (hostname) => {
  const addresses = await dnsLookup(hostname, {
    all: true,
    order: 'verbatim',
  });
  return addresses.map((address) => {
    if (address.family !== 4 && address.family !== 6) {
      throw new Error('DNS returned an unknown address family');
    }
    return { address: address.address, family: address.family };
  });
};

const isIpv4Loopback = (address: string): boolean => (
  address.split('.')[0] === '127'
);

const isLoopbackAddress = (address: string, family: 4 | 6): boolean => (
  family === 4
    ? isIpv4Loopback(address)
    : address.toLocaleLowerCase('en-US') === '::1'
);

const isExplicitLoopbackHostname = (hostname: string): boolean => {
  const normalized = normalizeHostname(hostname);
  if (normalized === 'localhost') {
    return true;
  }
  const family = isIP(normalized);
  return family === 4
    ? isIpv4Loopback(normalized)
    : family === 6 && normalized === '::1';
};

const isGlobalIpv6 = (address: string): boolean => {
  const normalized = address.toLocaleLowerCase('en-US');
  const firstGroup = normalized.split(':')[0];
  if (firstGroup === undefined || firstGroup.length === 0) {
    return false;
  }
  const first = Number.parseInt(firstGroup, 16);
  return Number.isFinite(first) && (first & 0xe000) === 0x2000;
};

const validatePublicAddress = (
  resolved: ResolvedAddress,
  developmentLoopback: boolean,
): void => {
  const detectedFamily = isIP(resolved.address);
  if (detectedFamily !== resolved.family) {
    throw new OutboundUrlPolicyError(
      'unsafe_provider_url',
      'Provider DNS returned an invalid address',
    );
  }

  if (developmentLoopback) {
    if (isLoopbackAddress(resolved.address, resolved.family)) {
      return;
    }
    throw new OutboundUrlPolicyError(
      'unsafe_provider_url',
      'Development provider host must resolve only to loopback addresses',
    );
  }

  const denied = resolved.family === 4
    ? ipv4DenyList.check(resolved.address, 'ipv4')
    : !isGlobalIpv6(resolved.address)
      || ipv6DenyList.check(resolved.address, 'ipv6');
  if (denied) {
    throw new OutboundUrlPolicyError(
      'unsafe_provider_url',
      'Provider host resolves to a non-public address',
    );
  }
};

export class OutboundUrlPolicy {
  readonly #allowLoopbackHttp: boolean;
  readonly #resolveHost: ResolveProviderHost;

  constructor(options: OutboundUrlPolicyOptions = {}) {
    this.#allowLoopbackHttp = options.allowLoopbackHttp ?? false;
    this.#resolveHost = options.resolveHost ?? defaultResolver;
  }

  async validateBaseUrl(input: string): Promise<ProviderUrlValidation> {
    if (
      input.length === 0
      || input.length > 2_048
      || /[\\\u0000-\u001f\u007f]/u.test(input)
      || input !== input.trim()
    ) {
      throw new OutboundUrlPolicyError(
        'invalid_provider_url',
        'Provider Base URL is invalid',
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(input);
    } catch {
      throw new OutboundUrlPolicyError(
        'invalid_provider_url',
        'Provider Base URL is invalid',
      );
    }

    const hostname = normalizeHostname(parsed.hostname);
    const developmentLoopback = parsed.protocol === 'http:'
      && this.#allowLoopbackHttp
      && isExplicitLoopbackHostname(hostname);
    if (
      (parsed.protocol !== 'https:' && !developmentLoopback)
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.search.length > 0
      || parsed.hash.length > 0
      || hostname.length === 0
      || METADATA_HOSTS.has(hostname)
      || hostname.endsWith('.metadata.google.internal')
    ) {
      throw new OutboundUrlPolicyError(
        'unsafe_provider_url',
        'Provider Base URL is not allowed',
      );
    }

    const literalFamily = isIP(hostname);
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = literalFamily === 4 || literalFamily === 6
        ? [{ address: hostname, family: literalFamily }]
        : await this.#resolveHost(hostname);
    } catch (error) {
      if (error instanceof OutboundUrlPolicyError) {
        throw error;
      }
      throw new OutboundUrlPolicyError(
        'provider_dns_failed',
        'Provider host could not be resolved',
      );
    }
    if (addresses.length === 0) {
      throw new OutboundUrlPolicyError(
        'provider_dns_failed',
        'Provider host could not be resolved',
      );
    }
    addresses.forEach((address) => {
      validatePublicAddress(address, developmentLoopback);
    });

    const path = parsed.pathname.replace(/\/+$/u, '');
    const authorityHost = literalFamily === 6 ? `[${hostname}]` : hostname;
    const normalizedOrigin = `${parsed.protocol}//${authorityHost}${
      parsed.port.length === 0 ? '' : `:${parsed.port}`
    }`;
    const normalizedBaseUrl = path.length === 0 || path === '/'
      ? normalizedOrigin
      : `${normalizedOrigin}${path}`;
    return {
      normalizedBaseUrl,
      origin: normalizedOrigin,
      developmentLoopback,
    };
  }

  async validateResourceUrl(input: string): Promise<ResourceUrlValidation> {
    if (
      input.length === 0
      || input.length > 4_096
      || /[\\\u0000-\u001f\u007f]/u.test(input)
      || input !== input.trim()
    ) {
      throw new OutboundUrlPolicyError(
        'invalid_provider_url',
        'Resource URL is invalid',
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(input);
    } catch {
      throw new OutboundUrlPolicyError(
        'invalid_provider_url',
        'Resource URL is invalid',
      );
    }

    const hostname = normalizeHostname(parsed.hostname);
    if (
      parsed.protocol !== 'https:'
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.hash.length > 0
      || hostname.length === 0
      || METADATA_HOSTS.has(hostname)
      || hostname.endsWith('.metadata.google.internal')
    ) {
      throw new OutboundUrlPolicyError(
        'unsafe_provider_url',
        'Resource URL is not allowed',
      );
    }

    const literalFamily = isIP(hostname);
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = literalFamily === 4 || literalFamily === 6
        ? [{ address: hostname, family: literalFamily }]
        : await this.#resolveHost(hostname);
    } catch (error) {
      if (error instanceof OutboundUrlPolicyError) throw error;
      throw new OutboundUrlPolicyError(
        'provider_dns_failed',
        'Resource host could not be resolved',
      );
    }
    if (addresses.length === 0) {
      throw new OutboundUrlPolicyError(
        'provider_dns_failed',
        'Resource host could not be resolved',
      );
    }
    addresses.forEach((address) => validatePublicAddress(address, false));

    const authorityHost = literalFamily === 6 ? `[${hostname}]` : hostname;
    const origin = `https://${authorityHost}${parsed.port.length === 0 ? '' : `:${parsed.port}`}`;
    parsed.hostname = hostname;
    return {
      normalizedUrl: parsed.toString(),
      origin,
      developmentLoopback: false,
    };
  }

  assertConnectionAddress(
    resolved: ResolvedAddress,
    developmentLoopback: boolean,
  ): void {
    validatePublicAddress(resolved, developmentLoopback);
  }
}

export const providerHostname = (url: string): string => (
  normalizeHostname(new URL(url).hostname)
);
