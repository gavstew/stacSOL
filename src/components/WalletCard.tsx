import { useEffect, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { Card } from './Stats'
import { useSolBalance } from '../hooks/useSolBalance'

// Mobile dApp browsers (Telegram, Samsung Internet, mobile Safari/Chrome
// without a wallet extension) don't inject a usable Solana provider, so the
// adapter modal lists nothing actionable. Detect that case and offer
// deeplinks that re-open the page inside the wallet's own in-app browser.
function isMobileUA(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  )
}

/** Telegram's in-app browser is the #1 reason mints "exit the app" — when
 *  the user taps approve, Phantom opens via deep link, signs, and returns
 *  to Telegram which has by then unloaded the dApp tab. Detect it
 *  specifically so we can warn even when a wallet provider IS injected. */
function isTelegramInAppBrowser(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  // Telegram WebApp injects window.Telegram.WebApp; iOS Telegram browser
  // also adds 'Telegram' to the UA. Android Telegram browser adds 'TgClient'.
  const w = window as unknown as { Telegram?: { WebApp?: unknown } }
  if (w.Telegram?.WebApp) return true
  return /Telegram|TgClient/i.test(navigator.userAgent)
}

function detectMobileNoWallet(): boolean {
  if (typeof window === 'undefined') return false
  if (!isMobileUA()) return false
  const w = window as unknown as {
    solana?: unknown
    solflare?: unknown
    trustwallet?: unknown
    phantom?: unknown
  }
  return !w.solana && !w.solflare && !w.trustwallet && !w.phantom
}

function phantomDeeplink(): string {
  const url = window.location.href
  const ref = window.location.origin
  return `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`
}

function solflareDeeplink(): string {
  return `https://solflare.com/ul/v1/browse/${encodeURIComponent(window.location.href)}?ref=${encodeURIComponent(window.location.origin)}`
}

function trustDeeplink(): string {
  return `https://link.trustwallet.com/open_url?coin_id=501&url=${encodeURIComponent(window.location.href)}`
}

/**
 * Custom wallet card. Drops the flat-orange WalletMultiButton in favor of a
 * structured layout: adapter icon · name + truncated pubkey (with copy) ·
 * live SOL balance · disconnect link. Disconnected state is a minimal
 * outlined button instead of a saturated block.
 */
