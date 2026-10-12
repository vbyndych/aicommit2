import { expect, testSuite } from 'manten';

import { getAvailableAIs } from '../../../src/commands/get-available-ais.js';
import { BUILTIN_SERVICES, SUBSCRIPTION_CLI_SERVICES } from '../../../src/utils/config.js';

const providerConfig = (overrides: Record<string, unknown> = {}) => ({
    OPENAI_CODEX: {
        model: [],
        key: '',
        disabled: false,
        codeReview: true,
        watchMode: true,
        ...overrides,
    },
});

export default testSuite(({ describe }) => {
    describe('openai codex configuration', ({ test }) => {
        test('registers as a built-in subscription CLI provider', () => {
            expect(BUILTIN_SERVICES).toContain('OPENAI_CODEX');
            expect(SUBSCRIPTION_CLI_SERVICES).toContain('OPENAI_CODEX');
        });

        test('is opt-in and becomes available with a model or API key', () => {
            expect(getAvailableAIs(providerConfig() as any, 'commit')).not.toContain('OPENAI_CODEX'); // eslint-disable-line @typescript-eslint/no-explicit-any
            expect(getAvailableAIs(providerConfig({ model: ['gpt-5-codex'] }) as any, 'commit')).toContain('OPENAI_CODEX'); // eslint-disable-line @typescript-eslint/no-explicit-any
            expect(getAvailableAIs(providerConfig({ key: 'sk-test' }) as any, 'commit')).toContain('OPENAI_CODEX'); // eslint-disable-line @typescript-eslint/no-explicit-any
        });

        test('requires codeReview for review availability', () => {
            expect(getAvailableAIs(providerConfig({ model: ['gpt-5-codex'], codeReview: false }) as any, 'review')).not.toContain('OPENAI_CODEX'); // eslint-disable-line @typescript-eslint/no-explicit-any
            expect(getAvailableAIs(providerConfig({ model: ['gpt-5-codex'], codeReview: true }) as any, 'review')).toContain('OPENAI_CODEX'); // eslint-disable-line @typescript-eslint/no-explicit-any
        });

        test('requires watchMode for watch availability', () => {
            expect(getAvailableAIs(providerConfig({ model: ['gpt-5-codex'], watchMode: false }) as any, 'watch')).not.toContain('OPENAI_CODEX'); // eslint-disable-line @typescript-eslint/no-explicit-any
            expect(getAvailableAIs(providerConfig({ model: ['gpt-5-codex'], watchMode: true }) as any, 'watch')).toContain('OPENAI_CODEX'); // eslint-disable-line @typescript-eslint/no-explicit-any
        });
    });
});
