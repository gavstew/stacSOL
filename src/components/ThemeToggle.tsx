import { useTheme } from '../hooks/useTheme'

export function ThemeToggle() {
  const { theme, toggle } = useTheme()
  return (
    <button
      onClick={toggle}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      style={{ fontFamily: 'var(--font-mono)' }}
      className="fixed top-2 right-2 z-20 px-2 py-1 text-[9px] font-black uppercase tracking-[2px] rounded border border-[var(--color-dim)] text-[var(--color-dim)] bg-[var(--color-bg)] opacity-60 hover:opacity-100 transition cursor-pointer select-none"
    >
      {theme === 'dark' ? '[ light ]' : '[ dark ]'}
    </button>
  )
}
