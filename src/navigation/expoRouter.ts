import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { RokuHostError } from "../scene/sceneGraph.types";
import { RouterStore, type RouteParams, type RouterHref } from "./RouterStore";

export type Href = RouterHref;
const context = createContext<RouterStore | null>(null);
const registrations: Array<{ readonly store: RouterStore }> = [];
const required = () => {
  const store = registrations[registrations.length - 1]?.store;
  if (!store)
    throw new RokuHostError(
      "C09_ROUTER_HOST",
      "Expo navigation requires a mounted Roku router provider",
    );
  return store;
};
function createRouter(resolve: () => RouterStore) {
  return Object.freeze({
    push: (href: Href) => resolve().push(href),
    replace: (href: Href) => resolve().replace(href),
    navigate: (href: Href, options?: { dangerouslySingular?: boolean }) =>
      resolve().navigate(href, options),
    back: () => resolve().back(),
    canGoBack: () => resolve().canGoBack(),
    canDismiss: () => resolve().canGoBack(),
    dismiss: (count?: number) => resolve().dismiss(count),
    dismissTo: (href: Href) => resolve().dismissTo(href),
    dismissAll: () => resolve().dismissAll(),
    setParams: (params: Parameters<RouterStore["setParams"]>[0]) => resolve().setParams(params),
  });
}
export const router = createRouter(required);
export function RokuRouterProvider({
  store,
  children,
}: {
  readonly store: RouterStore;
  readonly children: ReactNode;
}) {
  useLayoutEffect(() => {
    const registration = { store };
    registrations.push(registration);
    return () => {
      const index = registrations.indexOf(registration);
      if (index >= 0) registrations.splice(index, 1);
    };
  }, [store]);
  return createElement(context.Provider, { value: store }, children);
}
function useStore() {
  const store = useContext(context);
  if (!store)
    throw new RokuHostError("C09_ROUTER_HOST", "Navigation hooks require a Roku router provider");
  return store;
}
function useLocation() {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
export function useRouter() {
  const store = useStore();
  return useMemo(() => createRouter(() => store), [store]);
}
export function usePathname(): string {
  return useLocation().pathname;
}
export function useSegments(): readonly string[] {
  return useLocation().segments;
}
export function useLocalSearchParams<T = RouteParams>(): T {
  return useLocation().params as T;
}
export function useGlobalSearchParams<T = RouteParams>(): T {
  return useLocalSearchParams<T>();
}
export function Redirect({ href }: { readonly href: Href }) {
  const store = useStore();
  useEffect(() => {
    store.replace(href);
  }, [store, href]);
  return null;
}

function unsupported(name: string) {
  return function UnsupportedRouterSurface(): never {
    throw new RokuHostError(
      "C09_ROUTER_SURFACE",
      `${name} is not admitted; the Roku application uses the canonical persistent TV shell`,
    );
  };
}
export const Stack = Object.assign(unsupported("Stack"), {
  Screen: unsupported("Stack.Screen"),
});
export const Tabs = Object.assign(unsupported("Tabs"), {
  Screen: unsupported("Tabs.Screen"),
});
export const Slot = unsupported("Slot");
export const SplashScreen = Object.freeze({
  preventAutoHideAsync: async (): Promise<never> => {
    throw new RokuHostError("C09_SPLASH", "The native splash controller has not been connected");
  },
  hideAsync: async (): Promise<never> => {
    throw new RokuHostError("C09_SPLASH", "The native splash controller has not been connected");
  },
});
