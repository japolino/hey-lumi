/**
 * Router: one Jev request per utterance decides intent, action and arguments (spec/SPEC.md "Router").
 * Owner: router worker. Contract only in this file until the implementation lands.
 */
import type { ArgKind, DomPickRequest, DomPickResult, EntityOption, RouteRequest, RouteResult } from "../../shared/protocol";
import type { Services } from "../services/types";

/** RouteRequest with every entity list filled (the backend adds characters, personas, presets). */
export type FullRouteRequest = RouteRequest & { entities: Partial<Record<ArgKind, EntityOption[]>> };

export async function routeUtterance(_req: FullRouteRequest, _services: Services): Promise<RouteResult> {
  throw new Error("NOT_IMPLEMENTED: routeUtterance");
}

export async function pickDomControl(_req: DomPickRequest, _services: Services): Promise<DomPickResult> {
  throw new Error("NOT_IMPLEMENTED: pickDomControl");
}
