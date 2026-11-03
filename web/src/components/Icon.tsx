// Minimal stroke icon set (24px grid, currentColor). Decorative unless a label is given.

const paths: Record<string, string> = {
  shield: "M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z",
  shieldCheck: "M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z M9 12l2 2 4-4",
  shieldX: "M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z M9.5 9.5l5 5 M14.5 9.5l-5 5",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21c0-4 3.6-6 8-6s8 2 8 6",
  bot: "M12 3v3 M6 8h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z M9 13h.01 M15 13h.01 M9.5 16.5h5",
  scale: "M12 4v16 M7 20h10 M5 8h14 M5 8l-3 6a3 3 0 0 0 6 0L5 8z M19 8l-3 6a3 3 0 0 0 6 0l-3-6z",
  card: "M3 6h18v12H3z M3 10h18 M7 15h3",
  check: "M5 12l5 5 9-10",
  x: "M6 6l12 12 M18 6L6 18",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2",
  alert: "M12 3l9.5 17h-19L12 3z M12 10v4 M12 17h.01",
  undo: "M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4",
  send: "M4 12l16-8-6 16-2.5-6.5L4 12z",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2V3z M9 8h6 M9 12h6 M9 16h3",
  power: "M12 3v8 M6.3 6.3a8 8 0 1 0 11.4 0",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  list: "M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01",
  box: "M3 7l9-4 9 4v10l-9 4-9-4V7z M3 7l9 4 9-4 M12 11v10",
  leaf: "M5 19c0-8 5-14 15-14 0 10-6 15-14 15 M5 19l7-7",
  gift: "M4 10h16v10H4z M3 7h18v3H3z M12 7v13 M12 7c-2-4-6-3-5 0 M12 7c2-4 6-3 5 0",
  home: "M4 11l8-7 8 7 M6 9.5V20h12V9.5",
  pan: "M3 11h12v1a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5v-1z M15 12h6",
  bolt: "M13 3L5 14h6l-1 7 8-11h-6l1-7z",
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18, label, className }: { name: IconName; size?: number; label?: string; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={paths[name]} />
    </svg>
  );
}

const categoryIcon: Record<string, IconName> = {
  garden: "leaf",
  gifts: "gift",
  home: "home",
  kitchen: "pan",
  electronics: "bolt",
};

export function iconForCategory(cat: string): IconName {
  return categoryIcon[cat] ?? "box";
}

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="#0e3b43" />
      <path d="M8 21a8 8 0 0 1 16 0" fill="none" stroke="#7dd3c0" strokeWidth="3" strokeLinecap="round" />
      <path d="M8 21a8 8 0 0 1 4.3-7.1" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <circle cx="16" cy="21" r="2" fill="#fff" />
    </svg>
  );
}
