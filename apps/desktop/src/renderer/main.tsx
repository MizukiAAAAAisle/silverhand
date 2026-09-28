import { configurePlatform, mountApp } from "@silverhand/app-ui";
import { createDesktopPlatform } from "./platform";

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");
configurePlatform(createDesktopPlatform(window.silverhand, () => window.location.reload()));
mountApp(root);