export function WalletCard() {
  const { publicKey, wallet, disconnect, connecting, connected } = useWallet()
  const { setVisible } = useWalletModal()
  // Shared poll loop with the Action cards. See `useSolBalance` doc — the
  // dedupe is critical on Phantom mobile to avoid the on-connect TLS
  // handshake storm that crashes the webview.
  const lamports = useSolBalance(publicKey ?? null)
  const solBalance = lamports != null ? BigInt(lamports) : null
  const [copied, setCopied] = useState(false)
  const [mobileNoWallet, setMobileNoWallet] = useState(false)
  const [inTelegram, setInTelegram] = useState(false)

  useEffect(() => {
    setMobileNoWallet(detectMobileNoWallet())
    setInTelegram(isTelegramInAppBrowser())
  }, [])

  if (!connected || !publicKey) {
    return (
      <Card title="Wallet">
        <button
          type="button"
          onClick={() => setVisible(true)}
          disabled={connecting}
          className="w-full px-4 py-3 bg-transparent border border-[var(--color-hot)] text-[var(--color-hot)] rounded font-black uppercase tracking-[3px] text-sm hover:bg-[var(--color-hot)] hover:text-black transition-colors disabled:opacity-50"
        >
          {connecting ? 'connecting…' : 'connect wallet'}
        </button>
        <p className="mt-3 text-[11px] text-[var(--color-dim)] leading-relaxed">
          phantom · solflare · trust · any solana wallet adapter — burn, mint, see your position.
        </p>
        {(mobileNoWallet || inTelegram) && (
          <MobileWalletDeeplinks inTelegram={inTelegram} />
        )}
      </Card>
    )
  }

  const pkStr = publicKey.toBase58()
  const short = pkStr.slice(0, 4) + '…' + pkStr.slice(-4)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pkStr)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  const solStr =
    solBalance != null
      ? (Number(solBalance) / 1e9).toLocaleString(undefined, {
          maximumFractionDigits: 4,
          minimumFractionDigits: 4,
        })
      : '—'

  return (
    <Card title="Wallet">
      <div className="grid grid-cols-[auto_1fr_auto] gap-x-4 gap-y-1 items-center">
        {wallet?.adapter.icon && (
          <img
            src={wallet.adapter.icon}
            alt={wallet.adapter.name}
            className="w-9 h-9 rounded shrink-0"
          />
        )}
        <div className="min-w-0">
          <div className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-dim)]">
            {wallet?.adapter.name ?? 'connected'}
          </div>
          <div className="flex items-center gap-2">
            <code className="tabular-mono text-base font-extrabold text-[var(--color-fg)] truncate">
              {short}
            </code>
            <button
              type="button"
              onClick={copy}
              className="text-[10px] uppercase tracking-[2px] text-[var(--color-dim)] hover:text-[var(--color-ember)] transition-colors"
              aria-label="copy address"
            >
              {copied ? 'copied' : 'copy'}
            </button>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-dim)]">
            Balance
          </div>
          <div className="tabular-mono text-base font-extrabold text-[var(--color-fg)] leading-none mt-1">
            {solStr}
            <span className="text-[10px] text-[var(--color-dim)] ml-1.5 uppercase tracking-wider font-black">
              SOL
            </span>
          </div>
        </div>
      </div>
      <div className="mt-4 pt-3 border-t border-[rgb(255_34_0_/_0.1)] flex items-center justify-between">
        <a
          href={`https://solscan.io/account/${pkStr}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] uppercase tracking-[2px] text-[var(--color-dim)] hover:text-[var(--color-ember)] transition-colors"
        >
          solscan ↗
        </a>
        <button
          type="button"
          onClick={() => setVisible(true)}
          className="text-[10px] uppercase tracking-[2px] text-[var(--color-dim)] hover:text-[var(--color-fg)] transition-colors"
        >
          switch
        </button>
        <button
          type="button"
          onClick={disconnect}
          className="text-[10px] uppercase tracking-[2px] text-[var(--color-dim)] hover:text-[var(--color-warn)] transition-colors"
        >
          disconnect
        </button>
      </div>
      {/* Even when "connected" in Telegram's browser, the sign-tx flow
          deep-links to Phantom and the user usually never returns to
          Telegram cleanly (tab gets closed by TG when the wallet app
          comes to front). Surface the warning + reopen-in-wallet links
          on every render here, not just the disconnected card. */}
      {inTelegram && <MobileWalletDeeplinks inTelegram={true} />}
    </Card>
  )
}

/**
 * Reusable card-bottom block that warns mobile users about the signing
 * problem and offers deep links to reopen the page inside Phantom /
 * Solflare / Trust's own in-app browser. Wallet-specific copy when the
 * user is detected to be inside Telegram's browser (the most common cause
 * of "I clicked confirm and the app exited").
 */
function MobileWalletDeeplinks({ inTelegram }: { inTelegram: boolean }) {
  return (
    <div className="mt-4 pt-3 border-t border-[rgb(255_204_0_/_0.25)]">
      <p className="text-[10px] uppercase tracking-[2px] text-[var(--color-warn)] mb-2 font-black">
        {inTelegram
          ? '⚠ telegram browser detected — signing will fail'
          : 'on mobile? open inside your wallet'}
      </p>
      <p className="text-[11px] text-[var(--color-dim)] leading-relaxed mb-3">
        {inTelegram
          ? "telegram's in-app browser can't keep a wallet session through a deep-link signature. when you tap mint and approve in phantom, telegram closes the tab and you lose the flow. tap a button below to reopen this exact page inside your wallet's own browser — signing works there end-to-end."
          : "telegram & default mobile browsers can't sign transactions. tap one of these to reopen this page in the wallet's own browser."}
      </p>
      <div className="grid grid-cols-3 gap-2">
        <a
          href={phantomDeeplink()}
          className="text-center px-3 py-2 rounded border border-[rgb(255_34_0_/_0.4)] bg-[rgb(255_34_0_/_0.06)] text-[10px] font-black uppercase tracking-[2px] text-[var(--color-hot)] no-underline hover:bg-[rgb(255_34_0_/_0.12)] transition"
        >
          phantom
        </a>
        <a
          href={solflareDeeplink()}
          className="text-center px-3 py-2 rounded border border-[rgb(255_34_0_/_0.4)] bg-[rgb(255_34_0_/_0.06)] text-[10px] font-black uppercase tracking-[2px] text-[var(--color-hot)] no-underline hover:bg-[rgb(255_34_0_/_0.12)] transition"
        >
          solflare
        </a>
        <a
          href={trustDeeplink()}
          className="text-center px-3 py-2 rounded border border-[rgb(255_34_0_/_0.4)] bg-[rgb(255_34_0_/_0.06)] text-[10px] font-black uppercase tracking-[2px] text-[var(--color-hot)] no-underline hover:bg-[rgb(255_34_0_/_0.12)] transition"
        >
          trust
        </a>
      </div>
    </div>
  )
}
