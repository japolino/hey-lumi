/** Router: one Jev request per utterance decides intent, action and arguments (spec/SPEC.md "Router"). */
import type { ArgKind, DomPickRequest, DomPickResult, EntityOption, RouteRequest, RouteResult } from "../../shared/protocol";
import type { Services } from "../services/types";
import { pickControl } from "./dom";
import { route } from "./route";

export { stripDictationPrefix, THRESHOLDS } from "./route";
export { DOM_THRESHOLD } from "./dom";

/** RouteRequest with every entity list filled (the backend adds characters, personas, presets). */
export type FullRouteRequest = RouteRequest & { entities: Partial<Record<ArgKind, EntityOption[]>> };

export function routeUtterance(req: FullRouteRequest, services: Services): Promise<RouteResult> {
  return route(req, services);
}

export function pickDomControl(req: DomPickRequest, services: Services): Promise<DomPickResult> {
  return pickControl(req, services);
}
