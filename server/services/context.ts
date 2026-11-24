import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentName } from '../../shared/types';

/**
 * The task a piece of code is running on behalf of, if any.
 *
 * Everything a worker does happens inside one of these scopes. That gives three things for free:
 * activity lines are linked to their task, appended records carry the task id, and code that
 * only the orchestrator or a person may run can refuse to run from inside a worker.
 */
export interface TaskScope {
  task_id: string;
  run_id: string;
  agent: AgentName;
}

export const taskScope = new AsyncLocalStorage<TaskScope>();

export function currentTask(): TaskScope | null {
  return taskScope.getStore() ?? null;
}
