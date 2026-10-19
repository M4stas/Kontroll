import { afterEach, expect, it, vi } from "vitest";
import { ensureWorker, cacheShells, releaseWorkerIfEmpty } from "@/features/offline/worker-client";
import * as db from "@/features/offline/saved-reports-db";
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});
it("ensureWorker registers /sw.js with scope /", async () => {
 const registration = {active:{scriptURL:`${location.origin}/sw.js`,state:"activated"}};
 const register=vi.fn().mockResolvedValue(registration);
 vi.stubGlobal("navigator", {serviceWorker:{register}});
 expect(await ensureWorker()).toBe(registration);
 expect(register).toHaveBeenCalledWith("/sw.js",{scope:"/"});
});
it("ensureWorker returns null without serviceWorker", async () => {
 vi.stubGlobal("navigator",{}); expect(await ensureWorker()).toBeNull();
});
it("cacheShells posts cache-shells and resolves the reply", async () => {
 const postMessage=vi.fn((_data,ports)=>ports[0].postMessage({ok:true}));
 vi.stubGlobal("navigator",{serviceWorker:{register:vi.fn().mockResolvedValue({active:{scriptURL:`${location.origin}/sw.js`,state:"activated",postMessage}})}});
 expect(await cacheShells("A")).toBe(true);
 expect(postMessage.mock.calls[0]![0]).toEqual({type:"cache-shells",publicId:"A"});
});
it("releaseWorkerIfEmpty unregisters only when nothing is saved", async () => {
 const unregister=vi.fn();
 vi.stubGlobal("navigator",{serviceWorker:{getRegistration:vi.fn().mockResolvedValue({active:{scriptURL:`${location.origin}/sw.js`},unregister})}});
 vi.spyOn(db,"hasLiveSavedReports").mockResolvedValue(true);
 await releaseWorkerIfEmpty(); expect(unregister).not.toHaveBeenCalled();
 vi.mocked(db.hasLiveSavedReports).mockResolvedValue(false);
 await releaseWorkerIfEmpty(); expect(unregister).toHaveBeenCalledOnce();
});
it("does not unregister another application's worker", async () => {
 const unregister=vi.fn();
 vi.stubGlobal("navigator",{serviceWorker:{getRegistration:vi.fn().mockResolvedValue({active:{scriptURL:`${location.origin}/other.js`},unregister})}});
 vi.spyOn(db,"hasLiveSavedReports").mockResolvedValue(false);
 await releaseWorkerIfEmpty(); expect(unregister).not.toHaveBeenCalled();
});
it("installation becoming redundant resolves false without waiting on ready", async () => {
 const worker = new EventTarget() as EventTarget & {scriptURL:string;state:string};
 worker.scriptURL=`${location.origin}/sw.js`;worker.state="installing";
 vi.stubGlobal("navigator",{serviceWorker:{register:vi.fn().mockResolvedValue({installing:worker}),ready:new Promise(()=>{})}});
 const result=cacheShells("A");
 await new Promise(resolve=>setTimeout(resolve,0));
 worker.state="redundant";worker.dispatchEvent(new Event("statechange"));
 expect(await result).toBe(false);
});
it("bounds a worker registration that never settles", async () => {
 vi.useFakeTimers();
 vi.stubGlobal("navigator",{serviceWorker:{register:vi.fn(()=>new Promise(()=>{}))}});
 const result=ensureWorker(); await vi.advanceTimersByTimeAsync(4000);
 expect(await result).toBeNull();vi.useRealTimers();
});
it("release deletes only app cache names", async () => {
 vi.spyOn(db,"hasLiveSavedReports").mockResolvedValue(false);
 vi.stubGlobal("navigator",{});
 const deleteCache=vi.fn().mockResolvedValue(true);
 vi.stubGlobal("caches",{keys:async()=>["kontroll-offline-old","another-app"],delete:deleteCache});
 await releaseWorkerIfEmpty();
 expect(deleteCache).toHaveBeenCalledExactlyOnceWith("kontroll-offline-old");
});
it("sends shell changes to both active and waiting app workers", async () => {
 const active=vi.fn((_data,ports)=>ports[0].postMessage({ok:true}));
 const waiting=vi.fn((_data,ports)=>ports[0].postMessage({ok:true}));
 vi.stubGlobal("navigator",{serviceWorker:{register:vi.fn().mockResolvedValue({
  active:{scriptURL:`${location.origin}/sw.js`,state:"activated",postMessage:active},
  waiting:{scriptURL:`${location.origin}/sw.js`,state:"installed",postMessage:waiting},
 })}});
 expect(await cacheShells("A")).toBe(true);
 expect(active).toHaveBeenCalledOnce();expect(waiting).toHaveBeenCalledOnce();
});
