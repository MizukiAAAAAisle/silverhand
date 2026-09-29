import type { NavigationStore } from "./store";

export interface AddressPort {
  read(): string;
  replace(url: string): void;
  subscribe(listener: () => void): () => void;
}
/** External hash edits (including browser traversal) are navigation intents.
 * Internal navigation only replaces the URL projection, never appends a second
 * browser stack. replaceState does not emit hashchange, so it cannot feed back. */
export function connectAddress(store: NavigationStore, port: AddressPort, allowed: () => boolean) {
  const project = () => {
    const { pathname, search } = store.getSnapshot().location;
    port.replace(pathname + search);
  };
  const offStore = store.subscribe(project);
  const offAddress = port.subscribe(() => {
    const url = port.read();
    if (allowed()) store.external(url === "/" || !url ? "/chat" : url);
    project();
  });
  project();
  return () => {
    offStore();
    offAddress();
  };
}
