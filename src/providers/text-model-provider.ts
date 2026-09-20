import {
  callCloseoutModel,
  type CloseoutModelConfig,
  type CloseoutModelResult,
} from '../interview/llm-provider.js';

export interface TextModelProvider {
  complete(
    prompt: { system: string; user: string },
    config: CloseoutModelConfig,
  ): Promise<CloseoutModelResult>;
}

/** OpenAI-compatible structured-output transport. The endpoint may be cloud HTTPS or a loopback local runtime. */
export class OpenAICompatibleTextModelProvider implements TextModelProvider {
  complete(prompt: { system: string; user: string }, config: CloseoutModelConfig): Promise<CloseoutModelResult> {
    return callCloseoutModel(prompt, config);
  }
}

/** Backwards-compatible name retained while call sites migrate to the generic provider terminology. */
export class DirectTextModelProvider extends OpenAICompatibleTextModelProvider {}
