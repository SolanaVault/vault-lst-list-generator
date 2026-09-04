// Restores token metadata from the previously published data files, so that a
// run with flaky metadata fetching does not permanently erase metadata that
// earlier runs had collected.
import { isSafeHttpsUrl } from "./safeUrl";

type PoolEntry = {
  poolMint?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
};

const getPoolMintKey = (entry: PoolEntry): string | undefined => {
  const poolMint = entry?.poolMint;
  if (poolMint === undefined || poolMint === null) {
    return undefined;
  }
  return String(poolMint);
};

export const restorePreviousMetadata = async (
  filePath: string,
  freshEntries: PoolEntry[]
): Promise<void> => {
  const previousUrl = `https://raw.githubusercontent.com/SolanaVault/vault-lst-list-generator/main/${filePath}`;

  let previousEntries: unknown;
  try {
    const response = await fetch(previousUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    previousEntries = await response.json();
  } catch (error) {
    console.error(
      `Could not read previous ${filePath}, continuing without restore:`,
      error
    );
    return;
  }

  if (!Array.isArray(previousEntries)) {
    console.error(
      `Previous ${filePath} is not an array, continuing without restore`
    );
    return;
  }

  const previousMetadata = new Map<string, unknown>();
  for (const entry of previousEntries as PoolEntry[]) {
    const poolMint = getPoolMintKey(entry);
    if (poolMint !== undefined && entry?.metadata) {
      previousMetadata.set(poolMint, entry.metadata);
    }
  }

  let restoredCount = 0;
  for (const entry of freshEntries) {
    const poolMint = getPoolMintKey(entry);
    if (poolMint === undefined || entry.metadata) {
      continue;
    }

    const previous = previousMetadata.get(poolMint);
    if (previous) {
      const metadata = previous as Record<string, unknown>;
      // Re-apply the current image policy to restored data: previously
      // published metadata may predate the safe-URL validation.
      if ("image" in metadata && !isSafeHttpsUrl(metadata.image)) {
        delete metadata.image;
      }
      entry.metadata = metadata;
      restoredCount++;
    }
  }

  console.log(`restored metadata for ${restoredCount} pools in ${filePath}`);
};
