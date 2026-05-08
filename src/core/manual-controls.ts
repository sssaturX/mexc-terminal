import process from "node:process";
import { DirectionMode, Signal } from "../types";
import { color } from "./format";
import { Logger } from "./logger";

export class ManualControls {
  private pendingSignal?: Signal;
  private initialized = false;
  private readonly onData = (buffer: Buffer): void => {
    const key = buffer.toString("utf8").toLowerCase();
    if (key === "\u0003" || key === "q") {
      this.stop();
      return;
    }
    if (key === "l") {
      this.pendingSignal = { action: "BUY", reason: "Manual hotkey L" };
      this.logger.info(`${color.green("MANUAL")} queued OPEN LONG`);
      return;
    }
    if (key === "s") {
      this.pendingSignal = { action: "SELL", reason: "Manual hotkey S" };
      this.logger.info(`${color.red("MANUAL")} queued OPEN SHORT`);
      return;
    }
    if (key === "c") {
      this.pendingSignal = { action: "CLOSE", reason: "Manual hotkey C" };
      this.logger.info(`${color.yellow("MANUAL")} queued CLOSE POSITION`);
    }
  };

  constructor(
    private readonly logger: Logger,
    private readonly stop: () => void
  ) {}

  queue(action: "BUY" | "SELL" | "CLOSE", reason: string): void {
    this.pendingSignal = { action, reason };
    if (action === "BUY") {
      this.logger.info(`${color.green("MANUAL")} queued OPEN LONG`);
    } else if (action === "SELL") {
      this.logger.info(`${color.red("MANUAL")} queued OPEN SHORT`);
    } else {
      this.logger.info(`${color.yellow("MANUAL")} queued CLOSE POSITION`);
    }
  }

  start(): void {
    if (this.initialized || !process.stdin.isTTY) {
      return;
    }

    this.initialized = true;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", this.onData);
    this.logger.info(
      `${color.bold("Manual controls")}: ${color.green("L")} long | ${color.red("S")} short | ${color.yellow(
        "C"
      )} close | ${color.yellow("Q")} stop`
    );
  }

  consume(directionMode: DirectionMode): Signal | undefined {
    const signal = this.pendingSignal;
    this.pendingSignal = undefined;
    if (!signal) {
      return undefined;
    }

    if (signal.action === "BUY" && directionMode === "short") {
      return { action: "HOLD", reason: "Manual long blocked by direction mode=short" };
    }
    if (signal.action === "SELL" && directionMode === "long") {
      return { action: "HOLD", reason: "Manual short blocked by direction mode=long" };
    }

    return signal;
  }

  dispose(): void {
    if (!this.initialized || !process.stdin.isTTY) {
      return;
    }
    process.stdin.off("data", this.onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    this.initialized = false;
  }
}
