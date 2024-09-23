import { GAUGE_CODERS } from "@quarryprotocol/gauge";
import { QUARRY_CODERS } from "@quarryprotocol/quarry-sdk";

export const parsers = {
  ...GAUGE_CODERS.Gauge.accountParsers,
  ...QUARRY_CODERS.Registry.accountParsers,
  ...QUARRY_CODERS.Mine.accountParsers,
};