import { HEATMAP_MAX_SNAPSHOT_BYTES, type HeatmapSnapshotNode } from "./heatmaps";

const OMIT_TAGS = new Set(["script", "noscript", "iframe", "frame", "frameset", "object", "embed", "base", "meta"]);
const STRING_FIELDS = ["textContent", "name", "publicId", "systemId", "compatMode"] as const;
const BOOLEAN_FIELDS = ["isSVG", "isShadow", "isShadowHost", "isStyle"] as const;

/** Accept a bounded rrweb document tree containing only inert page content. */
export function sanitizeHeatmapSnapshot(input: unknown): HeatmapSnapshotNode {
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > HEATMAP_MAX_SNAPSHOT_BYTES) {
    throw new Error("Snapshot exceeds size limit");
  }
  let count = 0;
  function visit(value: unknown, depth: number): HeatmapSnapshotNode | null {
    if (++count > 50_000 || depth > 200) throw new Error("Snapshot tree exceeds limits");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid snapshot node");
    const raw = value as Record<string, unknown>;
    if (!Number.isInteger(raw.type) || Number(raw.type) < 0 || Number(raw.type) > 5 || !Number.isSafeInteger(raw.id)) {
      throw new Error("Invalid snapshot node type or ID");
    }
    const node: HeatmapSnapshotNode = { type: Number(raw.type), id: Number(raw.id) };
    if (node.type === 2) {
      if (typeof raw.tagName !== "string" || !/^[a-zA-Z][\w:-]*$/.test(raw.tagName))
        throw new Error("Invalid snapshot tag");
      node.tagName = raw.tagName.toLowerCase();
      if (OMIT_TAGS.has(node.tagName)) return null;
      if (!raw.attributes || typeof raw.attributes !== "object" || Array.isArray(raw.attributes)) {
        throw new Error("Invalid snapshot attributes");
      }
      node.attributes = Object.create(null) as HeatmapSnapshotNode["attributes"];
      for (const [name, attribute] of Object.entries(raw.attributes)) {
        if (/^on/i.test(name) || /^(srcdoc|nonce|integrity|autofocus|autoplay|rr_mediaState)$/i.test(name)) continue;
        if (attribute !== null && !["string", "number", "boolean"].includes(typeof attribute))
          throw new Error("Invalid snapshot attribute");
        if (typeof attribute === "number" && !Number.isFinite(attribute)) throw new Error("Invalid attribute number");
        if (
          typeof attribute === "string" &&
          /^(href|src|xlink:href|action|formaction)$/i.test(name) &&
          !/^(https?:\/\/|data:image\/|#)/i.test(attribute)
        )
          continue;
        node.attributes![name] = attribute as string | number | boolean | null;
      }
    }
    for (const field of STRING_FIELDS) {
      if (raw[field] !== undefined) {
        if (typeof raw[field] !== "string") throw new Error("Invalid snapshot text");
        node[field] = raw[field];
      }
    }
    for (const field of BOOLEAN_FIELDS) {
      if (raw[field] !== undefined) {
        if (typeof raw[field] !== "boolean") throw new Error("Invalid snapshot flag");
        node[field] = raw[field];
      }
    }
    if (node.type === 0 || node.type === 2) {
      if (!Array.isArray(raw.childNodes)) throw new Error("Invalid snapshot children");
      node.childNodes = raw.childNodes.map(child => visit(child, depth + 1)).filter(child => child !== null);
    }
    return node;
  }
  const root = visit(input, 0);
  if (!root || root.type !== 0) throw new Error("Snapshot must contain a document");
  return root;
}
