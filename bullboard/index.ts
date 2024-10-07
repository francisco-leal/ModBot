import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import express from "express";
import { sweepQueue, webhookQueue } from "~/lib/bullish.server";

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/ui");

createBullBoard({
  queues: [new BullMQAdapter(sweepQueue), new BullMQAdapter(webhookQueue)],
  serverAdapter: serverAdapter,
});

const app = express();

app.use("/ui", serverAdapter.getRouter());
app.listen(8888, () => {
  console.log("Bullboard started on port 8888");
});
