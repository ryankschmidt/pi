// A stand-in program: starts the reaper, then a detached shell that sleeps (as Pi Durable starts bash), prints the
// shell's pid, and waits to be killed.
import { spawn } from "node:child_process";
import { startReaper } from "../../src/reaper.ts";

const storeDir = process.argv[2] as string;
startReaper(storeDir);
const shell = spawn("sh", ["-c", "sleep 30; echo late >> \"$0\"", `${storeDir}/late.txt`], { detached: true, stdio: "ignore" });
process.stdout.write(`${shell.pid}\n`);
setInterval(() => {}, 1000);
