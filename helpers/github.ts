import { Octokit } from "@octokit/rest";
// @ts-expect-error no types
import MultipleFiles from "octokit-commit-multiple-files";

const OctokitClass = Octokit.plugin(MultipleFiles);

export const saveDataToGitHub = async (
  files: {
    path: string;
    content: string;
  }[]
) => {
  const octokit = new OctokitClass({
    auth: process.env.G_TOKEN,
  });

  const owner = "SolanaVault";
  const repo = "vault-lst-list-generator";

  const changes = files.reduce((acc, file) => {
    acc[file.path] = Buffer.from(file.content).toString("base64");
    return acc;
  }, {} as Record<string, string>);

  try {
    const res = await octokit.createOrUpdateFiles({
      owner,
      repo,
      branch: "main",
      changes: [
        {
          message: `Add data for timestamp ${Date.now()}`,
          files: changes,
        },
      ],
    });
    console.log(res);
    console.log(`Data saved to GitHub at ${files[0].path}`);
  } catch (error) {
    console.error(`Failed to save data to GitHub: ${error}`);
  }
};
