import { HeatmapCollector } from "./heatmapCollector.js";

window.rybbitModules ??= {};
window.rybbitModules.heatmaps = {
  create: (config, userId, runtime) => new HeatmapCollector(config, userId, undefined, runtime),
};
