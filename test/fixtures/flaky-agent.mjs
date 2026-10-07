// Fails on its first run in a directory, answers afterwards: checks that `rech serve` retries.
import { existsSync, writeFileSync } from "node:fs";
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  if (!existsSync("flaky-ran-once")) {
    writeFileSync("flaky-ran-once", "");
    console.error("model overloaded");
    process.exit(1);
  }
  console.log("answered on retry");
});
