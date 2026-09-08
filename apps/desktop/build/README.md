# build resources for electron-builder

Drop these files here before running `pnpm package`:

| file                     | required | what                                                              |
| ------------------------ | -------- | ----------------------------------------------------------------- |
| `icon.icns`              | yes      | macOS app + dmg icon. 1024×1024 source, multi-res `.icns` bundle. |
| `icon.png`               | no       | 1024×1024 source PNG (kept around for re-export)                  |
| `background.png`         | no       | dmg installer background, 540×380                                 |
| `entitlements.mac.plist` | no       | Only needed if we enable hardened runtime / app sandbox           |

### Making `icon.icns` from a 1024×1024 PNG

```bash
# Inside this directory:
mkdir icon.iconset
sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png
cp icon.png       icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset
rm -r icon.iconset
```

Then **uncomment the `icon:` line in `../electron-builder.yml`** so the
build picks it up.

### Source PNG tips

- Leave ~10% transparent margin — macOS adds its own squircle frame and
  will visually crop edge-to-edge artwork.
- Use a flat / minimal shape that holds up at 16×16.
