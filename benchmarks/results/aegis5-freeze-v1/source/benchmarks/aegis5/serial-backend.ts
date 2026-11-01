import {DockerBackend,type RunRequest,type RunResult} from '../../packages/execution/index.ts';
/** Equal aggregate candidate concurrency for both arms: one container invocation at a time. */
export class SerialDockerBackend extends DockerBackend {
  private queue:Promise<unknown>=Promise.resolve();
  override run(req:RunRequest):Promise<RunResult>{
    const pending=this.queue.then(()=>super.run(req));this.queue=pending.catch(()=>{});return pending;
  }
}
