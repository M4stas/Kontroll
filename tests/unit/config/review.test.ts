import { describe, it, expect } from 'vitest';
import { isProductionImageSettingsAllowed, resolveProductionReviewConfig, resolveReviewConfig } from '@/config/review';
const capabilities = { openai: { text: { responses: true, text: true, structuredOutput: true, imageInput: false, efforts: ['low'] }, vision: { responses: true, text: true, structuredOutput: true, imageInput: true, efforts: ['high'] } } } as const;
const base = { OPENAI_API_KEY: 'secret', DATA_REVIEW_MODEL: 'vision' };
describe('review resolver', () => {
    it('unifies settings and aliases final to text', () => { const r = resolveReviewConfig(base, capabilities); expect(r.status).toBe('enabled'); if (r.status === 'enabled') {
        expect(r.image).toEqual(r.text);
        expect(r.final).toBe(r.text);
    } });
    it('isolates unavailable image from ready text', () => { const r = resolveReviewConfig({ ...base, DATA_REVIEW_MODE: 'split', DATA_REVIEW_TEXT_MODEL: 'text', DATA_REVIEW_IMAGE_MODEL: 'unknown' }, capabilities); if (r.status === 'enabled') {
        expect(r.text.status).toBe('ready');
        expect(r.image.status).toBe('unavailable');
    } });
    it('checks credentials, vision and efforts', () => { for (const extra of [{ OPENAI_API_KEY: '' }, { DATA_REVIEW_MODEL: 'text' }, { DATA_REVIEW_REASONING_EFFORT: 'low' }]) {
        const r = resolveReviewConfig({ ...base, ...extra }, capabilities);
        if (r.status === 'enabled')
            expect(r.image.status).toBe('unavailable');
    } });
    it('disabled ignores malformed config', () => expect(resolveReviewConfig({ DATA_REVIEW_ENABLED: 'false', DATA_REVIEW_CAPABILITIES: 'oops' }, capabilities)).toEqual({ status: 'disabled' }));
    it('rejects invalid controls and unified overrides', () => { for (const extra of [{ DATA_REVIEW_ENABLED: 'yes' }, { DATA_REVIEW_MODE: 'bad' }, { DATA_REVIEW_TEXT_MODEL: 'text' }])
        expect(resolveReviewConfig({ ...base, ...extra }, capabilities).status).toBe('unavailable'); });
    it('inherits split defaults and omits unset effort', () => { const r = resolveReviewConfig({ ...base, DATA_REVIEW_MODE: 'split' }, capabilities); if (r.status === 'enabled') {
        expect(r.text).toEqual(r.image);
        if (r.text.status === 'ready')
            expect(r.text.effort).toBeUndefined();
    } });
    it('accepts explicit developer capabilities for unknown models', () => { const r = resolveReviewConfig({ ...base, DATA_REVIEW_MODEL: 'new', DATA_REVIEW_CAPABILITIES: JSON.stringify({ openai: { new: capabilities.openai.vision } }) }); if (r.status === 'enabled')
        expect(r.text.status).toBe('ready'); });
});
it('canonical model wins over legacy and blank falls back', () => {
    for (const [canonical, expected] of [['text', 'text'], ['  ', 'vision']]) {
        const result = resolveReviewConfig({ ...base, OPENAI_INSIGHT_MODEL: 'vision', DATA_REVIEW_MODEL: canonical }, capabilities);
        if (result.status === 'enabled' && result.text.status === 'ready')
            expect(result.text.model).toBe(expected);
    }
});
it('does not cache credentials or settings', () => {
    const first = resolveReviewConfig(base, capabilities);
    const second = resolveReviewConfig({ ...base, OPENAI_API_KEY: '' }, capabilities);
    if (first.status === 'enabled')
        expect(first.text.status).toBe('ready');
    if (second.status === 'enabled')
        expect(second.text.status).toBe('unavailable');
});
it('split effort and provider failures only affect their pass', () => {
    const result = resolveReviewConfig({ ...base, DATA_REVIEW_MODE: 'split', DATA_REVIEW_TEXT_REASONING_EFFORT: 'high', DATA_REVIEW_IMAGE_PROVIDER: 'other' }, capabilities);
    if (result.status === 'enabled') {
        expect(result.text.status).toBe('ready');
        expect(result.final).toBe(result.text);
        expect(result.image).toEqual({ status: 'unavailable', code: 'unsupported_provider' });
    }
});
it('rejects malformed developer capability assertions', () => {
    for (const declaration of ['oops', JSON.stringify({ openai: { new: { ...capabilities.openai.vision, extra: true } } }), JSON.stringify({ openai: { new: { ...capabilities.openai.vision, efforts: ['unbounded'] } } })])
        expect(resolveReviewConfig({ ...base, DATA_REVIEW_CAPABILITIES: declaration }).status).toBe('unavailable');
});


