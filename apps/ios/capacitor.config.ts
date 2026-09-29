import type { CapacitorConfig } from "@capacitor/cli";

const defaultServerURL = process.env.SILVERHAND_DEFAULT_SERVER_URL?.trim();
if (defaultServerURL) {
  let url: URL;
  try {
    url = new URL(defaultServerURL);
  } catch {
    throw new Error("SILVERHAND_DEFAULT_SERVER_URL must be an HTTPS origin");
  }
  if (
    !/^https:\/\/[^/?#@\\\s]+\/?$/i.test(defaultServerURL) ||
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.port === "0"
  ) {
    throw new Error(
      "SILVERHAND_DEFAULT_SERVER_URL must be an HTTPS origin without credentials or a path",
    );
  }
}

const config: CapacitorConfig = {
  appId: "com.silverhand.ios",
  appName: "Silverhand",
  webDir: "dist",
  loggingBehavior: "none",
  ios: { contentInset: "never", preferredContentMode: "mobile" },
  plugins: {
    SilverhandClient: defaultServerURL ? { defaultServerURL } : {},
  },
};
export default config;
