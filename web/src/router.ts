/** Minimal history-API router: the SPA has only a handful of pages. */
import { useEffect, useState } from "preact/hooks";
import { type SettingsSection, settingsSection } from "./settings/sections.ts";

export type Route =
  | { page: "library" }
  | { page: "release"; id: number }
  | { page: "settings"; section: SettingsSection }
  /** Where MusicBrainz's release editor sends the browser after a submission (§12.2). */
  | { page: "mbCallback"; submission: number }
  | { page: "notFound" };

export function parseRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { page: "library" };
  const st = /^\/settings(?:\/([a-z-]+))?\/?$/.exec(pathname);
  if (st) {
    const section = settingsSection(st[1]);
    return section ? { page: "settings", section } : { page: "notFound" };
  }
  const cb = /^\/mb\/callback\/(\d+)\/?$/.exec(pathname);
  if (cb) return { page: "mbCallback", submission: Number(cb[1]) };
  const m = /^\/releases\/(\d+)\/?$/.exec(pathname);
  if (m) return { page: "release", id: Number(m[1]) };
  return { page: "notFound" };
}

export function navigate(path: string): void {
  if (path === location.pathname + location.search) return;
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.pathname));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  return route;
}

/** Same-origin link handled by the router; modifier clicks keep browser behaviour. */
export function onLinkClick(e: MouseEvent): void {
  const a = e.currentTarget as HTMLAnchorElement;
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(a.getAttribute("href")!);
}
