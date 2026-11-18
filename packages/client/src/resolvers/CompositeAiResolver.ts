export type AiResolutionSource = 'symbolic' | 'composite' | 'symbolic-fallback';

export interface AiResolutionResult<TOutput> {
    output: TOutput;
    source: AiResolutionSource;
}

export interface IAiResolver<TInput, TOutput, TContext = void> {
    readonly id: string;
    readonly kind: 'symbolic' | 'genai' | 'composite';
    resolve(input: TInput, context: TContext): Promise<TOutput>;
}

export interface CompositeAiResolverConfig<TInput, TOutput, TContext = void> {
    id?: string;
    symbolicResolve: (input: TInput, context: TContext) => TOutput | Promise<TOutput>;
    shouldEscalate: (symbolicOutput: TOutput, input: TInput, context: TContext) => boolean;
    genAiResolve?: (
        input: TInput,
        symbolicOutput: TOutput,
        context: TContext
    ) => Promise<TOutput | null>;
    onGenAiError?: (
        err: unknown,
        symbolicOutput: TOutput,
        input: TInput,
        context: TContext
    ) => TOutput;
}

export class CompositeAiResolver<TInput, TOutput, TContext = void>
    implements IAiResolver<TInput, TOutput, TContext>
{
    readonly id: string;
    readonly kind = 'composite' as const;

    constructor(private readonly config: CompositeAiResolverConfig<TInput, TOutput, TContext>) {
        this.id = config.id || 'composite-ai-resolver';
    }

    async resolveWithMetadata(
        input: TInput,
        context: TContext
    ): Promise<AiResolutionResult<TOutput>> {
        const symbolicOutput = await this.config.symbolicResolve(input, context);

        if (
            !this.config.genAiResolve ||
            !this.config.shouldEscalate(symbolicOutput, input, context)
        ) {
            return { output: symbolicOutput, source: 'symbolic' };
        }

        try {
            const genAiOutput = await this.config.genAiResolve(input, symbolicOutput, context);
            if (genAiOutput !== null && genAiOutput !== undefined) {
                return { output: genAiOutput, source: 'composite' };
            }
            return { output: symbolicOutput, source: 'symbolic-fallback' };
        } catch (err) {
            if (this.config.onGenAiError) {
                return {
                    output: this.config.onGenAiError(err, symbolicOutput, input, context),
                    source: 'symbolic-fallback',
                };
            }
            throw err;
        }
    }

    async resolve(input: TInput, context: TContext): Promise<TOutput> {
        const { output } = await this.resolveWithMetadata(input, context);
        return output;
    }
}

export function createCompositeAiResolver<TInput, TOutput, TContext = void>(
    config: CompositeAiResolverConfig<TInput, TOutput, TContext>
): CompositeAiResolver<TInput, TOutput, TContext> {
    return new CompositeAiResolver<TInput, TOutput, TContext>(config);
}
