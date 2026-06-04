import { runLintelCli } from "../src/runCli.ts";

runLintelCli({
  cliArgs: ["gha", "token", "--post"],
  swallowErrors: true,
});
