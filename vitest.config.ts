import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_OPENAI_API_KEY, TEST_SESSION_AUTH_SECRET } from "./test/constants";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          OPENAI_API_KEY: TEST_OPENAI_API_KEY,
          SESSION_AUTH_SECRET: TEST_SESSION_AUTH_SECRET,
        },
      },
    }),
  ],
});
