import { Octokit } from "@octokit/rest";
import { getMetadataAccount } from "./helpers/metadata";
import { decodeMetadata } from "./helpers/metadata";
import { Connection, Keypair, StakeProgram } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { DST_PROGRAM_ID, findDSTInfoAddress } from "@thevault/dst";
import _ from "lodash";
import { directorParser, findDirectorAddress } from "@thevault/directed-stake";
import { dstInfoParser } from "./helpers/dstInfoParser";
import { SANCTUM_PROGRAM_ID, SANCTUM_SPL_MULTI_PROGRAM_ID, STAKE_POOL_PROGRAM_ID } from "./constants";
import { getStakePoolAccounts, StakePool } from "@solana/spl-stake-pool";
import { saveDataToGitHub } from "./helpers/github";
import BigNumber from "bignumber.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { LiquidUnstaker } from "./helpers/liquidUnstaker";
import IDL from "./helpers/liquidUnstaker.json";
import { fetchSafeJson, isSafeHttpsUrl } from "./helpers/safeUrl";

const LIQUID_UNSTAKER_POOL_ACCOUNT = new PublicKey(
  "9nyw5jxhzuSs88HxKJyDCsWBZMhxj2uNXsFcyHF5KBAb"
);

let tokenListCache: any;
const getOldTokenMetadata = async () => {
  if (tokenListCache) {
    return tokenListCache;
  }

  const tokenList = await fetch(
    "https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json"
  );
  const tokenListData = await tokenList.json();
  tokenListCache = tokenListData;
  return tokenListData;
};

const getTokenMetadatasFromChain = async (
  connection: Connection,
  mints: PublicKey[]
) => {
  const oldMetadata = await getOldTokenMetadata();

  const chunks = _.chunk(mints, 100);
  const results: (Record<string, unknown> | undefined)[] = [];
  for (const chunk of chunks) {
    try {
      const metadataAccounts = chunk.map((_mint) =>
        getMetadataAccount(_mint.toString())
      );
      const metadataAccountInfos = await connection.getMultipleAccountsInfo(
        metadataAccounts.map(
          (_metadataAccount) => new PublicKey(_metadataAccount)
        )
      );
      const infos = await connection.getMultipleParsedAccounts(chunk);

      // finally, decode metadata
      const result = await Promise.all(
        metadataAccountInfos.map(async (_metadataAccountInfo, _index) => {
          try {
            const data = decodeMetadata(_metadataAccountInfo!.data);
            const info = infos.value[_index];
            if (!isSafeHttpsUrl(data.data.uri)) {
              console.warn(
                `Skipping metadata for ${chunk[_index].toString()}: unsafe URI`
              );
              return undefined;
            }

            const meta = await fetchSafeJson<Record<string, unknown>>(
              data.data.uri
            );
            if (!isSafeHttpsUrl(meta.image)) {
              console.warn(
                `Skipping metadata for ${chunk[_index].toString()}: invalid image URL`
              );
              return undefined;
            }

            return {
              ...data,
              ...meta,
              data: data.data,
              image: meta.image,
              // @ts-expect-error ignore
              decimals: info?.data?.parsed?.info?.decimals,
            };
          } catch (e) {
            // Try old metadata
            const _oldMetadata = oldMetadata.tokens.find(
              (token: any) => token.address === chunk[_index].toString()
            ) as {
              chainId: number;
              address: string;
              symbol: string;
              name: string;
              decimals: number;
              logoURI: string;
              tags: string[];
              extensions: {
                facebook: string;
                twitter: string;
                website: string;
              };
            };
            if (_oldMetadata && isSafeHttpsUrl(_oldMetadata.logoURI)) {
              return {
                ..._oldMetadata,
                image: _oldMetadata.logoURI,
              };
            }
          }
        })
      );
      console.log(result);
      results.push(...result);
    } catch (e) {
      console.error("Metadata error");
      console.error(e);
      // return null;
    }
  }

  return results;
};

const getLstList = async (connection: Connection) => {
  const info = (await connection.getProgramAccounts(DST_PROGRAM_ID))
    .map((account) => {
      const data = dstInfoParser.parse(Buffer.from(account.account.data));
      return {
        address: account.pubkey,
        data: data,
      };
    })
    .map((account) => {
      const dstAddress = findDSTInfoAddress(account.data.tokenMint);
      const directorAddress = findDirectorAddress(dstAddress);
      return { ...account, directorAddress };
    });

  // batch call on director addresses
  const directors = (
    await connection.getMultipleAccountsInfo(
      info.map((account) => account.directorAddress)
    )
  ).map((account, i) => {
    if (!account) {
      return undefined;
    }

    const data = directorParser.parse(Buffer.from(account.data));
    return {
      address: info[i].directorAddress,
      data: data,
    };
  });

  // Merge arrays
  const merged = info.flatMap((account) => {
    const director = directors.find(
      (director) =>
        director?.address.toString() === account.directorAddress.toString()
    );
    if (!director) {
      console.warn(
        `Skipping DST ${account.address.toString()}: director account not found`
      );
      return [];
    }

    return [{ ...account, director: director.data }];
  });

  // Metadata append
  const data = await Promise.all(
    _.chunk(merged, 100).map(async (accounts) => {
      const mints = accounts.map((account) => account.data.tokenMint);
      const metadata = await getTokenMetadatasFromChain(connection, mints);
      return accounts.flatMap((account, index) => {
        const tokenMetadata = metadata[index];
        if (!tokenMetadata) {
          console.warn(
            `Skipping DST ${account.address.toString()}: safe metadata not found`
          );
          return [];
        }

        return [
          {
            ...account,
            metadata: { ...tokenMetadata, createdOn: undefined },
          },
        ];
      });
    })
  );

  return JSON.stringify(
    data.flat(),
    (key, value) => (typeof value === "bigint" ? value.toString() : value), // return everything else unchanged
    2
  );
};

