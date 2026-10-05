import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.ACQUIT_API_URL ?? "http://localhost:4310";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/api": { target: api, changeOrigin: false },
      "/paypal": { target: api, changeOrigin: false },
    },
  },
});
