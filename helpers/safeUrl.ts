import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { get as httpsGet } from "node:https";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";

export const MAX_METADATA_RESPONSE_BYTES = 1024 * 1024;

const blockedAddresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

const stripIpv6Brackets = (hostname: string) =>
  hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

export const isSafeHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);
    const hostname = stripIpv6Brackets(url.hostname).toLowerCase();

    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      hostname.length > 0 &&
      hostname !== "localhost" &&
      !hostname.endsWith(".localhost") &&
      isIP(hostname) === 0
    );
  } catch {
    return false;
  }
};

export const isPublicIpAddress = (address: string) => {
  const family = isIP(address);
  return (
    family !== 0 &&
    !blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6")
  );
};

type ResolveAddresses = (
  hostname: string,
  options: LookupAllOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: LookupAddress[]
  ) => void
) => void;

const resolveAddresses: ResolveAddresses = (hostname, options, callback) => {
  dnsLookup(hostname, options, callback);
};

export const createSafeLookup = (
  resolver: ResolveAddresses = resolveAddresses
): LookupFunction => {
  return (hostname, options, callback) => {
    resolver(
      hostname,
      {
        all: true,
        family: options.family,
        hints: options.hints,
        verbatim: true,
      },
      (error, addresses) => {
        if (error) {
          callback(error, []);
          return;
        }

        const normalizedAddresses = addresses.map(({ address }) => ({
          address,
          family: isIP(address),
        }));
        if (
          normalizedAddresses.length === 0 ||
          normalizedAddresses.some(
            ({ address, family }) =>
              family === 0 || !isPublicIpAddress(address)
          )
        ) {
          const unsafeAddressError = new Error(
            `Blocked unsafe address resolved for ${hostname}`
          ) as NodeJS.ErrnoException;
          unsafeAddressError.code = "EACCES";
          callback(unsafeAddressError, []);
          return;
        }

        if (options.all) {
          callback(null, normalizedAddresses);
          return;
        }

        const [{ address, family }] = normalizedAddresses;
        callback(null, address, family);
      }
    );
  };
};

const isJsonContentType = (value: string | undefined) => {
  const mediaType = value?.split(";", 1)[0].trim().toLowerCase();
  return (
    mediaType === "application/json" ||
    (mediaType?.startsWith("application/") === true &&
      mediaType.endsWith("+json"))
  );
};

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export const MAX_METADATA_REDIRECTS = 5;

export const validateRedirectTarget = (
  currentUrl: string,
  locationHeader: string | undefined
): string => {
  if (!locationHeader) {
    throw new Error("Redirect response is missing a location header");
  }

  let target: URL;
  try {
    target = new URL(locationHeader, currentUrl);
  } catch {
    throw new Error("Redirect response has an invalid location header");
  }

  if (!isSafeHttpsUrl(target.href)) {
    throw new Error("Unsafe metadata redirect URL");
  }

  return target.href;
};

export const parseJsonBody = async (
  body: AsyncIterable<Uint8Array | string>,
  contentType: string | undefined,
  contentLength: string | undefined,
  maxBytes = MAX_METADATA_RESPONSE_BYTES
): Promise<unknown> => {
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) {
      throw new Error("Metadata response has an invalid content length");
    }
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw new Error("Metadata response has an invalid content length");
    }
    if (declaredBytes > maxBytes) {
      throw new Error("Metadata response exceeds the size limit");
    }
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of body) {
    const buffer =
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    receivedBytes += buffer.byteLength;
    if (receivedBytes > maxBytes) {
      throw new Error("Metadata response exceeds the size limit");
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks, receivedBytes).toString("utf8");
  if (isJsonContentType(contentType)) {
    return JSON.parse(text);
  }

  // Many hosts serve JSON as text/plain or application/octet-stream — sniff it.
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Metadata response is not valid JSON");
  }
};

type SafeFetchResult<T> = { json: T } | { redirect: string };

const fetchSafeSingleHop = <T = unknown>(
  value: string,
  signal: AbortSignal,
  resolver: ResolveAddresses
): Promise<SafeFetchResult<T>> => {
  return new Promise<SafeFetchResult<T>>((resolve, reject) => {
    const request = httpsGet(
      new URL(value),
      {
        headers: { accept: "application/json" },
        lookup: createSafeLookup(resolver),
        signal,
      },
      (response) => {
        if (
          response.statusCode !== undefined &&
          REDIRECT_STATUS_CODES.has(response.statusCode)
        ) {
          response.resume();
          try {
            resolve({
              redirect: validateRedirectTarget(
                value,
                response.headers.location
              ),
            });
          } catch (error) {
            reject(error);
          }
          return;
        }

        if (
          response.statusCode === undefined ||
          response.statusCode < 200 ||
          response.statusCode >= 300
        ) {
          response.resume();
          reject(
            new Error(
              `Metadata request failed: ${response.statusCode ?? "unknown"}`
            )
          );
          return;
        }

        void parseJsonBody(
          response,
          response.headers["content-type"],
          response.headers["content-length"]
        ).then(
          (body) => resolve({ json: body as T }),
          (error) => {
            response.destroy();
            reject(error);
          }
        );
      }
    );

    request.on("error", reject);
  });
};

export const fetchSafeJson = async <T = unknown>(
  value: string,
  timeoutMs = 10_000,
  resolver: ResolveAddresses = resolveAddresses
): Promise<T> => {
  if (!isSafeHttpsUrl(value)) {
    throw new Error("Unsafe metadata URL");
  }

  // One deadline covers the whole redirect chain.
  const signal = AbortSignal.timeout(timeoutMs);
  let currentUrl = value;

  for (let hop = 0; ; hop++) {
    const result = await fetchSafeSingleHop<T>(currentUrl, signal, resolver);
    if ("json" in result) {
      return result.json;
    }

    if (hop >= MAX_METADATA_REDIRECTS) {
      throw new Error("Metadata request exceeded the redirect limit");
    }

    // validateRedirectTarget already enforced isSafeHttpsUrl on the target,
    // and the request below re-applies createSafeLookup to its new hostname.
    currentUrl = result.redirect;
  }
};

const METADATA_FETCH_ATTEMPTS = 3;
const METADATA_FETCH_BACKOFF_MS = 800;

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const fetchSafeJsonWithRetry = async <T = unknown>(
  value: string,
  timeoutMs = 10_000,
  resolver: ResolveAddresses = resolveAddresses
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < METADATA_FETCH_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(METADATA_FETCH_BACKOFF_MS);
    }
    try {
      return await fetchSafeJson<T>(value, timeoutMs, resolver);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};
