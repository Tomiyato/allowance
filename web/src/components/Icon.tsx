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
  plus: "M12 5v14 M5 12h14",
  book: "M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15z M5 19.5A1.5 1.5 0 0 0 6.5 21H19",
  ball: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7.5l3.8 2.8-1.5 4.5H9.7l-1.5-4.5L12 7.5z M12 3v4.5 M15.8 10.3l4.6-1.6 M14.3 14.8l2.8 3.9 M9.7 14.8l-2.8 3.9 M8.2 10.3L3.6 8.7",
  star: "M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6L12 16.7l-5.4 2.9 1.1-6L3.2 9.4l6.1-.8L12 3z",
  pen: "M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20z M14 7l3 3",
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
  books: "book",
  sports: "ball",
  toys: "star",
  office: "pen",
};

export function iconForCategory(cat: string): IconName {
  return categoryIcon[cat] ?? "box";
}

// Ribbon bow on a 40x28 grid: two looped bows (with the loop opening cut out), two tails and a knot.
const BOW_LOOPS = [
  "M20 11.5C15.5 3.5 4.5.5 3.4 7.2 2.6 12.6 11.5 15 20 11.5ZM17.2 10.6C13.6 6.6 8 5.2 7.3 8.1 6.8 10.5 11.8 11.7 17.2 10.6Z",
  "M20 11.5C24.5 3.5 35.5.5 36.6 7.2 37.4 12.6 28.5 15 20 11.5ZM22.8 10.6C26.4 6.6 32 5.2 32.7 8.1 33.2 10.5 28.2 11.7 22.8 10.6Z",
];
const BOW_TAILS = [
  "M18.6 12.4C16.8 16.6 14.2 21.4 11.4 26.2L14.9 25 16.4 27.8C18.3 22.6 19.6 17.6 20.4 12.8Z",
  "M21.4 12.4C23.2 16.6 25.8 21.4 28.6 26.2L25.1 25 23.6 27.8C21.7 22.6 20.4 17.6 19.6 12.8Z",
];

function BowShape({ fill, knot }: { fill: string; knot: string }) {
  return (
    <>
      <g fill={fill}>
        {BOW_LOOPS.map((d) => (
          <path key={d} fillRule="evenodd" d={d} />
        ))}
        {BOW_TAILS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <rect x="17.4" y="8.6" width="5.2" height="5.8" rx="2" fill={knot} />
    </>
  );
}

/** The small bow tied on the R of the wordmark. Sized by CSS in em. */
export function Bow({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 28" aria-hidden focusable="false">
      <BowShape fill="var(--brand, #8e1b2f)" knot="var(--brand-deep, #6e1424)" />
    </svg>
  );
}

/** App mark: an ivory bow with a gold knot on a garnet tile. Same drawing as /favicon.svg. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      <rect width="32" height="32" rx="8" fill="#8e1b2f" />
      <rect x="1" y="1" width="30" height="30" rx="7" fill="none" stroke="#c9a24b" strokeOpacity=".55" />
      <g transform="translate(2.4 6.6) scale(.68)">
        <BowShape fill="#fbf3e4" knot="#d9b25a" />
      </g>
    </svg>
  );
}
