import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  sourcemap: true,
  clean: true,
  dts: false,
  minify: false,
  hash: false,
  outExtensions: () => ({ js: ".js" }),
  banner: {
    js: "#!/usr/bin/env node",
  },
});
