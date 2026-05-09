import fs from "node:fs";
import path from "node:path";
import { LogLevel } from "../types";
import { color, stripAnsi } from "./format";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40
};

export class Logger {
  private readonly logPath: string;
  private readonly minLevel: LogLevel;
  private readonly prefix?: string;
  private readonly listeners = new Set<(entry: { level: LogLevel; message: string; timestamp: string }) => void>();

  constructor(options?: { logPath?: string; minLevel?: LogLevel; prefix?: string }) {
    this.logPath = options?.logPath ?? path.join(process.cwd(), "logs", "trading.log");
    this.minLevel = options?.minLevel ?? "INFO";
    this.prefix = options?.prefix;
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
  }

  debug(message: string, meta?: unknown): void {
    this.write("DEBUG", message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.write("INFO", message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write("WARN", message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write("ERROR", message, meta);
  }

  onLog(listener: (entry: { level: LogLevel; message: string; timestamp: string }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) {
      return;
    }

    const prefixedMessage = this.prefix ? `[${this.prefix}] ${message}` : message;
    const plainText = `[${level}] ${stripAnsi(prefixedMessage)}${meta === undefined ? "" : ` ${this.formatMeta(meta)}`}`;
    const text = `${this.colorLevel(level)} ${prefixedMessage}${meta === undefined ? "" : ` ${this.formatMeta(meta)}`}`;
    if (level === "ERROR") {
      console.error(text);
    } else if (level === "WARN") {
      console.warn(text);
    } else {
      console.log(text);
    }

    const timestamp = new Date().toISOString();
    const fileLine = `${timestamp} ${plainText}\n`;
    fs.appendFileSync(this.logPath, fileLine, "utf8");
    for (const listener of this.listeners) {
      listener({ level, message: plainText, timestamp });
    }
  }

  private colorLevel(level: LogLevel): string {
    const tag = `[${level}]`;
    if (level === "ERROR") {
      return color.red(tag);
    }
    if (level === "WARN") {
      return color.yellow(tag);
    }
    if (level === "DEBUG") {
      return color.gray(tag);
    }
    return color.cyan(tag);
  }

  private formatMeta(meta: unknown): string {
    if (meta instanceof Error) {
      return JSON.stringify({
        name: meta.name,
        message: meta.message,
        stack: meta.stack
      });
    }

    try {
      return JSON.stringify(meta);
    } catch {
      return String(meta);
    }
  }
}
