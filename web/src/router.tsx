import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

// Tiny History-API router: three pages do not need a routing library.

const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  window.addEventListener("popstate", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("popstate", fn);
  };
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

/** Keeps ?fixture=1 while moving between pages; drops one-off params. */
function keepSearch(): string {
  const params = new URLSearchParams(window.location.search);
  const kept = new URLSearchParams();
  const fixture = params.get("fixture");
  if (fixture) kept.set("fixture", fixture);
  const s = kept.toString();
  return s ? `?${s}` : "";
}

export function navigate(path: string) {
  const url = path + keepSearch();
  if (url === window.location.pathname + window.location.search) return;
  window.history.pushState(null, "", url);
  window.scrollTo({ top: 0 });
  listeners.forEach((fn) => fn());
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to + keepSearch()} onClick={handle} {...rest} />;
}
