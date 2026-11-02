type Props = { size?: number; className?: string };

/** Inline brand mark: no external image file, so it can never 404. */
export function SealMark({ size = 48, className }: Props) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="知栈"
    >
      <circle cx="32" cy="32" r="31" fill="#2a1a11" />
      <circle cx="32" cy="32" r="26" fill="none" stroke="#c44536" strokeWidth="2.2" />
      <circle cx="32" cy="32" r="22.5" fill="none" stroke="#c6a36a" strokeWidth="0.8" strokeDasharray="2 2.4" />
      <path d="M20 24.5c4-1.6 8-1.6 12 0v17c-4-1.6-8-1.6-12 0z" fill="none" stroke="#f0ddb6" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M44 24.5c-4-1.6-8-1.6-12 0v17c4-1.6 8-1.6 12 0z" fill="none" stroke="#f0ddb6" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M24 29h4.5M24 33h4.5M35.5 29H40M35.5 33H40" stroke="#c6a36a" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
