// @vitest-environment node
import {execFileSync} from "node:child_process";
import {expect,it} from "vitest";
it("loads the background worker modules under the real tsx runtime",()=>{
 expect(()=>execFileSync(process.execPath,["--import","tsx","--input-type=module","-e",'await Promise.all([import("./src/listings/background-check.ts"),import("./src/analysis/background-check-stage.ts"),import("./src/server/repositories/background-checks.ts")]);'],{cwd:process.cwd(),stdio:"pipe"})).not.toThrow();
});