describe('production review resolver', () => {
    const codexVision = { responses: false, text: true, structuredOutput: true, imageInput: true, efforts: ['xhigh', 'max'] } as const;
    const productionRegistry = {
        codex: { 'gpt-6-luna': codexVision },
        openai: { text: { responses: true, text: true, structuredOutput: true, imageInput: false, efforts: ['low', 'max'] } },
    } as const;
    const declared = JSON.stringify({ codex: { 'gpt-6-luna': codexVision } });
    const declaredWithHigh = JSON.stringify({ codex: { 'gpt-6-luna': { ...codexVision, efforts: ['high', 'xhigh', 'max'] } } });

    it('caps the image pass at Luna xhigh while preserving unified text and final settings', () => {
        const result = resolveProductionReviewConfig({
            DATA_REVIEW_PROVIDER: 'codex',
            DATA_REVIEW_MODEL: 'gpt-6-luna',
            DATA_REVIEW_REASONING_EFFORT: 'max',
            DATA_REVIEW_IMAGE_PROVIDER: 'openai',
            DATA_REVIEW_IMAGE_MODEL: 'vision',
            DATA_REVIEW_CAPABILITIES: declared,
        }, productionRegistry);
        expect(result.status).toBe('enabled');
        if (result.status === 'enabled') {
            expect(result.mode).toBe('split');
            expect(result.text).toMatchObject({ status: 'ready', provider: 'codex', model: 'gpt-6-luna', effort: 'max' });
            expect(result.image).toMatchObject({ status: 'ready', provider: 'codex', model: 'gpt-6-luna', effort: 'xhigh' });
            expect(result.final).toBe(result.text);
        }
    });

    it('allows a lower explicit production image effort', () => {
        const result = resolveProductionReviewConfig({
            DATA_REVIEW_PROVIDER: 'openai',
            OPENAI_API_KEY: 'secret',
            DATA_REVIEW_MODEL: 'text',
            DATA_REVIEW_REASONING_EFFORT: 'low',
            DATA_REVIEW_MODE: 'split',
            DATA_REVIEW_IMAGE_REASONING_EFFORT: 'high',
            DATA_REVIEW_CAPABILITIES: declaredWithHigh,
        }, productionRegistry);
        if (result.status === 'enabled')
            expect(result.image).toMatchObject({ status: 'ready', provider: 'codex', model: 'gpt-6-luna', effort: 'high' });
    });

    it('keeps text ready and makes an over-ceiling image effort unavailable', () => {
        const result = resolveProductionReviewConfig({
            DATA_REVIEW_PROVIDER: 'openai',
            OPENAI_API_KEY: 'secret',
            DATA_REVIEW_MODEL: 'text',
            DATA_REVIEW_REASONING_EFFORT: 'low',
            DATA_REVIEW_IMAGE_REASONING_EFFORT: 'max',
            DATA_REVIEW_CAPABILITIES: declared,
        }, productionRegistry);
        if (result.status === 'enabled') {
            expect(result.text.status).toBe('ready');
            expect(result.final).toBe(result.text);
            expect(result.image).toEqual({ status: 'unavailable', code: 'unsupported_reasoning' });
        }
    });

    it('requires an explicit Luna capability declaration including xhigh', () => {
        const fromRegistryOnly = resolveProductionReviewConfig({
            DATA_REVIEW_PROVIDER: 'openai',
            OPENAI_API_KEY: 'secret',
            DATA_REVIEW_MODEL: 'text',
            DATA_REVIEW_REASONING_EFFORT: 'low',
        }, productionRegistry);
        if (fromRegistryOnly.status === 'enabled')
            expect(fromRegistryOnly.image).toEqual({ status: 'unavailable', code: 'unknown_model' });

        const withoutXhigh = resolveProductionReviewConfig({
            DATA_REVIEW_PROVIDER: 'openai',
            OPENAI_API_KEY: 'secret',
            DATA_REVIEW_MODEL: 'text',
            DATA_REVIEW_REASONING_EFFORT: 'low',
            DATA_REVIEW_CAPABILITIES: JSON.stringify({ codex: { 'gpt-6-luna': { ...codexVision, efforts: ['high'] } } }),
        }, productionRegistry);
        if (withoutXhigh.status === 'enabled')
            expect(withoutXhigh.image).toEqual({ status: 'unavailable', code: 'unsupported_reasoning' });
    });

    it('honors disabled review before validating production image settings', () => {
        expect(resolveProductionReviewConfig({
            DATA_REVIEW_ENABLED: 'false',
            DATA_REVIEW_CAPABILITIES: 'invalid',
            DATA_REVIEW_IMAGE_REASONING_EFFORT: 'max',
        }, productionRegistry)).toEqual({ status: 'disabled' });
    });
});


describe('production image settings guard', () => {
    it('allows explicit Luna settings at or below xhigh', () => {
        expect(isProductionImageSettingsAllowed({ provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'xhigh' })).toBe(true);
        expect(isProductionImageSettingsAllowed({ provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'low' })).toBe(true);
    });

    it('rejects settings without an explicit approved model and bounded effort', () => {
        for (const settings of [
            {},
            { provider: 'codex', model: 'gpt-6-luna' },
            { provider: 'openai', model: 'gpt-6-luna', reasoningEffort: 'xhigh' },
            { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' },
            { provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'max' },
            { provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'unknown' },
        ])
            expect(isProductionImageSettingsAllowed(settings)).toBe(false);
    });
});
