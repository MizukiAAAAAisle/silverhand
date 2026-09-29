import { expect, it } from "vitest";
import { archiveOptions } from "../scripts/archive.mjs";

const env = { SILVERHAND_DEFAULT_SERVER_URL: "https://server.example" };

it("requires an explicit build number and release server", () => {
  expect(() => archiveOptions([], env)).toThrow("--build");
  expect(() => archiveOptions(["--build", "2"], {})).toThrow("SILVERHAND_DEFAULT_SERVER_URL");
  for (const build of ["0", "-1", "1/../../file", "10000", "1.100", "1.2.3.4"]) {
    expect(() => archiveOptions(["--build", build], env)).toThrow();
  }
});

it("defaults to signed archives and only accepts explicit release options", () => {
  expect(archiveOptions(["--build", "2"], env)).toMatchObject({ build: "2", unsigned: false });
  expect(archiveOptions(["--build", "2", "--version", "1.0.1", "--unsigned"], env)).toMatchObject({
    build: "2",
    version: "1.0.1",
    unsigned: true,
  });
  expect(() => archiveOptions(["--build", "2", "--version", "beta"], env)).toThrow();
  expect(() => archiveOptions(["--upload"], env)).toThrow();
  expect(archiveOptions(["--help"], {})).toMatchObject({ help: true });
});
