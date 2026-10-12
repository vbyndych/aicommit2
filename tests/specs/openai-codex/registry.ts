import { expect, testSuite } from 'manten';

import { ProviderRegistry } from '../../../src/services/ai/provider-registry.js';

export default testSuite(({ describe }) => {
    describe('openai codex provider registry', ({ test }) => {
        test('lazy-loads OpenAICodexService', async () => {
            const service = await ProviderRegistry.createService('OPENAI_CODEX' as any, { // eslint-disable-line @typescript-eslint/no-explicit-any
                config: {
                    model: ['gpt-5-codex'],
                    key: '',
                    timeout: 1000,
                    logging: false,
                } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
                stagedDiff: { files: [], diff: '' },
                keyName: 'OPENAI_CODEX' as any, // eslint-disable-line @typescript-eslint/no-explicit-any
            });

            expect(service?.constructor.name).toBe('OpenAICodexService');
        });
    });
});
