import { DECIMALS } from './constants'

export function fmtAmount(big: bigint, decimals = DECIMALS, places = 4) {
  const n = Number(big) / Math.pow(10, decimals)
  return n.toLocaleString(undefined, {
    maximumFractionDigits: places,
    minimumFractionDigits: places,
  })
}

export function shortPk(pk: string) {
  return pk.slice(0, 4) + '…' + pk.slice(-4)
}
