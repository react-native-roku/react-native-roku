import { RokuHostError } from "../scene/sceneGraph.types";

export type RouteParams = Readonly<Record<string, string | readonly string[]>>;
export type RouterHref =
  | string
  | {
      readonly pathname: string;
      readonly params?: Readonly<
        Record<string, string | number | boolean | readonly string[] | undefined>
      >;
    };
export interface RouterSnapshot {
  readonly key: string;
  readonly href: string;
  readonly pathname: string;
  readonly params: RouteParams;
  readonly queryParams: RouteParams;
  readonly segments: readonly string[];
}

function sameParameter(
  value: string | number | boolean | readonly string[] | undefined,
  canonical: string | readonly string[],
): boolean {
  if (value === undefined) return false;
  if (Array.isArray(value) || Array.isArray(canonical))
    return (
      Array.isArray(value) &&
      Array.isArray(canonical) &&
      value.length === canonical.length &&
      value.every((part, index) => part === canonical[index])
    );
  return String(value) === canonical;
}
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function normalize(href: RouterHref): {
  pathname: string;
  href: string;
  params: RouteParams;
} {
  let pathname = typeof href === "string" ? href : href.pathname;
  if (!pathname.startsWith("/") || pathname.startsWith("//"))
    throw new RokuHostError("C09_HREF", "The Roku router requires an absolute application path");
  const hash = pathname.indexOf("#");
  if (hash >= 0) pathname = pathname.slice(0, hash);
  const query = pathname.indexOf("?"),
    params: Record<string, string | string[]> = Object.create(null);
  if (query >= 0) {
    for (const pair of pathname
      .slice(query + 1)
      .split("&")
      .filter(Boolean)) {
      const index = pair.indexOf("="),
        key = decodeURIComponent((index < 0 ? pair : pair.slice(0, index)).replace(/\+/g, " "));
      const value = decodeURIComponent(
        (index < 0 ? "" : pair.slice(index + 1)).replace(/\+/g, " "),
      );
      const previous = params[key];
      params[key] =
        previous == null
          ? value
          : Array.isArray(previous)
            ? [...previous, value]
            : [previous, value];
    }
    pathname = pathname.slice(0, query);
  }
  if (typeof href !== "string")
    for (const [key, value] of Object.entries(href.params ?? {})) {
      if (value === undefined) continue;
      const placeholder = `[${key}]`,
        catchAll = `[...${key}]`;
      if (pathname.includes(placeholder))
        pathname = pathname.replace(placeholder, encodeURIComponent(String(value)));
      else if (pathname.includes(catchAll))
        pathname = pathname.replace(
          catchAll,
          (Array.isArray(value) ? value : [String(value)])
            .map((part) => encodeURIComponent(part))
            .join("/"),
        );
      else params[key] = Array.isArray(value) ? [...value] : String(value);
    }
  pathname =
    "/" +
    pathname
      .split("/")
      .filter((segment) => segment && !/^\([^/]+\)$/.test(segment))
      .join("/");
  if (/\[|\]/.test(pathname))
    throw new RokuHostError("C09_HREF", `Missing route parameters for ${pathname}`);
  if (pathname.split("/").some((segment) => segment === "." || segment === ".."))
    throw new RokuHostError("C09_HREF", "Relative path segments require an explicit route adapter");
  const search = Object.keys(params)
    .sort()
    .flatMap((key) => {
      const value = params[key];
      return (Array.isArray(value) ? value : [value]).map(
        (item) => `${encodeURIComponent(key)}=${encodeURIComponent(item)}`,
      );
    })
    .join("&");
  for (const value of Object.values(params)) if (Array.isArray(value)) Object.freeze(value);
  return {
    pathname,
    href: pathname + (search ? `?${search}` : ""),
    params: Object.freeze(params),
  };
}

