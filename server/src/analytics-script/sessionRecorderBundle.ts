import { record } from "@rrweb/record";
import { SessionRecorder } from "./sessionRecorder.js";
import { sendRecordingBatch } from "./recordingTransport.js";

window.rrweb = { record };
window.rybbitModules ??= {};
window.rybbitModules.recording = {
  create: (config, userId, runtime) =>
    new SessionRecorder(
      config,
      userId,
      (batch, exit) => sendRecordingBatch(config, runtime, batch, exit),
      runtime.capture
    ),
};
