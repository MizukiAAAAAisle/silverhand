import type { ClientPlatform } from "@silverhand/client";
import type { ComposerPicker, ComposerPickerIcon } from "@silverhand/client";
import { rasterizeImage, rasterizeMarkup } from "./glyph";
import type { NativeBridge } from "./bridge";

const pngs = new Map<string, Promise<string>>();

function png(source: string, picture = false): Promise<string> {
  const key = (picture ? "image:" : "glyph:") + source;
  let cached = pngs.get(key);
  if (!cached) {
    // Pictures are object URLs that live as long as the page does.
    if (pngs.size > 256) {
      pngs.clear();
    }
    cached = picture ? rasterizeImage(source) : rasterizeMarkup(source);
    pngs.set(key, cached);
  }
  return cached;
}

async function iconPng(icon: ComposerPickerIcon): Promise<ComposerPickerIcon> {
  return "image" in icon
    ? { image: await png(icon.image, true) }
    : { ...icon, glyph: await png(icon.glyph) };
}

async function withPngs(picker: ComposerPicker): Promise<ComposerPicker> {
  const rows = await Promise.all(
    picker.rows.map(async (row) => ({ ...row, icon: await iconPng(row.icon) })),
  );
  return { ...picker, rows };
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
        const [add, picker, faces] = await Promise.all([
          Promise.all(state.add.map(async (item) => ({ ...item, icon: await png(item.icon) }))),
          state.picker ? withPngs(state.picker) : undefined,
          state.activity ? Promise.all(state.activity.faces.map(iconPng)) : undefined,
        ]);
        const activity = state.activity && faces ? { ...state.activity, faces } : undefined;
        await bridge.composerSync({ state: { ...state, add, picker, activity } });
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
