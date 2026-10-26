import { createSignalingServer } from "./signaling-server";

const allowedOrigins = process.env.CLIENT_ORIGIN?.split(",").map(value => value.trim()).filter(Boolean);
if (process.env.NODE_ENV === "production" && !allowedOrigins?.length) {
  throw new Error("Set CLIENT_ORIGIN to your frontend origin before starting production signaling.");
}
const { httpServer } = createSignalingServer({ allowedOrigins: allowedOrigins?.length ? allowedOrigins : undefined });
httpServer.listen(Number(process.env.PORT ?? process.env.SIGNAL_PORT ?? 3001), () => console.log("swooshit signaling service started"));
