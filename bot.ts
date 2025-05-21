import { Octokit } from "@octokit/rest";
import { getMetadataAccount } from "./helpers/metadata";
import { decodeMetadata } from "./helpers/metadata";
import { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { DST_PROGRAM_ID, findDSTInfoAddress } from "@thevault/dst";
import _ from "lodash";
import { directorParser, findDirectorAddress } from "@thevault/directed-stake";
import { dstInfoParser } from "./helpers/dstInfoParser";
import { SANCTUM_PROGRAM_ID, STAKE_POOL_PROGRAM_ID } from "./constants";
import { getStakePoolAccounts, StakePool } from "@solana/spl-stake-pool";

const saveDataToGitHub = async (
  path: string,
  data: string,
  timestamp: number
) => {
  const octokit = new Octokit({
    auth: process.env.G_TOKEN,
  });

  const owner = "SolanaVault";
  const repo = "vault-lst-list-generator";
  const content = Buffer.from(data).toString("base64");

  try {
    // Get the SHA of the current file
    const result = await octokit.request(
      `GET /repos/${owner}/${repo}/contents/${path}`,
      {
        owner,
        repo,
        file_path: path,
        branch: "main",
      }
    );

    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message: `Add data for timestamp ${timestamp}`,
      content,
      sha: result.data.sha,
    });
    console.log(`Data saved to GitHub at ${path}`);
  } catch (error) {
    console.error(`Failed to save data to GitHub: ${error}`);
  }
};

const getTokenMetadatasFromChain = async (
  connection: Connection,
  mints: PublicKey[]
) => {
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
            // Do nothing
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
    .map((stakePool) => stakePool?.account.data)
    .filter((account) => account?.accountType === 1) as StakePool[];

  // Append metadata for each
  const mints = lsts.map((lst) => lst.poolMint);
  const metadata = await getTokenMetadatasFromChain(connection, mints);

  return lsts.map((lst, index) => {
    return { ...lst, metadata: metadata?.[index] };
  });
};

const run = async () => {
  const connection = new Connection(process.env.RPC_URL!);

  // Get all DSTs
  const data = await getLstList(connection);
  await saveDataToGitHub("lst-list.json", data, Date.now());

  // Get all Stake pool program LSTs
  const stakePoolProgramLsts = await getStakePoolProgramLsts(
    connection,
    STAKE_POOL_PROGRAM_ID
  );
  await saveDataToGitHub(
    "stakepool-lists.json",
    JSON.stringify(stakePoolProgramLsts),
    Date.now()
  );

  // Get all sanctum program LSTs
  const sanctumProgramLsts = await getStakePoolProgramLsts(
    connection,
    SANCTUM_PROGRAM_ID
  );
  await saveDataToGitHub(
    "sanctum-lists.json",
    JSON.stringify(sanctumProgramLsts),
    Date.now()
  );
};

run();
