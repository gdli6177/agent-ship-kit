import { run } from "./cli.js";

void run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
