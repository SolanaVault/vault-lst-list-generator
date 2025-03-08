import { Octokit } from "@octokit/rest";
import { getMetadataAccount } from "./helpers/metadata";
import { decodeMetadata } from "./helpers/metadata";
import { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

const saveDataToGitHub = async (
  data: Record<string, any>,
  timestamp: number
) => {
  const octokit = new Octokit({
    auth: process.env.G_TOKEN,
  });

  const owner = "saberdao";
  const repo = "lp-token-list-v2";
  const path = `token-list.json`;
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString("base64");

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

const getTokenMetadataFromChain = async (
  connection: Connection,
  mint: PublicKey
) => {
  try {
    const metadataAccount = await getMetadataAccount(mint.toString());
    const metadataAccountInfo = await connection.getAccountInfo(
      new PublicKey(metadataAccount)
    );
    console.log(metadataAccountInfo);

    // finally, decode metadata
    const data = decodeMetadata(metadataAccountInfo!.data);
    const info = await connection.getParsedAccountInfo(mint);

    const meta = (await (await fetch(data.data.uri)).json()) as {
      image: string;
    };
    const result = {
      ...data,
      ...meta,
      // @ts-expect-error ignore
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      decimals: info.value?.data.parsed.info.decimals, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
    };
    console.log(result);
    return result;
  } catch (e) {
    console.error(e);
    return null;
  }
};

const run = async () => {
  const poolsData = await (
    await fetch(
      "https://raw.githubusercontent.com/saberdao/saber-registry-dist/master/data/pools-info.mainnet.json"
    )
  ).json();
  const pools = poolsData.pools;

  const data: Record<string, any> = {};

  // For each pool, get the latest full candle and the fees
  for (const pool of pools) {
    const lpTokenAddress = pool.lpToken.address;
    console.log(lpTokenAddress);

    const connection = new Connection(process.env.RPC_URL!);
    const metadata = await getTokenMetadataFromChain(
      connection,
      new PublicKey(lpTokenAddress)
    );
    console.log(metadata);

    if (!metadata) {
      continue;
    }

    const token = {
      address: lpTokenAddress,
      name: pool.lpToken.name,
      symbol: pool.lpToken.symbol,
      decimals: metadata?.decimals,
      chainId: 101,
      logoURI: metadata?.image,
    };

    data[token.address] = token;
  }

  console.log(data);

  // Save in github with the unix timestamp as the filename
  await saveDataToGitHub(data, Date.now());
};

run();