/** Generic location mechanics. Product routes and availability remain catalog-owned. */
export class RouterStore {
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private stack: RouterSnapshot[];
  private disposed = false;
  constructor(
    initialHref: RouterHref = "/",
    private readonly resolvePathParams?: (pathname: string) => RouteParams,
  ) {
    this.stack = [this.create(initialHref)];
  }
  getSnapshot = (): RouterSnapshot => this.stack[this.stack.length - 1];
  subscribe = (listener: () => void): (() => void) => {
    this.assertActive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get listenerCount(): number {
    return this.listeners.size;
  }
  canGoBack(): boolean {
    return this.stack.length > 1;
  }
  push(href: RouterHref): void {
    this.assertActive();
    this.stack.push(this.create(href));
    this.publish();
  }
  replace(href: RouterHref): void {
    this.assertActive();
    if (normalize(href).href === this.getSnapshot().href) return;
    this.stack[this.stack.length - 1] = this.create(href);
    this.publish();
  }
  navigate(href: RouterHref, options?: { readonly dangerouslySingular?: boolean }): void {
    this.assertActive();
    const normalized = normalize(href);
    if (this.getSnapshot().href === normalized.href) return;
    let existing = -1;
    if (options?.dangerouslySingular)
      for (let index = this.stack.length - 1; index >= 0; index--)
        if (this.stack[index].href === normalized.href) {
          existing = index;
          break;
        }
    if (existing >= 0) {
      this.stack = this.stack.slice(0, existing + 1);
      this.publish();
    } else this.push(href);
  }
  back(): void {
    this.dismiss(1);
  }
  dismiss(count = 1): void {
    this.assertActive();
    if (!Number.isInteger(count) || count < 1)
      throw new RokuHostError("C09_DISMISS", "Dismiss count must be a positive integer");
    const length = Math.max(1, this.stack.length - count);
    if (length === this.stack.length) return;
    this.stack = this.stack.slice(0, length);
    this.publish();
  }
  dismissTo(href: RouterHref): void {
    this.assertActive();
    const normalized = normalize(href);
    for (let index = this.stack.length - 1; index >= 0; index--)
      if (this.stack[index].href === normalized.href) {
        if (index === this.stack.length - 1) return;
        this.stack = this.stack.slice(0, index + 1);
        this.publish();
        return;
      }
    this.replace(href);
  }
  dismissAll(): void {
    this.dismiss(Math.max(1, this.stack.length - 1));
  }
  setParams(
    params: Readonly<Record<string, string | number | boolean | readonly string[] | undefined>>,
  ): void {
    const current = this.getSnapshot(),
      path = this.resolvePathParams?.(current.pathname) ?? {};
    for (const [key, value] of Object.entries(params))
      if (owns(path, key) && !sameParameter(value, path[key]))
        throw new RokuHostError(
          "C09_PATH_PARAMETER",
          "Changing a path parameter requires explicit navigation",
        );
    const next = {
      ...current.queryParams,
      ...Object.fromEntries(Object.entries(params).filter(([key]) => !owns(path, key))),
    };
    this.replace({ pathname: current.pathname, params: next });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.stack = [this.stack[0]];
  }
  private create(href: RouterHref): RouterSnapshot {
    const route = normalize(href);
    const path: RouteParams = Object.fromEntries(
      Object.entries(this.resolvePathParams?.(route.pathname) ?? {}).map(([key, value]) => [
        key,
        Array.isArray(value) ? Object.freeze([...value]) : value,
      ]),
    );
    for (const [key, value] of Object.entries(route.params))
      if (owns(path, key) && !sameParameter(value, path[key]))
        throw new RokuHostError(
          "C09_PATH_PARAMETER",
          "A query value cannot change a canonical path parameter",
        );
    return Object.freeze({
      ...route,
      key: `roku-route-${++this.sequence}`,
      queryParams: route.params,
      params: Object.freeze({
        ...route.params,
        ...path,
      }),
      segments: Object.freeze(route.pathname.split("/").filter(Boolean)),
    });
  }
  private publish() {
    for (const listener of [...this.listeners]) listener();
  }
  private assertActive() {
    if (this.disposed) throw new RokuHostError("C09_ROUTER_DISPOSED", "The router was disposed");
  }
}
