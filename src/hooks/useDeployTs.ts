import { useEffect, useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { FALLBACK_DEPLOY_TS, fetchPoolDeployTs, loadCachedDeployTs, saveDeployTs } from '../lib/apr'

export function useDeployTs() {
  const { connection } = useConnection()
  const [ts, setTs] = useState<number>(() => loadCachedDeployTs() ?? FALLBACK_DEPLOY_TS)

  useEffect(() => {
    if (loadCachedDeployTs()) return // already cached, never refetch
    let cancelled = false
    fetchPoolDeployTs(connection)
      .then((real) => {
        if (cancelled || real == null) return
        saveDeployTs(real)
        setTs(real)
      })
      .catch(() => {/* keep fallback */})
    return () => { cancelled = true }
  }, [connection])

  return ts
}
