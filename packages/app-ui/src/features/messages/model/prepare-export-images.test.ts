import { afterEach, expect, it, vi } from "vitest";
import { prepareExportImages } from "./prepare-export-images";

afterEach(() => vi.unstubAllGlobals());

it("decodes and materializes images before they can be captured", async () => {
  const decode = vi.fn().mockResolvedValue(undefined);
  const image = {
    src: "blob:avatar",
    alt: "Author",
    naturalWidth: 32,
    naturalHeight: 32,
    getBoundingClientRect: () => ({ width: 28, height: 28 }),
    decode,
    removeAttribute: vi.fn(),
    loading: "lazy",
  };
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toDataURL: () => "data:image/png;base64,YQ==",
  };
  vi.stubGlobal("document", { createElement: () => canvas });
  await prepareExportImages({ querySelectorAll: () => [image] } as unknown as HTMLElement, 2);
  expect(decode).toHaveBeenCalledTimes(2);
  expect(image.src).toBe("data:image/png;base64,YQ==");
  expect(image.loading).toBe("eager");
  expect(canvas.width).toBe(32);
  expect(drawImage).toHaveBeenCalledTimes(1);
});

it("reports missing image content instead of silently producing a blank avatar", async () => {
  const image = { alt: "Author", decode: vi.fn().mockRejectedValue(new Error("decode failed")) };
  await expect(
    prepareExportImages({ querySelectorAll: () => [image] } as unknown as HTMLElement, 2),
  ).rejects.toThrow("Unable to include image: Author");
});

it.each([
  [1904, 1904, 28, 28, 56, 56],
  [1200, 600, 28, 28, 112, 56],
  [600, 1200, 28, 28, 56, 112],
  [32, 32, 28, 28, 32, 32],
])(
  "prepares %ix%i images for %ix%i export boxes without changing aspect ratio",
  async (sourceWidth, sourceHeight, width, height, expectedWidth, expectedHeight) => {
    const image = {
      naturalWidth: sourceWidth,
      naturalHeight: sourceHeight,
      getBoundingClientRect: () => ({ width, height }),
      decode: vi.fn().mockResolvedValue(undefined),
      removeAttribute: vi.fn(),
    };
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toDataURL: () => "data:image/png;base64,YQ==",
    };
    vi.stubGlobal("document", { createElement: () => canvas });
    await prepareExportImages({ querySelectorAll: () => [image] } as unknown as HTMLElement, 2);
    expect([canvas.width, canvas.height]).toEqual([expectedWidth, expectedHeight]);
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, expectedWidth, expectedHeight);
  },
);
