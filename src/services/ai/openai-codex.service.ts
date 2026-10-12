import { Codex, ThreadEvent, ThreadItem, ThreadOptions, TurnOptions } from '@openai/codex-sdk';
import chalk from 'chalk';
import { ReactiveListChoice } from 'inquirer-reactive-list-prompt';
import { Observable, Subject, catchError, concatMap, from, map } from 'rxjs';
import { fromPromise } from 'rxjs/internal/observable/innerFrom';

import { AIResponse, AIService, AIServiceError, AIServiceParams } from './ai.service.js';
import { RequestType, logAIComplete, logAIError, logAIPayload, logAIPrompt, logAIRequest, logAIResponse } from '../../utils/ai-log.js';
import { DEFAULT_OPENAI_CODEX_MODEL } from '../../utils/config.js';
import { ErrorCode } from '../../utils/error-messages.js';
import { codeReviewPrompt, generatePrompt } from '../../utils/prompt.js';
import { safeJsonParse } from '../../utils/utils.js';

const COMMIT_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        messages: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    subject: { type: 'string' },
                    body: { type: 'string' },
                    footer: { type: 'string' },
                },
                required: ['subject', 'body', 'footer'],
                additionalProperties: false,
            },
        },
    },
    required: ['messages'],
    additionalProperties: false,
} as const;

const REVIEW_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        summary: { type: 'string' },
        items: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    severity: { type: 'string' },
                    category: { type: 'string' },
                    file: { type: 'string' },
                    line: { type: 'string' },
                    title: { type: 'string' },
                    description: { type: 'string' },
                    suggestion: { type: 'string' },
                },
                required: ['severity', 'category', 'file', 'line', 'title', 'description', 'suggestion'],
                additionalProperties: false,
            },
        },
    },
    required: ['summary', 'items'],
    additionalProperties: false,
} as const;

const getModel = (model: string | string[] | undefined): string => (Array.isArray(model) ? model[0] : model) || DEFAULT_OPENAI_CODEX_MODEL;

const getErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const asAIServiceError = (error: unknown, code?: AIServiceError['code']): AIServiceError => {
    const aiError = error instanceof Error ? (error as AIServiceError) : (new Error(String(error)) as AIServiceError);
    if (code) {
        aiError.code = code;
    }
    return aiError;
};

export class OpenAICodexService extends AIService {
    constructor(protected readonly params: AIServiceParams) {
        super(params);
        this.colors = {
            primary: '#74AA9C',
            secondary: '#FFF',
        };
        this.serviceName = chalk.bgHex(this.colors.primary).hex(this.colors.secondary).bold(`[OpenAI Codex${this.formatModelSuffix()}]`);
        this.errorPrefix = chalk.red.bold(`[OpenAI Codex${this.formatModelSuffix()}]`);
    }

    protected getServiceSpecificErrorMessage(error: AIServiceError): string | null {
        const message = error.message || '';
        if (/\bEROFS\b|read-only file system|failed to initialize.*app-server/i.test(message)) {
            return 'Codex CLI started but could not initialize because its state directory is read-only. Configure writable HOME/CODEX_HOME and XDG state directories.';
        }

        switch (error.code) {
            case ErrorCode.CLI_NOT_INSTALLED:
                return 'Codex CLI runtime not found. Reinstall @openai/codex-sdk and its bundled Codex runtime.';
            case ErrorCode.AUTH_FAILED:
            case ErrorCode.INVALID_API_KEY:
                return 'Codex authentication failed. Run `codex login` or configure OPENAI_CODEX.key.';
            case ErrorCode.MODEL_NOT_FOUND:
            case ErrorCode.MODEL_ACCESS_DENIED:
                return 'Codex model is unavailable or inaccessible. Check OPENAI_CODEX.model and account access.';
            case ErrorCode.TIMEOUT:
                return `Codex request timed out after ${this.params.config.timeout}ms.`;
            case ErrorCode.NO_CONTENT:
                return 'Codex returned no response content.';
            default:
                break;
        }

        if (/\bENOENT\b|spawn(?:Sync)? .*ENOENT|codex (?:binary|executable).*(?:missing|not found)/i.test(message)) {
            return 'Codex CLI runtime not found. Reinstall @openai/codex-sdk and its bundled Codex runtime.';
        }
        if (/auth|unauthori[sz]ed|invalid api key|token/i.test(message)) {
            return 'Codex authentication failed. Run `codex login` or configure OPENAI_CODEX.key.';
        }
        if (/model.*(not found|unavailable)|access denied|forbidden/i.test(message)) {
            return 'Codex model is unavailable or inaccessible. Check OPENAI_CODEX.model and account access.';
        }
        if (/timed out|timeout|aborted/i.test(message)) {
            return `Codex request timed out after ${this.params.config.timeout}ms.`;
        }
        return null;
    }

