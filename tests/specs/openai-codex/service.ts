import { expect, testSuite } from 'manten';

import { AIServiceError } from '../../../src/services/ai/ai.service.js';
import { OpenAICodexService } from '../../../src/services/ai/openai-codex.service.js';
import { initializeLogger } from '../../../src/utils/logger.js';

await initializeLogger({
    logging: false,
    logFilePath: '/tmp/aicommit2-openai-codex-test.log',
    exceptionLogFilePath: '/tmp/aicommit2-openai-codex-test-exceptions.log',
});

const createService = (model = 'gpt-5-codex') =>
    new OpenAICodexService({
        config: {
            model: [model],
            key: '',
            timeout: 1000,
            maxTokens: 128,
            temperature: 0.7,
            logging: false,
            stream: false,
            generate: 2,
            type: 'conventional',
            locale: 'en',
        } as any, // eslint-disable-line @typescript-eslint/no-explicit-any -- minimal provider config mock
        stagedDiff: {
            files: ['file.ts'],
            diff: 'diff --git a/file.ts b/file.ts',
        },
        keyName: 'OPENAI_CODEX',
    });

const mockCodex = (service: OpenAICodexService, thread: Record<string, unknown>) => {
    const calls: { threadOptions?: unknown; input?: unknown; turnOptions?: any } = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    (service as any).createCodex = () => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
        startThread: (threadOptions: unknown) => {
            calls.threadOptions = threadOptions;
            return {
                ...thread,
                run: async (input: unknown, turnOptions: unknown) => {
                    calls.input = input;
                    calls.turnOptions = turnOptions;
                    return (thread.run as (input: unknown, options: unknown) => Promise<unknown>)(input, turnOptions);
                },
                runStreamed: async (input: unknown, turnOptions: unknown) => {
                    calls.input = input;
                    calls.turnOptions = turnOptions;
                    return (thread.runStreamed as (input: unknown, options: unknown) => Promise<unknown>)(input, turnOptions);
                },
            };
        },
    });
    return calls;
};

const READ_ONLY_CODEX_ERROR =
    'Codex Exec exited with code 1:\n' +
    'WARNING: could not create PATH aliases: Read-only file system (os error 30)\n' +
    'Error: failed to initialize in-process app-server client: Read-only file system (os error 30)';

const getErrorChoice = (service: OpenAICodexService): Promise<any> => // eslint-disable-line @typescript-eslint/no-explicit-any
    new Promise((resolve, reject) => {
        service.generateCommitMessage$().subscribe({
            next: choice => {
                if (choice.isError) {
                    resolve(choice);
                }
            },
            error: reject,
        });
    });

