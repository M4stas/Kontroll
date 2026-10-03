import {render,waitFor,cleanup} from "@testing-library/react";
import {afterEach,it,expect,vi} from "vitest";
import {AccessBootstrap} from "@/features/report/access-bootstrap";
const reload=vi.fn();
function mockReload(){
 const original=window;
 const location={get pathname(){return original.location.pathname;},get search(){return original.location.search;},get hash(){return original.location.hash;},reload};
 vi.stubGlobal("window",new Proxy(original,{get(target,key){return key === "location" ? location : Reflect.get(target,key,target);}}));
}
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.clearAllMocks();window.history.replaceState(null,"","/");});
it("removes the private fragment only after successful cookie exchange",async()=>{
 window.history.replaceState(null,"","/en/r/report#access=private-token");mockReload();
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true}));render(<AccessBootstrap publicId="report" />);
 await waitFor(()=>expect(reload).toHaveBeenCalled());expect(window.location.hash).toBe("");
});
it("keeps the original token link when exchange fails so reload can retry",async()=>{
 window.history.replaceState(null,"","/en/r/report#access=private-token");mockReload();
 const fetch=vi.fn().mockResolvedValue({ok:false});vi.stubGlobal("fetch",fetch);render(<AccessBootstrap publicId="report" />);
 await waitFor(()=>expect(fetch).toHaveBeenCalled());expect(window.location.hash).toBe("#access=private-token");expect(reload).not.toHaveBeenCalled();
});