    generateCommitMessage$(): Observable<ReactiveListChoice> {
        if (this.params.config.stream) {
            return this.generateStreamingCommitMessage$();
        }

        return fromPromise(this.generateMessage('commit')).pipe(
            concatMap(messages => from(messages)),
            map(this.formatAsChoice),
            catchError(this.handleError$)
        );
    }

    generateCodeReview$(): Observable<ReactiveListChoice> {
        return fromPromise(this.generateMessage('review')).pipe(
            concatMap(messages => from(messages)),
            map(this.formatCodeReviewAsChoice),
            catchError(this.handleError$)
        );
    }

    private generateStreamingCommitMessage$ = (): Observable<ReactiveListChoice> => {
        const { generate, type } = this.params.config;

        return this.createStreamingCommitMessages$(
            (subject, signal) => {
                this.streamCommit(subject, signal).catch(error => subject.error(error));
            },
            type,
            generate
        );
    };

    private createCodex = (): Codex => {
        const key = this.params.config.key?.trim();
        return new Codex({ apiKey: key || undefined });
    };

    private createThreadOptions = (): ThreadOptions => ({
        model: getModel(this.params.config.model),
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        workingDirectory: process.cwd(),
        modelReasoningEffort: 'low',
        skipGitRepoCheck: true,
    });

    private createTurnOptions = (signal: AbortSignal, requestType: RequestType): TurnOptions => ({
        signal,
        outputSchema: requestType === 'review' ? REVIEW_OUTPUT_SCHEMA : COMMIT_OUTPUT_SCHEMA,
    });

