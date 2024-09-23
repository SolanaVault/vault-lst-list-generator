import { Octokit } from "@octokit/rest";

type BirdeyeOHLCVResult = {
    data: {
        items: {
            address: string;
            unixTime: number;
            v: number;
            c: number;
            h: number;
            l: number;
            o: number;
            type: string;
        }[]
    }
}

const saveDataToGitHub = async (data: Record<string, any>, timestamp: number) => {
    const octokit = new Octokit({
        auth: process.env.G_TOKEN,
    });

    const owner = 'saberdao';
    const repo = 'birdeye-data';
    const path = `volume.json`;
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');

    try {
        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path,
            message: `Add data for timestamp ${timestamp}`,
            content,
        });
        console.log(`Data saved to GitHub at ${path}`);
    } catch (error) {
        console.error(`Failed to save data to GitHub: ${error}`);
    }
};

const getLatestFullCandle = async (poolAddress: string) => {
    const now = Math.floor(Date.now() / 1000);
    const hour = now - 86400 * 3;
    const result = await fetch(`https://public-api.birdeye.so/defi/ohlcv/pair?address=${poolAddress}&type=1D&time_to=${now}&time_from=${hour}`, {
        headers: {
            'X-API-KEY': process.env.BIRDEYE_API_KEY!
        }
    })
    const data: BirdeyeOHLCVResult = await result.json();

    // Take the most recent candle that's over 24 hours old
    const candle = data.data.items.sort((a, b) => b.unixTime - a.unixTime).find((c) => c.unixTime < now - 86400);
    return candle;
}

const run = async () => {
    const poolsData = await (await fetch('https://raw.githubusercontent.com/saber-hq/saber-registry-dist/master/data/pools-info.mainnet.json')).json();
    const pools = poolsData.pools;

    const data: Record<string, any> = {};

    // For each pool, get the latest full candle and the fees
    await Promise.all(pools.map(async (pool: any) => {
        const candle = await getLatestFullCandle(pool.swap.config.swapAccount);
        if (candle) {
        const fees = Number(pool.swap.state.fees.trade.numeratorStr) / Number(pool.swap.state.fees.trade.denominatorStr);
        const feesUsd = fees * candle.v;
        data[candle.address] = {
            c: candle.c,
            o: candle.o,
            h: candle.h,
            l: candle.l,
            v: candle.v,
            fees,
            feesUsd
            }
        }
    }));

    // Save in github with the unix timestamp as the filename
    await saveDataToGitHub(data, Date.now());
};

run();