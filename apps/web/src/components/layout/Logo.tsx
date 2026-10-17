export function Logo({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8b7bff" /><stop offset="1" stopColor="#2dd4bf" /></linearGradient></defs>
      <path d="M32 6 54 18.5v27L32 58 10 45.5v-27z" fill="none" stroke="url(#lg)" strokeWidth="4.5" strokeLinejoin="round" />
      <path d="M32 6v26m0 0 22-13.5M32 32 10 18.5M32 32v26" stroke="url(#lg)" strokeWidth="2.5" strokeLinecap="round" opacity=".55" />
      <circle cx="32" cy="32" r="6.5" fill="url(#lg)" />
    </svg>
  );
}