    private createTimeoutController = (): { controller: AbortController; timeoutId: NodeJS.Timeout } => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.params.config.timeout);
        return { controller, timeoutId };
    };

    private buildInput = (systemPrompt: string, userPrompt: string): string =>
        [
            'You are generating a response for aicommit2. Do not inspect, modify, or execute repository files. Return only the requested structured response.',
            'SYSTEM INSTRUCTIONS:',
            systemPrompt,
            'USER INPUT:',
            userPrompt,
        ].join('\n\n');

    private getLogPayload = (model: string, threadOptions: ThreadOptions, outputSchema: unknown) => ({
        model,
        threadOptions,
        outputSchema,
        authentication: this.params.config.key ? 'api-key-configured' : 'codex-cli-session',
    });

    private unwrapCommitResponse = (response: string): string => {
        const parsed = safeJsonParse(this.cleanJsonCodeBlock(response));
        if (!parsed.ok || Array.isArray(parsed.data) || !parsed.data || typeof parsed.data !== 'object') {
            return response;
        }

        const messages = (parsed.data as { messages?: unknown }).messages;
        return Array.isArray(messages) ? JSON.stringify(messages) : response;
    };

    private async generateMessage(requestType: 'commit' | 'review'): Promise<AIResponse[]> {
        const diff = this.params.stagedDiff.diff;
        const { generate, type, logging } = this.params.config;
        const model = getModel(this.params.config.model);
        const systemPrompt = requestType === 'review' ? codeReviewPrompt(this.buildPromptOptions()) : generatePrompt(this.buildPromptOptions());
        const userPrompt = this.buildUserPrompt(diff, requestType);
        const threadOptions = this.createThreadOptions();
        const outputSchema = requestType === 'review' ? REVIEW_OUTPUT_SCHEMA : COMMIT_OUTPUT_SCHEMA;
        const payload = this.getLogPayload(model, threadOptions, outputSchema);
        const url = 'codex-sdk://thread';

        logAIRequest(diff, requestType, 'OpenAI Codex', model, url, { Authorization: 'Codex SDK session/API key configured' }, logging);
        logAIPrompt(diff, requestType, 'OpenAI Codex', systemPrompt, userPrompt, logging);
        logAIPayload(diff, requestType, 'OpenAI Codex', payload, logging);

        const { controller, timeoutId } = this.createTimeoutController();
        const startTime = Date.now();
        try {
            const thread = this.createCodex().startThread(threadOptions);
            const turn = await thread.run(this.buildInput(systemPrompt, userPrompt), this.createTurnOptions(controller.signal, requestType));
            if (!turn.finalResponse.trim()) {
                throw asAIServiceError(new Error('Codex returned no response content'), ErrorCode.NO_CONTENT);
            }

            const duration = Date.now() - startTime;
            logAIResponse(diff, requestType, 'OpenAI Codex', { usage: turn.usage, itemCount: turn.items.length }, logging);
            logAIComplete(diff, requestType, 'OpenAI Codex', duration, turn.finalResponse, logging);

            if (requestType === 'review') {
                return this.parseCodeReview(turn.finalResponse);
            }
            return this.parseMessage(this.unwrapCommitResponse(turn.finalResponse), type, generate);
        } catch (error) {
            const aiError = this.normalizeError(error, controller.signal.aborted);
            logAIError(diff, requestType, 'OpenAI Codex', aiError, logging);
            throw aiError;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private streamCommit = async (subject: Subject<string>, signal: AbortSignal): Promise<void> => {
        const diff = this.params.stagedDiff.diff;
        const { logging } = this.params.config;
        const model = getModel(this.params.config.model);
        const systemPrompt = generatePrompt(this.buildPromptOptions());
        const userPrompt = this.buildUserPrompt(diff, 'commit');
        const threadOptions = this.createThreadOptions();
        const payload = this.getLogPayload(model, threadOptions, COMMIT_OUTPUT_SCHEMA);
        const url = 'codex-sdk://thread';
        const startTime = Date.now();
        let latestMessage = '';
        let usage: unknown = null;

        logAIRequest(diff, 'commit', 'OpenAI Codex', model, url, { Authorization: 'Codex SDK session/API key configured' }, logging);
        logAIPrompt(diff, 'commit', 'OpenAI Codex', systemPrompt, userPrompt, logging);
        logAIPayload(diff, 'commit', 'OpenAI Codex', payload, logging);

        const { controller, timeoutId } = this.createTimeoutController();
        const relaySignal = signal;
        const abortFromCaller = () => controller.abort();
        relaySignal.addEventListener('abort', abortFromCaller, { once: true });

        try {
            const thread = this.createCodex().startThread(threadOptions);
            const streamed = await thread.runStreamed(this.buildInput(systemPrompt, userPrompt), this.createTurnOptions(controller.signal, 'commit'));

            for await (const event of streamed.events) {
                if (event.type === 'turn.completed') {
                    usage = event.usage;
                } else if (event.type === 'turn.failed') {
                    throw new Error(event.error.message);
                } else if (event.type === 'error') {
                    throw new Error(event.message);
                } else if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
                    const delta = this.getAgentMessageDelta(event, latestMessage);
                    if (delta) {
                        latestMessage += delta;
                        subject.next(delta);
                    }
                }
            }

            if (!latestMessage.trim()) {
                throw asAIServiceError(new Error('Codex returned no response content'), ErrorCode.NO_CONTENT);
            }

            const duration = Date.now() - startTime;
            logAIResponse(diff, 'commit', 'OpenAI Codex', { streamed: true, usage, totalLength: latestMessage.length }, logging);
            logAIComplete(diff, 'commit', 'OpenAI Codex', duration, latestMessage, logging);
            subject.complete();
        } catch (error) {
            const aiError = this.normalizeError(error, controller.signal.aborted);
            logAIError(diff, 'commit', 'OpenAI Codex', aiError, logging);
            subject.error(aiError);
        } finally {
            relaySignal.removeEventListener('abort', abortFromCaller);
            clearTimeout(timeoutId);
        }
    };

    private getAgentMessageDelta = (event: Extract<ThreadEvent, { type: 'item.started' | 'item.updated' | 'item.completed' }>, previous: string): string => {
        const item: ThreadItem = event.item;
        if (item.type !== 'agent_message') {
            return '';
        }

        const text = item.text || '';
        if (!text || text === previous) {
            return '';
        }
        if (text.startsWith(previous)) {
            return text.slice(previous.length);
        }
        if (previous.startsWith(text)) {
            return '';
        }
        return text;
    };

    private normalizeError = (error: unknown, aborted: boolean): AIServiceError => {
        const message = getErrorMessage(error);
        if (aborted || /abort|timed out|timeout/i.test(message)) {
            return asAIServiceError(new Error(`Codex request timed out after ${this.params.config.timeout}ms`), ErrorCode.TIMEOUT);
        }
        if (/\bEROFS\b|read-only file system|failed to initialize.*app-server/i.test(message)) {
            return asAIServiceError(error);
        }
        if (/\bENOENT\b|spawn(?:Sync)? .*ENOENT|codex (?:binary|executable).*(?:missing|not found)/i.test(message)) {
            return asAIServiceError(error, ErrorCode.CLI_NOT_INSTALLED);
        }
        if (/401|unauthori[sz]ed|authentication|api key|token/i.test(message)) {
            return asAIServiceError(error, ErrorCode.AUTH_FAILED);
        }
        if (/model.*(not found|unavailable)|access denied|forbidden/i.test(message)) {
            return asAIServiceError(error, ErrorCode.MODEL_NOT_FOUND);
        }
        return asAIServiceError(error);
    };
}
