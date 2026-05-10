// Snapshot of scripts/meteora-pools.json bundled for the client. Re-run
// `bun run init-pools:execute` and copy the manifest here when you add new
// pairs or change parameters.
//
// The /singlesided page reads this list to render pool cards and pre-fill
// pool params for DLMM single-sided deposits.

export interface MeteoraPool {
  name: string
  mint: string
  decimals: number
  poolAddress: string
  tokenX: string
  tokenY: string
  binStep: number
  feeBps: number
  activeId: number
  initialPriceYPerX: number
  /** True if the pool was already on-chain when the script ran. */
  alreadyExisted?: boolean
}

export const STACSOL_MINT = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'
export const STACSOL_DECIMALS = 9

export const METEORA_POOLS: MeteoraPool[] = [
  {
    name: 'WSOL',
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    poolAddress: 'AhioAr1uitCVfJ2Fi3rh19pGi9brEVAj9iyLT6Fw5eXf',
    tokenX: 'So11111111111111111111111111111111111111112',
    tokenY: '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f',
    binStep: 25,
    feeBps: 100,
    activeId: -265,
    initialPriceYPerX: 0.516091025,
    alreadyExisted: true,
  },
  {
    name: 'USDC',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    poolAddress: '6qrxgP5XsEdQHcdo5UFQS9LyfELWXvnMNhA6pF6YqjFj',
    tokenX: '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f',
    tokenY: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    binStep: 100,
    feeBps: 200,
    activeId: -216,
    initialPriceYPerX: 116.77353,
    alreadyExisted: true,
  },
  {
    name: 'Staccana',
    mint: '73edX6xoGY4v5y2hzuKdrUbJXLntqgmo74au1Ki1pump',
    decimals: 6,
    poolAddress: '245kUb1aHRaFL5QGw28DxY96Y1P5xLAWjUJc1Ckg7Y5P',
    tokenX: '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f',
    tokenY: '73edX6xoGY4v5y2hzuKdrUbJXLntqgmo74au1Ki1pump',
    binStep: 200,
    feeBps: 500,
    activeId: 387,
    initialPriceYPerX: 2109978.792462,
    alreadyExisted: true,
  },
  {
    name: 'FOMOX402',
    mint: 'GezJEsABGEmZVoXsDKHCCwYvxGPhQFk4hd91MchYQZaM',
    decimals: 9,
    poolAddress: '2z83AkxqfvqFGLJyuuVuvpXB9gT2XTr42T3VqB281s3C',
    tokenX: '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f',
    tokenY: 'GezJEsABGEmZVoXsDKHCCwYvxGPhQFk4hd91MchYQZaM',
    binStep: 200,
    feeBps: 500,
    activeId: 736,
    initialPriceYPerX: 2118426.553389416,
    alreadyExisted: true,
  },
  {
    name: 'PROOFV3',
    mint: 'CLWeikxiw8pC9JEtZt14fqDzYfXF7uVwLuvnJPkrE7av',
    decimals: 6,
    poolAddress: 'AJA9HAXTFHFTMZLL34VxXaYR7tXMBKJbPwroHEpeRr4V',
    tokenX: '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f',
    tokenY: 'CLWeikxiw8pC9JEtZt14fqDzYfXF7uVwLuvnJPkrE7av',
    binStep: 200,
    feeBps: 500,
    activeId: 344,
    initialPriceYPerX: 914265.943673,
    alreadyExisted: true,
  },
]

/**
 * Returns the maximum multiplier (price ratio) that fits within Meteora's
 * 70-bins-per-position cap for the given binStep. Beyond this you'd need
 * multiple positions stitched together.
 */
export function maxMultiplierForBinStep(binStep: number, maxBins = 70): number {
  return Math.pow(1 + binStep / 10000, maxBins)
}

/**
 * Convert a price multiplier (e.g. 2 = 2x current price) into a number of
 * bins of distance. Sign indicates direction (positive = up, negative = down).
 */
export function multiplierToBinDelta(multiplier: number, binStep: number): number {
  const base = 1 + binStep / 10000
  return Math.round(Math.log(multiplier) / Math.log(base))
}
