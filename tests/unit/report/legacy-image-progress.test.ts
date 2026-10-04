import { expect, it } from "vitest";
import type { ReviewProgress } from "@/domain/analysis";
import { legacyImageProgress } from "@/features/report/legacy-image-progress";

const review: ReviewProgress = {state:"complete",text:"complete",images:{supplied:3,selected:1,complete:1,unavailable:1,skipped:1},final:"complete"};
const snapshot = (images: unknown[], owner="analysis") => ({analysis_id:owner,snapshot:{analysisId:owner,imageManifest:{images}}});
const images = [{evidenceId:"selected",selected:true,status:"accepted"},{evidenceId:"missing",selected:false,status:"unavailable"},{evidenceId:"excluded",selected:false,status:"skipped"}];
it("adds completion states to a legacy complete report without changing counts",()=>{
 const result=legacyImageProgress("analysis",review,[snapshot(images)]);
 expect(result.images.items).toEqual([{evidenceId:"selected",state:"complete"},{evidenceId:"missing",state:"unavailable"},{evidenceId:"excluded",state:"skipped"}]);
 expect(result.images.complete).toBe(1);expect(review.images.items).toBeUndefined();
});
it("uses explicit committed evidence IDs instead of guessing from aggregate counts",()=>{
 const running={...review,state:"running" as const,images:{...review.images,selected:2}};
 const result=legacyImageProgress("analysis",running,[snapshot([...images,{evidenceId:"second",selected:true,status:"accepted"}])],["second"]);
 expect(result.images.items).toEqual([{evidenceId:"selected",state:"pending"},{evidenceId:"missing",state:"unavailable"},{evidenceId:"excluded",state:"skipped"},{evidenceId:"second",state:"complete"}]);
});
it("preserves existing progress items exactly",()=>{
 const current={...review,images:{...review.images,items:[{evidenceId:"selected",state:"running" as const}]}};
 expect(legacyImageProgress("analysis",current,[snapshot(images)])).toBe(current);
});
it("uses the newest valid owned snapshot and rejects mismatched owners",()=>{
 const rows=[snapshot(images,"foreign"),{...snapshot(images),snapshot:{...snapshot(images).snapshot,analysisId:"foreign"}},snapshot([{evidenceId:"newest",selected:true,status:"accepted"}]),snapshot(images)];
 expect(legacyImageProgress("analysis",review,rows).images.items).toEqual([{evidenceId:"newest",state:"complete"}]);
});
it("leaves legacy progress unchanged when no owned manifest is valid",()=>{
 expect(legacyImageProgress("analysis",review,[{analysis_id:"analysis",snapshot:{analysisId:"analysis",imageManifest:{images:[{evidenceId:"x",selected:true,status:"unknown"}]}}}])).toBe(review);
});
it("marks rejected photos unavailable and accepted unselected photos skipped",()=>{
 const result=legacyImageProgress("analysis",{...review,state:"incomplete"},[snapshot([{evidenceId:"rejected",selected:false,status:"rejected"},{evidenceId:"unused",selected:false,status:"accepted"}])]);
 expect(result.images.items).toEqual([{evidenceId:"rejected",state:"unavailable"},{evidenceId:"unused",state:"skipped"}]);
});
