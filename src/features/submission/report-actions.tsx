"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import en from "../../../messages/en.json";
import et from "../../../messages/et.json";
import type { Locale } from "@/domain/analysis";
export function ReportActions({locale,jobId,listingUrl=""}:{locale:Locale;jobId?:string;listingUrl?:string}) {
 const messages=locale === "en" ? en.Submission : et.Submission;
 const t=(key:keyof typeof messages)=>messages[key];const router=useRouter();
 const [manual,setManual]=useState(false);const [url,setUrl]=useState(listingUrl);const [text,setText]=useState("");
 const [pending,setPending]=useState(false);const [error,setError]=useState(false);const busy=useRef(false);
 async function create(captured:boolean) {
  if(busy.current) return;busy.current=true;setPending(true);setError(false);
  let navigating=false;
  try {
   const response=await fetch(captured?`/api/listings/${encodeURIComponent(jobId!)}/analysis`:"/api/analyses",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(captured?{locale}:{locale,listingUrl:url,pastedText:text})});
   const result=await response.json();
   if(!response.ok || typeof result.url!=="string" || !result.url.startsWith(`/${locale}/r/`)) throw new Error("Report unavailable");
   router.push(result.url);navigating=true;
  } catch {setError(true);} finally {if(!navigating){busy.current=false;setPending(false);}}
 }
 function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();void create(false);}
 return <section className="report-entry">
  <div className="report-actions">
   {jobId?<button className="primary-button" type="button" disabled={pending} onClick={()=>void create(true)}>{pending?t("pendingAction"):t("reportAction")}</button>:null}
   <button className="text-button" type="button" disabled={pending} aria-expanded={manual} onClick={()=>{if(!manual) setUrl(listingUrl);setManual(value=>!value);}}>{t("manual")}</button>
  </div>
  {manual?<form className="manual-panel" onSubmit={submit}>
   <h2>{t("manualTitle")}</h2><p className="field-note">{t("manualIntro")}</p>
   <label className="field-label" htmlFor="manual-url">{t("label")}</label>
   <input className="url-input" id="manual-url" type="url" required maxLength={2048} value={url} onChange={event=>setUrl(event.target.value)} placeholder={t("placeholder")} />
   <label className="field-label" htmlFor="manual-text">{t("pastedLabel")}</label>
   <textarea id="manual-text" maxLength={10000} value={text} onChange={event=>setText(event.target.value)} />
   <p className="field-note">{t("explanation")}</p>
   <button className="primary-button" type="submit" disabled={pending}>{pending?t("pendingAction"):t("action")}</button>
  </form>:null}
  {error?<p className="form-error" role="alert">{t("requestFailed")}</p>:null}
 </section>;
}
