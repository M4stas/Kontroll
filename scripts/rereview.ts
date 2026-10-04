import nextEnv from '@next/env';
import {createClient} from '@supabase/supabase-js';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {z} from 'zod';
import {parseApplicationEnv} from '@/config/application';
import {AnalysesRepository} from '@/server/repositories/analyses';

export async function requestDeveloperRereview(publicId:string,repository:Pick<AnalysesRepository,'loadAnalysisId'|'developerRereview'>):Promise<{publicId:string;runId:string}>{
 z.uuid().parse(publicId);
 const analysisId=await repository.loadAnalysisId(publicId);
 if(!analysisId)throw new Error('Private report not found');
 return {publicId,runId:await repository.developerRereview(analysisId)};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
 try{
  nextEnv.loadEnvConfig(process.cwd());
  const env=parseApplicationEnv(process.env);
  const client=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{autoRefreshToken:false,persistSession:false}});
  const result=await requestDeveloperRereview(process.argv[2]??'',new AnalysesRepository(client));
  console.log(JSON.stringify(result));
 }catch{console.error('Developer rereview failed. Check the report ID and private server configuration.');process.exitCode=1;}
}
