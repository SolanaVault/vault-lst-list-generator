import { Octokit } from "@octokit/rest";
import { getMetadataAccount } from "./helpers/metadata";
import { decodeMetadata } from "./helpers/metadata";
import { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import {
  DST_PROGRAM_ID,
  dstInfoParser,
  findDSTInfoAddress,
} from "@thevault/dst";
import _ from "lodash";
import { directorParser, findDirectorAddress } from "@thevault/directed-stake";

const saveDataToGitHub = async (data: string, timestamp: number) => {
  const octokit = new Octokit({
    auth: process.env.G_TOKEN,
  });

  const owner = "SolanaVaults";
  const repo = "lst-list-generator";
  const path = `lst-list.json`;
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
  try {
    const metadataAccounts = mints.map((_mint) =>
      getMetadataAccount(_mint.toString())
    );
    const metadataAccountInfos = await connection.getMultipleAccountsInfo(
      metadataAccounts.map(
        (_metadataAccount) => new PublicKey(_metadataAccount)
      )
    );
    const infos = await connection.getMultipleParsedAccounts(mints);

    // finally, decode metadata
    const result = await Promise.all(
      metadataAccountInfos.map(async (_metadataAccountInfo, _index) => {
        const data = decodeMetadata(_metadataAccountInfo!.data);
        const info = infos.value[_index];
        const meta = (await (await fetch(data.data.uri)).json()) as {
          image: string;
        };
        return {
          ...data,
          ...meta,
          // @ts-expect-error ignore
          decimals: info?.data.parsed.info.decimals,
        };
      })
    );
    console.log(result);
    return result;
  } catch (e) {
    console.error(e);
    return null;
  }
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
    data,
    (key, value) => (typeof value === "bigint" ? value.toString() : value), // return everything else unchanged
    2
  );
};

const run = async () => {
  const connection = new Connection(process.env.RPC_URL!);
  const data = await getLstList(connection);
  console.log(data);

  // await saveDataToGitHub(data, Date.now());
};

run();
