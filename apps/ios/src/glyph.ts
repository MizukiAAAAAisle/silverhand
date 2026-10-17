const GLYPH_PX = 20;
const SCALE = 3;

/** A declared glyph as a black-on-clear PNG; native tints it. */
export function rasterizeMarkup(markup: string): Promise<string> {
  const host = document.createElement("div");
  host.innerHTML = markup;
  const svg = host.querySelector("svg");
  return svg ? rasterize(svg) : Promise.resolve("");
}

async function rasterize(svg: SVGSVGElement): Promise<string> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const px = GLYPH_PX * SCALE;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(px));
  clone.setAttribute("height", String(px));
  clone.removeAttribute("class");
  clone.setAttribute("style", "color:#000");
  const source = new XMLSerializer().serializeToString(clone);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  try {
    await image.decode();
  } catch {
    return "";
  }
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  canvas.getContext("2d")?.drawImage(image, 0, 0, px, px);
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

const PICTURE_PX = 30;

/** A declared picture (an image URL) as a square PNG, cropped to fill. */
export async function rasterizeImage(url: string, size = PICTURE_PX): Promise<string> {
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    return "";
  }
  const px = size * SCALE;
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  canvas
    .getContext("2d")
    ?.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      px,
      px,
    );
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}
