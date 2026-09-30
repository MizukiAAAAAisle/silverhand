import { createContext, useContext } from "react";

/** Product entry preferences belong to the app entry, not platform detection. */
export interface AppOptions {
  loginFirst?: boolean;
  /** Remote-only products expose server switching before authentication. */
  showServerAddress?: boolean;
}
export const AppOptionsContext = createContext<AppOptions>({});
export const useAppOptions = () => useContext(AppOptionsContext);
