import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { visualizer } from "rollup-plugin-visualizer";

const proxyTarget = process.env.VITE_PROXY_TARGET || "http://localhost:3001";

export default defineConfig({
  resolve: {
    alias: {
      "@features": path.resolve(__dirname, "src/features"),
      "@api": path.resolve(__dirname, "src/api"),
      "@shared": path.resolve(__dirname, "src/components/common"),
      "@stores": path.resolve(__dirname, "src/stores"),
      "@config": path.resolve(__dirname, "src/config"),
      "@theme": path.resolve(__dirname, "src/theme"),
    },
  },
  plugins: [
    react(),
    process.env.ANALYZE === "true" && visualizer({ open: true, gzipSize: true }),
  ].filter(Boolean),
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-antd": ["antd", "@ant-design/icons"],
          "vendor-tanstack": ["@tanstack/react-query"],
          "vendor-reactflow": ["@xyflow/react"],
        },
      },
    },
  },
  server: {
    proxy: {
      // Proxy all /api requests to backend server
      "/api": {
        target: proxyTarget,
        changeOrigin: true,
      },
      // SCIM 2.0 endpoints, outside the /api/v1 prefix: the base URL Admin > SCIM shows
      "/scim": {
        target: proxyTarget,
        changeOrigin: true,
      },
      // WebSocket gateway (socket.io) for real-time events
      "/events": {
        target: proxyTarget,
        changeOrigin: true,
        ws: true,
      },
      // The gateway's traffic itself: the client opens the namespace /events, and socket.io
      // sends its polling requests and the websocket upgrade to its default path /socket.io
      // (events.gateway.ts sets no `path`). Without this entry the SPA answers them in dev and
      // the top bar stays on "Connecting...".
      "/socket.io": {
        target: proxyTarget,
        changeOrigin: true,
        ws: true,
      },
    },
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  },
  preview: {
    headers: {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  },
});

// --- Task 109 recap: Vendor chunk splitting (react, antd, tanstack, reactflow) + bundle analyzer when ANALYZE=true.
