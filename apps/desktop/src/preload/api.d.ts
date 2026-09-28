import type { DesktopBridge } from "./contract.js";
declare global {
  interface Window {
    silverhand: DesktopBridge;
  }
}
export {};
