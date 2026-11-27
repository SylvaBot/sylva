// A small client side router. Sylva has a handful of pages, so the History
// API and one hook are all it needs. The Worker serves index.html for every
// page path, so deep links and reloads work.

import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

const listeners = new Set<() => void>();

export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  listeners.forEach((l) => l());
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    listeners.add(update);
    addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      removeEventListener('popstate', update);
    };
  }, []);
  return path;
}

/** The query string, kept current like usePath. */
export function useSearch(): string {
  const [search, setSearch] = useState(location.search);
  useEffect(() => {
    const update = () => setSearch(location.search);
    listeners.add(update);
    addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      removeEventListener('popstate', update);
    };
  }, []);
  return search;
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; current?: boolean };

/** An in app link: plain clicks change the page without a reload. */
export function Link({ href, current, onClick, ...rest }: LinkProps) {
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
    scrollTo(0, 0);
  };
  return <a href={href} aria-current={current ? 'page' : undefined} onClick={go} {...rest} />;
}
