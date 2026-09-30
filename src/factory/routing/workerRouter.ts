import type { RouteInput, RouteDecision } from './decisionModel';

/**
 * WorkerRouter seam (spec §31). Maps a Task's route shape (and the routing
 * decision it produced, when available) onto a Worker profile/capacity. v0.1
 * ships the interface only; the E3 scheduler's demand-driven provisioning is
 * the concrete path today.
 */
export interface WorkerRoute {
  profile: string;
}

export interface WorkerRouter {
  route(input: RouteInput, decision?: RouteDecision): WorkerRoute;
}
