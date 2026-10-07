// Compiles src/ to dist/ (Node will not run TypeScript from node_modules) and copies the pages.
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { createRequire } from "node:module";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
rmSync("dist", { recursive: true, force: true });
execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { stdio: "inherit" });
for (const page of ["feed.html", "join.html"]) cpSync(`src/server/${page}`, `dist/server/${page}`);
