/** Materialize the export's image elements as decoded PNGs before serializing
 * the DOM into SVG. This avoids handing WebKit nested blob/SVG/WebP resources
 * to decode during foreignObject rasterization. Only the offscreen export tree
 * is changed; live avatar caches and their object URL ownership stay untouched. */
export async function prepareExportImages(root: HTMLElement, pixelRatio: number): Promise<void> {
  await Promise.all(
    Array.from(root.querySelectorAll("img")).map(async (image) => {
      image.loading = "eager";
      try {
        await image.decode();
        const canvas = document.createElement("canvas");
        const { width, height } = image.getBoundingClientRect();
        // Keep enough pixels for the final export, including object-fit: cover,
        // without embedding multi-megapixel avatars in a tiny foreignObject.
        // WebKit can omit those nested images on the first SVG rasterization.
        // Preserve the source aspect ratio and never upscale a small source.
        const scale =
          width > 0 && height > 0
            ? Math.min(
                1,
                Math.max(width / image.naturalWidth, height / image.naturalHeight) * pixelRatio,
              )
            : 1;
        canvas.width = Math.ceil(image.naturalWidth * scale);
        canvas.height = Math.ceil(image.naturalHeight * scale);
        const context = canvas.getContext("2d");
        if (!context || !canvas.width || !canvas.height) throw new Error("Empty image");
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const png = canvas.toDataURL("image/png");
        if (!png.startsWith("data:image/png;")) throw new Error("Image encoding failed");
        image.removeAttribute("srcset");
        image.src = png;
        await image.decode();
      } catch {
        throw new Error(`Unable to include image${image.alt ? `: ${image.alt}` : ""}`);
      }
    }),
  );
}
