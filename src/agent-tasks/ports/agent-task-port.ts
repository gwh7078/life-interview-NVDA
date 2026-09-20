import type {
  AgentTaskRequestUnion,
  AgentTaskResultUnion,
} from '../contracts/index.js';

export interface AgentTaskPort {
  run(request: AgentTaskRequestUnion): Promise<AgentTaskResultUnion>;
}
