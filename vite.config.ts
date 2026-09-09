import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// dev 用 wrangler.dev.jsonc(无 AI 绑定,离线可跑);build/deploy 用 wrangler.jsonc。
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    cloudflare({ configPath: command === "build" ? "./wrangler.jsonc" : "./wrangler.dev.jsonc" }),
  ],
  server: { port: 5174 },
}));
