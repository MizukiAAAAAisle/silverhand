import type { ClientPlatform } from "@silverhand/client";
import { rasterizeMarkup } from "./glyph";
import type { NativeBridge } from "./bridge";

const pngs = new Map<string, Promise<string>>();

function png(markup: string): Promise<string> {
  let cached = pngs.get(markup);
  if (!cached) {
    cached = rasterizeMarkup(markup);
    pngs.set(markup, cached);
  }
  return cached;
}

/** The compact composer, drawn natively over the page. */
export function createIOSComposer(bridge: NativeBridge): NonNullable<ClientPlatform["composer"]> {
  // Calls reach native in order, though a state's glyphs render first: text
  // set after a state belongs to it.
  let queue: Promise<unknown> = Promise.resolve();
  const run = <T>(call: () => Promise<T>): Promise<T> => {
    const result = queue.then(call);
    queue = result.catch(() => {});
    return result;
  };

  return {
    sync: (state) =>
      run(async () => {
        const add = await Promise.all(
          state.add.map(async (item) => ({ ...item, icon: await png(item.icon) })),
        );
        await bridge.composerSync({ state: { ...state, add } });
      }),
    remove: (key) => run(() => bridge.composerRemove({ key })),
    setText: (input) => run(() => bridge.composerSetText(input)),
    subscribe: async (handler) => {
      const listener = await bridge.addListener("composer", handler);
      return () => {
        void listener.remove();
      };
    },
  };
}
