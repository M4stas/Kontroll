import { expect, it, vi } from 'vitest';
import { LunaInsightProvider } from '@/insights/luna';
import type { InsightInput } from '@/insights/provider';
const evidence = {id:'e1',sourceId:'s1',sourceClass:'seller' as const,sourceUrl:'https://www.auto24.ee/soidukid/123',claim:'Service history complete',applicability:'unverified_input',confidence:0.5,verification:'unverified' as const,capturedAt:'2026-09-30T10:00:00Z'};
const input = {analysisId:'a1',vehicle:{provenance:{},conflicts:[]},evidence:[evidence]} as unknown as InsightInput;
it('rejects a registered external citation and requests no search tools', async()=>{
 const source={id:'invented',url:'https://manufacturer.example/recall',title:'Recall',sourceClass:'manufacturer',applicability:'model',confidence:0.8,observation:'Recall found'};
 const client={responses:{create:vi.fn().mockResolvedValue({output_text:JSON.stringify({schemaVersion:1,sources:[source],findings:[],imageObservations:[],warnings:[]})})}};
 const result=await new LunaInsightProvider(client as never,'configured').enrich(input);
 expect(result.sources).toEqual([]);
 expect(result.warnings[0]?.code).toBe('schema_invalid');
 expect(client.responses.create.mock.calls[0]?.[0].tools).toBeUndefined();
});
