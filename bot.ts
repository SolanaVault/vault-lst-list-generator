import { Octokit } from "@octokit/rest";
import { getMetadataAccount } from "./helpers/metadata";
import { decodeMetadata } from "./helpers/metadata";
import { Connection, Keypair, StakeProgram } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { DST_PROGRAM_ID, findDSTInfoAddress } from "@thevault/dst";
import _ from "lodash";
import { directorParser, findDirectorAddress } from "@thevault/directed-stake";
import { dstInfoParser } from "./helpers/dstInfoParser";
import { SANCTUM_PROGRAM_ID, STAKE_POOL_PROGRAM_ID } from "./constants";
import { getStakePoolAccounts, StakePool } from "@solana/spl-stake-pool";
import { saveDataToGitHub } from "./helpers/github";
import BigNumber from "bignumber.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { LiquidUnstaker } from "./helpers/liquidUnstaker";
import IDL from "./helpers/liquidUnstaker.json";

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
  const results = [];
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
            const meta = (await (await fetch(data.data.uri)).json()) as {
              image: string;
            };
            return {
              ...data,
              ...meta,
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
            if (_oldMetadata) {
              return {
                ..._oldMetadata,
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
  const merged = info.map((account) => {
    const director = directors.find(
      (director) =>
        director?.address.toString() === account.directorAddress.toString()
    );
    return { ...account, director: director?.data };
  });

  // Metadata append
  const data = await Promise.all(
    _.chunk(merged, 100).map(async (accounts) => {
      const mints = accounts.map((account) => account.data.tokenMint);
      const metadata = await getTokenMetadatasFromChain(connection, mints);
      return accounts.map((account, index) => {
        return {
          ...account,
          metadata: { ...metadata?.[index], createdOn: undefined },
        };
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
    return { ...lst, metadata: metadata?.[index] };
  });
};

const getVLPPrice = async (connection: Connection) => {
  const anchorWallet = new AnchorProvider(
    connection,
    new Wallet(new Keypair())
  );
  const program = new Program<LiquidUnstaker>(IDL as LiquidUnstaker, {
    ...anchorWallet,
    connection,
  });

  const [solVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("sol_vault"), LIQUID_UNSTAKER_POOL_ACCOUNT.toBuffer()],
    program.programId
  );

  const [lpMintPubkey] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint"), LIQUID_UNSTAKER_POOL_ACCOUNT.toBuffer()],
    program.programId
  );

  const data = await program.account.pool.fetch(LIQUID_UNSTAKER_POOL_ACCOUNT);

  const solVaultBalance = await connection.getBalance(solVault);
  const stakeAccounts = await connection.getParsedProgramAccounts(
    StakeProgram.programId,
    {
      commitment: "confirmed",
      filters: [
        {
          memcmp: {
            offset: 44,
            bytes: LIQUID_UNSTAKER_POOL_ACCOUNT.toBase58(),
          },
        },
      ],
    }
  );

  const balance =
    BigInt(solVaultBalance) +
    BigInt(
      stakeAccounts
        .reduce(
          (acc, stakeAccount) =>
            acc.plus(
              new BigNumber(
                // @ts-expect-error cannot find the types
                // eslint-disable-next-line
                stakeAccount.account.data.parsed.info.stake.delegation.stake
              )
            ),
          new BigNumber(0)
        )
        .toString()
    );

  return new BigNumber(balance ?? 0)
    .div(data.totalLpTokens.toString() ?? 0)
    .toFixed(8);
};

const run = async () => {
  const connection = new Connection(process.env.RPC_URL!);

  const files = [];

  // Get VLP price
  console.log("Getting VLP price");
  const history = await fetch(
    "https://raw.githubusercontent.com/SolanaVault/vault-lst-list-generator/main/vlp-price.json"
  );
  const historyData = await history.json();
  const vlpPrice = await getVLPPrice(connection);
  historyData[new Date().toISOString().split("T")[0]] = Number(vlpPrice);
  files.push({
    path: "vlp-price.json",
    content: JSON.stringify(historyData, null, 2),
  });

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
  files.push({
    path: "sanctum-lists.json",
    content: JSON.stringify(sanctumProgramLsts, null, 2),
  });

  console.log("Saving data to GitHub");
  await saveDataToGitHub(files);
};

run();