export default testSuite(({ describe }) => {
    describe('openai codex service', ({ describe, test }) => {
        describe('thread safety options', ({ test }) => {
            test('uses read-only, offline, non-interactive settings', () => {
                const service = createService();
                const options = (service as any).createThreadOptions(); // eslint-disable-line @typescript-eslint/no-explicit-any

                expect(options.model).toBe('gpt-5-codex');
                expect(options.sandboxMode).toBe('read-only');
                expect(options.approvalPolicy).toBe('never');
                expect(options.networkAccessEnabled).toBe(false);
                expect(options.webSearchMode).toBe('disabled');
                expect(options.skipGitRepoCheck).toBe(true);
            });

            test('creates review and commit output schemas', () => {
                const service = createService();
                const signal = new AbortController().signal;
                const commitOptions = (service as any).createTurnOptions(signal, 'commit'); // eslint-disable-line @typescript-eslint/no-explicit-any
                const reviewOptions = (service as any).createTurnOptions(signal, 'review'); // eslint-disable-line @typescript-eslint/no-explicit-any

                expect(commitOptions.outputSchema.type).toBe('object');
                expect(commitOptions.outputSchema.required).toContain('messages');
                expect(reviewOptions.outputSchema.type).toBe('object');
                expect(reviewOptions.outputSchema.required).toContain('items');
            });

            test('assembles system and user prompts and passes the safe SDK options', async () => {
                const service = createService();
                const calls = mockCodex(service, {
                    run: async () => ({
                        finalResponse: '{"messages":[{"subject":"fix: generated","body":"","footer":""}]}',
                        items: [],
                        usage: null,
                    }),
                });

                const messages = await (service as any).generateMessage('commit'); // eslint-disable-line @typescript-eslint/no-explicit-any

                expect(messages[0].title).toBe('fix: generated');
                expect(calls.input).toContain('SYSTEM INSTRUCTIONS:');
                expect(calls.input).toContain('diff --git a/file.ts b/file.ts');
                expect(calls.turnOptions.outputSchema.type).toBe('object');
                expect(calls.turnOptions.outputSchema.required).toContain('messages');
                expect((calls.threadOptions as any).sandboxMode).toBe('read-only'); // eslint-disable-line @typescript-eslint/no-explicit-any
                expect((calls.threadOptions as any).approvalPolicy).toBe('never'); // eslint-disable-line @typescript-eslint/no-explicit-any
            });

            test('assembles review prompts and parses the review response', async () => {
                const service = createService();
                const calls = mockCodex(service, {
                    run: async () => ({
                        finalResponse: '{"summary":"No issues","items":[]}',
                        items: [],
                        usage: { output_tokens: 3 },
                    }),
                });

                const reviews = await (service as any).generateMessage('review'); // eslint-disable-line @typescript-eslint/no-explicit-any

                expect(reviews[0].title).toContain('No issues');
                expect(calls.input).toContain('SYSTEM INSTRUCTIONS:');
                expect(calls.turnOptions.outputSchema.type).toBe('object');
                expect(calls.turnOptions.outputSchema.required).toContain('items');
            });
        });

        describe('stream event handling', ({ test }) => {
            test('deduplicates cumulative agent-message updates', () => {
                const service = createService();
                const getDelta = (text: string, previous: string) =>
                    (service as any).getAgentMessageDelta( // eslint-disable-line @typescript-eslint/no-explicit-any
                        { type: 'item.updated', item: { type: 'agent_message', text } },
                        previous
                    );

                expect(getDelta('{"sub', '')).toBe('{"sub');
                expect(getDelta('{"subject":"fix"}', '{"sub')).toBe('ject":"fix"}');
                expect(getDelta('{"subject":"fix"}', '{"subject":"fix"}')).toBe('');
                expect(getDelta('reasoning', '{"subject":"fix"}')).toBe('reasoning');
            });

            test('ignores non-agent stream items', () => {
                const service = createService();
                const delta = (service as any).getAgentMessageDelta( // eslint-disable-line @typescript-eslint/no-explicit-any
                    { type: 'item.completed', item: { type: 'command_execution', id: '1', command: 'pwd', aggregated_output: '', status: 'completed' } },
                    ''
                );

                expect(delta).toBe('');
            });

            test('streams cumulative agent-message events without duplicating text', async () => {
                const service = createService();
                (service as any).params.config.stream = true; // eslint-disable-line @typescript-eslint/no-explicit-any
                (service as any).createCodex = () => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
                    startThread: () => ({
                        runStreamed: async (_input: unknown, options: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
                            events: (async function* () {
                                yield { type: 'item.updated', item: { type: 'agent_message', text: '{"messages":[{"sub' } };
                                yield { type: 'item.updated', item: { type: 'agent_message', text: '{"messages":[{"subject":"fix: streamed","body":"","footer":""}]' } };
                                yield { type: 'item.completed', item: { type: 'agent_message', text: '{"messages":[{"subject":"fix: streamed","body":"","footer":""}]}' } };
                                yield { type: 'turn.completed', usage: null };
                            })(),
                            signal: options.signal,
                        }),
                    }),
                });

                const choices: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
                await new Promise<void>((resolve, reject) => {
                    service.generateCommitMessage$().subscribe({
                        next: choice => choices.push(choice),
                        error: reject,
                        complete: resolve,
                    });
                });

                const finalChoice = choices.find(choice => choice.value === 'fix: streamed');
                expect(finalChoice).toBeTruthy();
                expect(choices.filter(choice => choice.value === 'fix: streamed')).toHaveLength(1);
            });

            test('aborts the Codex turn when the stream subscription is cancelled', async () => {
                const service = createService();
                (service as any).params.config.stream = true; // eslint-disable-line @typescript-eslint/no-explicit-any
                let turnSignal: AbortSignal | undefined;
                (service as any).createCodex = () => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
                    startThread: () => ({
                        runStreamed: async (_input: unknown, options: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
                            turnSignal = options.signal;
                            return {
                                events: (async function* () {
                                    await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
                                    yield { type: 'turn.completed', usage: null };
                                })(),
                            };
                        },
                    }),
                });

                const subscription = service.generateCommitMessage$().subscribe();
                await new Promise(resolve => setImmediate(resolve));
                subscription.unsubscribe();
                await new Promise(resolve => setImmediate(resolve));

                expect(turnSignal?.aborted).toBe(true);
            });
        });

        describe('errors', ({ test }) => {
            test('provides actionable Codex error messages', () => {
                const service = createService();
                const getMessage = (code?: AIServiceError['code'], message = '') => {
                    const error = new Error(message) as AIServiceError;
                    error.code = code;
                    return (service as any).getServiceSpecificErrorMessage(error); // eslint-disable-line @typescript-eslint/no-explicit-any
                };

                expect(getMessage('CLI_NOT_INSTALLED')).toContain('Codex CLI');
                expect(getMessage('AUTH_FAILED')).toContain('codex login');
                expect(getMessage('TIMEOUT')).toContain('timed out');
                expect(getMessage('NO_CONTENT')).toContain('no response');
            });

            test('maps empty SDK output to NO_CONTENT', async () => {
                const service = createService();
                mockCodex(service, {
                    run: async () => ({ finalResponse: '  ', items: [], usage: null }),
                });

                let error: any; // eslint-disable-line @typescript-eslint/no-explicit-any
                try {
                    await (service as any).generateMessage('commit'); // eslint-disable-line @typescript-eslint/no-explicit-any
                } catch (caught) {
                    error = caught;
                }

                expect(error.code).toBe('NO_CONTENT');
            });

            test('maps SDK authentication, CLI, and model failures', async () => {
                const cases = [
                    ['unauthorized API key', 'AUTH_FAILED'],
                    ['spawn codex ENOENT', 'CLI_NOT_INSTALLED'],
                    ['model not found', 'MODEL_NOT_FOUND'],
                    ['Codex Exec exited with code 1', undefined],
                ] as const;

                for (const [message, code] of cases) {
                    const service = createService();
                    mockCodex(service, {
                        run: async () => {
                            throw new Error(message);
                        },
                    });

                    let error: any; // eslint-disable-line @typescript-eslint/no-explicit-any
                    try {
                        await (service as any).generateMessage('commit'); // eslint-disable-line @typescript-eslint/no-explicit-any
                    } catch (caught) {
                        error = caught;
                    }

                    expect(error.code).toBe(code);
                }
            });

            test('reports read-only Codex initialization failures accurately for non-streaming requests', async () => {
                const service = createService();
                mockCodex(service, {
                    run: async () => {
                        throw new Error(READ_ONLY_CODEX_ERROR);
                    },
                });

                const choice = await getErrorChoice(service);

                expect(choice.value).toContain('state directory is read-only');
                expect(choice.value).toContain('writable HOME/CODEX_HOME');
                expect(choice.value).not.toContain('runtime not found');
                expect(choice.value).not.toContain('CLI_NOT_INSTALLED');
            });

            test('reports read-only Codex initialization failures accurately for streaming requests', async () => {
                const service = createService();
                (service as any).params.config.stream = true; // eslint-disable-line @typescript-eslint/no-explicit-any
                mockCodex(service, {
                    runStreamed: async () => {
                        throw new Error(READ_ONLY_CODEX_ERROR);
                    },
                });

                const choice = await getErrorChoice(service);

                expect(choice.value).toContain('state directory is read-only');
                expect(choice.value).toContain('writable HOME/CODEX_HOME');
                expect(choice.value).not.toContain('runtime not found');
                expect(choice.value).not.toContain('CLI_NOT_INSTALLED');
            });

            test('aborts and reports TIMEOUT when the SDK turn exceeds the timeout', async () => {
                const service = createService();
                (service as any).params.config.timeout = 10; // eslint-disable-line @typescript-eslint/no-explicit-any
                let aborted = false;
                mockCodex(service, {
                    run: async (_input: unknown, options: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
                        await new Promise<void>(resolve => options.signal.addEventListener('abort', () => {
                            aborted = true;
                            resolve();
                        }, { once: true }));
                        throw new Error('aborted');
                    },
                });

                let error: any; // eslint-disable-line @typescript-eslint/no-explicit-any
                try {
                    await (service as any).generateMessage('commit'); // eslint-disable-line @typescript-eslint/no-explicit-any
                } catch (caught) {
                    error = caught;
                }

                expect(aborted).toBe(true);
                expect(error.code).toBe('TIMEOUT');
            });
        });
    });
});
