import { BreakoutStrategy } from "./breakout";

export class TrailingBreakout extends BreakoutStrategy {
  override readonly name = "TrailingBreakout";
  override readonly description = "Breakout entry intended to be managed by trailing take profit.";
}
