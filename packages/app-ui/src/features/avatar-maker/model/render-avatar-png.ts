import { composeAvatarSvg, type AvatarConfig } from "./avatar-config";

// 512 px keeps the 2–3 unit strokes crisp at the largest profile size on a 3x screen.
const PNG_SIZE = 512;

export async function renderAvatarPng(config: AvatarConfig, size = PNG_SIZE): Promise<File> {
  const svg = composeAvatarSvg(config);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("canvas unavailable");
  }

  context.drawImage(image, 0, 0, size, size);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));

  if (!blob) {
    throw new Error("png encode failed");
  }

  return new File([blob], "avatar.png", { type: "image/png" });
}
