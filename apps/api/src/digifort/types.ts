/** Camera observations are independent from server reachability. */
export interface NormalizedCamera {
  /** Stable only within serverId; preserve leading zeros. */
  id: string;
  name: string;
  ip: string;
  serverId: string;
  /** Inventory assignment supplied externally, never inferred from the IP. */
  nodeId: string | null;
  active: boolean;
  working: boolean;
}

export interface CameraContext {
  serverId: string;
  nodeId: string | null;
}

export type CameraParser = (xml: string, context: CameraContext) => NormalizedCamera[];