const getStakePoolProgramLsts = async (
  connection: Connection,
  stakePoolProgramId: PublicKey
) => {
  // @ts-expect-error ignore
  const data = await getStakePoolAccounts(connection, stakePoolProgramId);

  if (!data) {
    return [];
  }

  const lsts = data
    .map((stakePool) => ({
      accountType: 0,
      ...stakePool?.account.data,
      stakePool: stakePool?.pubkey,
    }))
    .filter((account) => account?.accountType === 1) as StakePool[];

  // Append metadata for each
  const mints = lsts.map((lst) => lst.poolMint);
  const metadata = await getTokenMetadatasFromChain(connection, mints);

  return lsts.map((lst, index) => {
    return {
      ...lst,
      programId: stakePoolProgramId.toString(),
      metadata: metadata[index],
    };
  });
};

const getVLPAPY = async () => {
  const response = await fetch(
    `https://api.dune.com/api/v1/query/5304965/results?limit=1000&sort_by=block_slot+desc`,
    {
      headers: {
        "x-dune-api-key": process.env.DUNE_API_KEY!,
      },
    }
  );
  const data = await response.json();
  if (!data.result?.rows) {
    console.error("Dune VLP APY response:", JSON.stringify(data, null, 2));
    throw new Error("Dune VLP APY query returned no results");
  }
  const row = data.result.rows.sort(
    (a: any, b: any) => b.block_slot - a.block_slot
  )[0];
  return {
    apy: row.vlp_7_days_apy as number,
    fullResponse: data,
  };
};

const getStakePoolAPY = async () => {
  const response = await fetch(
    `https://api.dune.com/api/v1/query/3936523/results?limit=1000&sort_by=block_date+desc`,
    {
      headers: {
        "x-dune-api-key": process.env.DUNE_API_KEY!,
      },
    }
  );
  const data = await response.json();
  return {
    fullResponse: data,
  };
};

const run = async () => {
  const connection = new Connection(process.env.RPC_URL!);

  const files = [];

  // Get VLP price
  console.log("Getting VLP apy");
  try {
    const vlpData = await getVLPAPY();
    files.push({
      path: "vlp-apy.json",
      content: JSON.stringify({ apy: vlpData.apy }, null, 2),
    });
    files.push({
      path: "dune.json",
      content: JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          ...vlpData.fullResponse,
        },
        null,
        2
      ),
    });
  } catch (e) {
    console.error("Skipping VLP APY update:", e);
  }

  // Get Stake Pool APY
  console.log("Getting Stake Pool APY");
  try {
    const stakePoolData = await getStakePoolAPY();
    files.push({
      path: "dune-stakepool.json",
      content: JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          ...stakePoolData.fullResponse,
        },
        null,
        2
      ),
    });
  } catch (e) {
    console.error("Skipping Stake Pool APY update:", e);
  }

  // Get all DSTs
  console.log("Getting DSTs");
  const data = await getLstList(connection);
  files.push({
    path: "lst-list.json",
    content: data,
  });

  // Get all Stake pool program LSTs
  console.log("Getting Stake pool program LSTs");
  const stakePoolProgramLsts = await getStakePoolProgramLsts(
    connection,
    STAKE_POOL_PROGRAM_ID
  );
  files.push({
    path: "stakepool-lists.json",
    content: JSON.stringify(stakePoolProgramLsts, null, 2),
  });

  // Get all sanctum program LSTs
  console.log("Getting Sanctum program LSTs");
  const sanctumProgramLsts = await getStakePoolProgramLsts(
    connection,
    SANCTUM_PROGRAM_ID
  );

  // Get all Sanctum SPL Multi program LSTs (e.g. hyloSOL)
  console.log("Getting Sanctum SPL Multi program LSTs");
  const sanctumSplMultiLsts = await getStakePoolProgramLsts(
    connection,
    SANCTUM_SPL_MULTI_PROGRAM_ID
  );

  files.push({
    path: "sanctum-lists.json",
    content: JSON.stringify([...sanctumProgramLsts, ...sanctumSplMultiLsts], null, 2),
  });

  console.log("Saving data to GitHub");
  await saveDataToGitHub(files);
};

run();
