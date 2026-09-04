import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export class EventStore {
  constructor(filePath) { this.filePath = filePath; }

  async append(event) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const record = { schemaVersion: 1, recordedAt: new Date().toISOString(), ...event };
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    return record;
  }

  async all() {
    try {
      const body = await readFile(this.filePath, "utf8");
      return body.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async findOrder(orderId) {
    const events = await this.all();
    return events.filter((event) => event.type === "order_created" && event.orderId === orderId).at(-1) ?? null;
  }

  async hasCapturedOrder(orderId) {
    if (!orderId) return false;
    return (await this.all()).some((event) => event.type === "payment_captured" && event.orderId === orderId);
  }

  async hasEvent(providerEventId) {
    if (!providerEventId) return false;
    return (await this.all()).some((event) => event.providerEventId === providerEventId);
  }

  async confirmedMealCount(minimumCents) {
    const orderIds = new Set();
    for (const event of await this.all()) {
      if (event.type === "payment_captured" && event.amountCents >= minimumCents && event.orderId) orderIds.add(event.orderId);
    }
    return orderIds.size;
  }
}
