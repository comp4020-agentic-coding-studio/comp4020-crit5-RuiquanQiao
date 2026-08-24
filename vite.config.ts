import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Plugin, defineConfig } from "vite";

// Every .html file in the repo is a page and a build entry, so a multi-page
// hand-written site needs no build config: add pages, link them, ship.
// (Vite's default would build only the root index.html and silently drop the
// rest from dist/ — fine locally, 404s deployed.)
const SKIP = new Set(["node_modules", "dist", "spec", "scripts", "reflections"]);

function htmlEntries(dir = "."): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return htmlEntries(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

/**
 * Dev-only sink for canvas frames.
 *
 * A canvas draws into its backing store whether or not the page is being
 * composited, so `toDataURL` works even when the preview pane is closed and
 * screenshots are impossible. This takes that data URL and writes it to a file
 * I can open. It is the difference between being able to see the animation and
 * having to argue about it from test output.
 *
 * `apply: "serve"` — it never reaches a build, so nothing here ships.
 */
function frameSink(): Plugin {
  return {
    name: "frame-sink",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__frame", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const [, name = "frame", data = ""] = /^([\w.-]+)\|(.*)$/s.exec(body) ?? [];
          mkdirSync(".frames", { recursive: true });
          writeFileSync(
            join(".frames", `${name}.png`),
            Buffer.from(data.replace(/^data:image\/png;base64,/, ""), "base64"),
          );
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

// `base: "./"` makes built asset URLs relative, so the site works under any
// GitHub Pages path (username.github.io/your-repo/) without further config.
export default defineConfig({
  base: "./",
  plugins: [frameSink()],
  build: {
    rollupOptions: {
      input: htmlEntries(),
    },
  },
});
